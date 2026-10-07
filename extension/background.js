// CodeShelf – background service worker.
//
// Receives Accepted submissions from content.js, de-duplicates them, keeps the
// full solution in the extension's own storage (independent of LeetCode's site
// data), and, when the user is signed in, syncs it to the shared CodeShelf
// Supabase project. Row Level Security there keeps every user's rows private.
//
// Supabase is reached with plain fetch calls (Auth + PostgREST), so moving to
// another backend later only means rewriting the "Supabase" section below.

const CONFIG = {
  SUPABASE_URL: 'https://qgvnwztoiitphhdfroxd.supabase.co',
  // Publishable key: designed to ship in client apps. Never put the secret/service_role key here.
  SUPABASE_KEY: 'sb_publishable_ZouXqC2Fc91A9n4yqRRv6g_ZGeH80xP',
  // true: skip a new Accepted submission whose code is identical (same problem +
  // language + code) to one already saved. false: save every Accepted submission once.
  SKIP_IDENTICAL_CODE: true,
  UPLOAD_BATCH_SIZE: 50,
  MAX_CODE_LENGTH: 100000, // matches the solutions_size_limits check in supabase/multi-user.sql
};

// solution:<submissionId> -> full record + savedAt, plus ownerId/syncedAt once synced.
// ownerId is the account the solution belongs to; solutions saved while signed out
// have none and are claimed by the first account that syncs on this browser.
const SOLUTION_PREFIX = 'solution:';
const KEYS = {
  hashes: 'library:hashes', // codeHash -> submissionId
  session: 'auth:session', // { accessToken, refreshToken, expiresAt, userId, email } – never the password
  authError: 'auth:lastError', // shown by the popup, which is closed while Google's window is open
  lastError: 'cloud:lastError',
};
const solutionKey = (id) => `${SOLUTION_PREFIX}${id}`;
const errorText = (err) => String((err && err.message) || err);

// One task at a time: avoids double uploads and concurrent token refreshes.
let chain = Promise.resolve();
function serialized(task) {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;
  const fromLeetCode = !!sender.tab && typeof sender.url === 'string' && sender.url.startsWith('https://leetcode.com/');
  const fromPopup =
    sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  const reply = (promise) =>
    promise.then(sendResponse, (err) => sendResponse({ status: 'error', error: errorText(err) }));

  if (fromLeetCode && message.type === 'CODESHELF_ACCEPTED') {
    reply(serialized(() => saveSubmission(message.payload)));
    serialized(syncAll); // flush anything an earlier failure left behind
    return true; // keep the channel open for the async response
  }
  if (fromLeetCode && message.type === 'CODESHELF_STATUS') {
    reply(statusOf(String(message.submissionId)));
    return true;
  }
  if (fromPopup) {
    const actions = {
      AUTH_SIGN_IN: () => signIn(message),
      AUTH_SIGN_UP: () => signUp(message),
      AUTH_GOOGLE: () => rememberAuthError(signInWithGoogle),
      AUTH_SIGN_OUT: signOut,
      CLOUD_SYNC: fullSync,
      CLOUD_DELETE: deleteCloudData,
    };
    if (actions[message.type]) {
      reply(serialized(actions[message.type]));
      return true;
    }
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => serialized(fullSync));

chrome.runtime.onInstalled.addListener(() =>
  serialized(async () => {
    // Drop bookkeeping from earlier versions (0.1.x hashes, 0.2.x dry-run upload tracking).
    await chrome.storage.local.remove(
      ['dryrun', 'live'].flatMap((ns) => [
        `${ns}:savedSubmissions`,
        `${ns}:savedHashes`,
        `${ns}:retryQueue`,
        `${ns}:uploaded`,
        `${ns}:pendingUploads`,
      ]),
    );
    await migrateConnectedProject();
    if (CONFIG.SKIP_IDENTICAL_CODE) await dedupeLibrary();
  }),
);

// 0.3.x stored { url, anonKey, session } per user-supplied project plus an uploaded map.
// Keep that session if it was for the shared project, and mark what it already synced.
async function migrateConnectedProject() {
  const all = await chrome.storage.local.get(null);
  const old = all['cloud:config'];
  if (!old) return;
  await chrome.storage.local.remove(['cloud:config', 'cloud:uploaded']);
  if (old.url !== CONFIG.SUPABASE_URL || !old.session) return;
  try {
    const session = { ...old.session };
    const user = await fetchUser(session);
    session.userId = user.id;
    session.email = user.email;
    const updates = { [KEYS.session]: session };
    for (const [id, at] of Object.entries(all['cloud:uploaded'] || {})) {
      const entry = all[solutionKey(id)];
      if (entry) updates[solutionKey(id)] = { ...entry, ownerId: user.id, syncedAt: at };
    }
    await chrome.storage.local.set(updates);
  } catch (err) {
    console.warn('[CodeShelf] Could not keep the previous sign-in; please sign in again.', err);
  }
}

// Keeps the earliest saved copy of each identical solution and removes later local copies
// (0.3.0 and earlier let a button click force-save identical code).
async function dedupeLibrary() {
  const all = await chrome.storage.local.get(null);
  const groups = new Map();
  for (const [key, entry] of Object.entries(all)) {
    if (!key.startsWith(SOLUTION_PREFIX) || !entry || !entry.codeHash) continue;
    const group = `${entry.ownerId || ''}|${entry.codeHash}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(entry);
  }

  const hashes = {};
  const removed = [];
  for (const entries of groups.values()) {
    entries.sort((a, b) => String(a.savedAt).localeCompare(String(b.savedAt)));
    hashes[entries[0].codeHash] = entries[0].submissionId;
    removed.push(...entries.slice(1).map((e) => e.submissionId));
  }
  await chrome.storage.local.remove(removed.map(solutionKey));
  await chrome.storage.local.set({ [KEYS.hashes]: hashes });
  if (removed.length) console.log('[CodeShelf] Removed duplicate local copies:', removed);
}

// --- local library -------------------------------------------------------------

async function saveSubmission(payload) {
  const record = await buildRecord(payload);
  return persist(record);
}

async function buildRecord(p) {
  const str = (v) => (typeof v === 'string' && v.length ? v : null);
  if (!p || !/^\d+$/.test(p.submissionId || '') || !str(p.slug) || !str(p.lang) || !str(p.code)) {
    throw new Error('Invalid submission payload');
  }

  const normalizedCode = p.code.replace(/\r\n/g, '\n').trim();
  return {
    submissionId: p.submissionId,
    title: str(p.title) || p.slug,
    slug: p.slug,
    url: `https://leetcode.com/problems/${p.slug}/`,
    questionId: str(p.questionId),
    language: p.lang, // LeetCode's language slug, e.g. "python3"
    languageName: str(p.languageName) || p.lang, // display name, e.g. "Python3"
    code: p.code,
    runtime: str(p.runtime),
    memory: str(p.memory),
    runtimePercentile: typeof p.runtimePercentile === 'number' ? p.runtimePercentile : null,
    memoryPercentile: typeof p.memoryPercentile === 'number' ? p.memoryPercentile : null,
    submittedAt: str(p.submittedAt),
    judgedAt: str(p.judgedAt), // LeetCode's task_finish_time, if provided
    codeHash: await sha256(`${p.slug}\u0000${p.lang}\u0000${normalizedCode}`),
    source: 'leetcode.com',
  };
}

async function persist(record) {
  const id = record.submissionId;
  const key = solutionKey(id);
  const store = await chrome.storage.local.get([key, KEYS.hashes, KEYS.session]);
  const hashes = store[KEYS.hashes] || {};
  const me = store[KEYS.session] && store[KEYS.session].userId;

  // Keep it locally first, so nothing is lost if the upload fails.
  let entry = store[key];
  const alreadySaved = !!entry;
  if (!entry) {
    const twinId = hashes[record.codeHash];
    if (CONFIG.SKIP_IDENTICAL_CODE && twinId && twinId !== id) {
      const { [solutionKey(twinId)]: twin } = await chrome.storage.local.get(solutionKey(twinId));
      // Only counts as a duplicate within the same account (or among signed-out saves).
      if (twin && (!twin.ownerId || !me || twin.ownerId === me)) {
        const reason = `identical code already saved as submission ${twinId}`;
        console.log(`[CodeShelf] Skipped #${id}: ${reason}`);
        return { status: 'duplicate', submissionId: id, reason };
      }
    }
    entry = { ...record, savedAt: new Date().toISOString(), ...(me ? { ownerId: me } : {}) };
    hashes[record.codeHash] = id;
    await chrome.storage.local.set({ [key]: entry, [KEYS.hashes]: hashes });
    console.log(`[CodeShelf] Saved #${id} locally (${record.slug}, ${record.language})`);
  }

  return { submissionId: id, alreadySaved, ...(await syncEntries([entry])) };
}

async function statusOf(id) {
  const store = await chrome.storage.local.get([solutionKey(id), KEYS.session]);
  const entry = store[solutionKey(id)];
  const me = store[KEYS.session] && store[KEYS.session].userId;
  if (!entry) return { status: 'none', submissionId: id };
  if (!me) return { status: 'saved', submissionId: id, cloud: 'off' };
  if (entry.ownerId && entry.ownerId !== me) return { status: 'saved', submissionId: id, cloud: 'other' };
  if (entry.syncedAt) return { status: 'saved', submissionId: id, cloud: 'synced' };
  return { status: 'queued', submissionId: id, cloud: 'pending' };
}

// --- sync ----------------------------------------------------------------------

// Uploads entries that belong to the signed-in user (or to nobody yet) and aren't
// synced. Never throws: failures are reported and retried on the next save, sync
// or browser start.
async function syncEntries(entries) {
  const { [KEYS.session]: session } = await chrome.storage.local.get(KEYS.session);
  if (!session) return { status: 'saved', cloud: 'off' };

  const me = session.userId;
  const todo = entries.filter(
    (e) =>
      !(e.ownerId === me && e.syncedAt) &&
      (!e.ownerId || e.ownerId === me) &&
      e.code.length <= CONFIG.MAX_CODE_LENGTH, // kept locally only; the database would reject it
  );
  if (entries.length === 1 && !todo.length) {
    const only = entries[0];
    return { status: 'saved', cloud: only.ownerId === me ? 'synced' : 'other' };
  }
  try {
    for (let i = 0; i < todo.length; i += CONFIG.UPLOAD_BATCH_SIZE) {
      const batch = todo.slice(i, i + CONFIG.UPLOAD_BATCH_SIZE);
      await insertSolutions(session, batch.map(toRow));
      const syncedAt = new Date().toISOString();
      const updates = { [KEYS.lastError]: null };
      for (const e of batch) updates[solutionKey(e.submissionId)] = { ...e, ownerId: me, syncedAt };
      await chrome.storage.local.set(updates);
      console.log(`[CodeShelf] Synced ${batch.length} solution(s)`);
    }
    return { status: 'saved', cloud: 'synced', synced: todo.length };
  } catch (err) {
    await chrome.storage.local.set({ [KEYS.lastError]: errorText(err) });
    console.warn('[CodeShelf] Sync failed; kept locally, will retry:', err);
    return { status: 'queued', cloud: 'failed', error: errorText(err) };
  }
}

async function syncAll() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([key]) => key.startsWith(SOLUTION_PREFIX))
    .map(([, value]) => value);
  return syncEntries(entries);
}

// Upload what's missing in the cloud, download what's missing on this device, and
// re-upload anything marked as backed up that is no longer in the cloud (e.g. rows
// deleted from the dashboard).
async function fullSync() {
  const pushed = await syncAll();
  if (pushed.cloud !== 'synced') return pushed;
  try {
    const { [KEYS.session]: session } = await chrome.storage.local.get(KEYS.session);
    const { restored, missing } = await pullFromCloud(session);
    if (!missing.length) return { ...pushed, restored, reuploaded: 0 };
    console.log(`[CodeShelf] ${missing.length} solution(s) missing from the cloud; uploading again`);
    const again = await syncEntries(missing);
    return { ...again, restored, reuploaded: again.cloud === 'synced' ? missing.length : 0 };
  } catch (err) {
    await chrome.storage.local.set({ [KEYS.lastError]: errorText(err) });
    return { status: 'queued', cloud: 'failed', error: errorText(err) };
  }
}

// Copies the signed-in user's cloud solutions into the local library (e.g. on a new device).
async function pullFromCloud(session) {
  const rows = await selectAllSolutions(session);
  const all = await chrome.storage.local.get(null);
  const hashes = all[KEYS.hashes] || {};
  const updates = {};
  let restored = 0;
  for (const row of rows) {
    const key = solutionKey(row.submission_id);
    const local = all[key];
    if (!local) {
      updates[key] = fromRow(row, session.userId);
      restored++;
    } else if (!local.syncedAt && (!local.ownerId || local.ownerId === session.userId)) {
      updates[key] = { ...local, ownerId: session.userId, syncedAt: row.created_at || new Date().toISOString() };
    }
    if (!hashes[row.code_hash]) hashes[row.code_hash] = row.submission_id;
  }
  // Marked as backed up here but gone from the cloud: clear the mark so it uploads again.
  const inCloud = new Set(rows.map((r) => String(r.submission_id)));
  const missing = [];
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith(SOLUTION_PREFIX) && entry.ownerId === session.userId && entry.syncedAt && !inCloud.has(entry.submissionId)) {
      updates[key] = { ...entry, syncedAt: null };
      missing.push(updates[key]);
    }
  }

  await chrome.storage.local.set({ ...updates, [KEYS.hashes]: hashes });
  if (restored) console.log(`[CodeShelf] Restored ${restored} solution(s) from the cloud`);
  return { restored, missing };
}

// --- account -------------------------------------------------------------------

function credentials({ email, password }) {
  email = String(email || '').trim();
  password = String(password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  return { email, password };
}

// The popup closes during Google sign-in, so keep the outcome for it to show when reopened.
async function rememberAuthError(task) {
  await chrome.storage.local.remove(KEYS.authError);
  try {
    return await task();
  } catch (err) {
    console.warn('[CodeShelf] Google sign-in failed:', err);
    await chrome.storage.local.set({ [KEYS.authError]: errorText(err) });
    throw err;
  }
}

async function startSession(session) {
  await chrome.storage.local.set({ [KEYS.session]: session, [KEYS.lastError]: null });
  return { status: 'signed-in', email: session.email, sync: await fullSync() };
}

// Google sign-in through Supabase, using Chrome's auth window and PKCE. The redirect
// URL is https://<extension-id>.chromiumapp.org/ and must be allow-listed in Supabase.
async function signInWithGoogle() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url =
    `${CONFIG.SUPABASE_URL}/auth/v1/authorize?` +
    new URLSearchParams({
      provider: 'google',
      redirect_to: chrome.identity.getRedirectURL(),
      code_challenge: challenge,
      code_challenge_method: 's256',
    });

  let redirect;
  try {
    redirect = new URL(await chrome.identity.launchWebAuthFlow({ url, interactive: true }));
  } catch (err) {
    const why = errorText(err);
    if (/did not approve|canceled|cancelled/i.test(why)) throw new Error('Google sign-in was cancelled');
    if (/could not be loaded/i.test(why)) {
      // Google or Supabase returned an error page instead of redirecting back (provider off,
      // redirect URL not allow-listed, or a client ID/secret mismatch).
      throw new Error('the sign-in page could not finish loading. Try again, or use email.');
    }
    throw new Error(why);
  }
  const query = redirect.searchParams;
  const fragment = new URLSearchParams(redirect.hash.slice(1));
  const failure = query.get('error_description') || fragment.get('error_description');
  if (failure) throw new Error(failure.replace(/\+/g, ' '));
  const code = query.get('code');
  if (!code) throw new Error('Google sign-in did not return an authorization code');

  return startSession(await authToken('pkce', { auth_code: code, code_verifier: verifier }));
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signIn(message) {
  return startSession(await authToken('password', credentials(message)));
}

async function signUp(message) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/signup`, {
    method: 'POST',
    headers: { apikey: CONFIG.SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials(message)),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(authErrorText(data, res.status));
  // With "Confirm email" on, Supabase returns the user but no session until they confirm.
  if (!data.access_token) return { status: 'confirm-email' };
  return startSession(toSession(data));
}

async function signOut() {
  const { [KEYS.session]: session } = await chrome.storage.local.get(KEYS.session);
  if (session) {
    // Best effort: revoke the session server-side too.
    fetch(`${CONFIG.SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: CONFIG.SUPABASE_KEY, Authorization: `Bearer ${session.accessToken}` },
    }).catch(() => {});
  }
  await chrome.storage.local.remove([KEYS.session, KEYS.lastError]);
  return { status: 'signed-out' };
}

// Deletes the signed-in user's rows from the cloud, then signs out. Local copies stay;
// signing in again would upload them again.
async function deleteCloudData() {
  const { [KEYS.session]: session } = await chrome.storage.local.get(KEYS.session);
  if (!session) throw new Error('Not signed in');
  const send = (token) =>
    fetch(`${CONFIG.SUPABASE_URL}/rest/v1/solutions?user_id=eq.${encodeURIComponent(session.userId)}`, {
      method: 'DELETE',
      headers: { apikey: CONFIG.SUPABASE_KEY, Authorization: `Bearer ${token}`, Prefer: 'return=minimal' },
    });
  let res = await send(await accessToken(session));
  if (res.status === 401) res = await send(await accessToken(session, true));
  if (!res.ok) throw new Error(`Delete failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);

  const all = await chrome.storage.local.get(null);
  const updates = {};
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith(SOLUTION_PREFIX) && entry.ownerId === session.userId) {
      updates[key] = { ...entry, syncedAt: null };
    }
  }
  await chrome.storage.local.set(updates);
  await signOut();
  return { status: 'deleted' };
}

// --- Supabase (Auth + PostgREST) ------------------------------------------------

function authErrorText(data, status) {
  return data.error_description || data.msg || data.message || `HTTP ${status}`;
}

function toSession(data) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    userId: data.user && data.user.id,
    email: data.user && data.user.email,
  };
}

async function authToken(grantType, body) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: CONFIG.SUPABASE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const why = authErrorText(data, res.status);
    throw new Error(grantType === 'refresh_token' ? `Your session expired (${why}). Please sign in again.` : why);
  }
  return toSession(data);
}

async function fetchUser(session) {
  const res = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: CONFIG.SUPABASE_KEY, Authorization: `Bearer ${await accessToken(session)}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) throw new Error(authErrorText(data, res.status));
  return data;
}

// Returns a valid access token, refreshing (and persisting) the session when needed.
async function accessToken(session, forceRefresh = false) {
  if (!forceRefresh && session.expiresAt - 60000 > Date.now()) return session.accessToken;
  const fresh = await authToken('refresh_token', { refresh_token: session.refreshToken });
  Object.assign(session, fresh, {
    userId: fresh.userId || session.userId,
    email: fresh.email || session.email,
  });
  await chrome.storage.local.set({ [KEYS.session]: session });
  return session.accessToken;
}

async function insertSolutions(session, rows) {
  const send = (token) =>
    fetch(`${CONFIG.SUPABASE_URL}/rest/v1/solutions?on_conflict=user_id,submission_id`, {
      method: 'POST',
      headers: {
        apikey: CONFIG.SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=ignore-duplicates,return=minimal', // already-synced rows are skipped
      },
      body: JSON.stringify(rows),
    });

  let res = await send(await accessToken(session));
  if (res.status === 401) res = await send(await accessToken(session, true));
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Sync failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

// Reads all of the signed-in user's rows (RLS limits the result to them), 1000 at a time.
async function selectAllSolutions(session) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const send = (token) =>
      fetch(`${CONFIG.SUPABASE_URL}/rest/v1/solutions?select=*&order=saved_at.asc,submission_id.asc`, {
        headers: {
          apikey: CONFIG.SUPABASE_KEY,
          Authorization: `Bearer ${token}`,
          Range: `${from}-${from + 999}`,
          'Range-Unit': 'items',
        },
      });
    let res = await send(await accessToken(session));
    if (res.status === 401) res = await send(await accessToken(session, true));
    if (!res.ok) throw new Error(`Restore failed (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

// Maps a cloud row back to a library entry.
function fromRow(r, ownerId) {
  return {
    submissionId: r.submission_id,
    title: r.title,
    slug: r.slug,
    url: r.url,
    questionId: r.question_id,
    language: r.language,
    languageName: r.language_name,
    code: r.code,
    runtime: r.runtime,
    memory: r.memory,
    runtimePercentile: r.runtime_percentile,
    memoryPercentile: r.memory_percentile,
    submittedAt: r.submitted_at,
    judgedAt: r.judged_at,
    codeHash: r.code_hash,
    source: r.source,
    savedAt: r.saved_at || r.created_at,
    ownerId,
    syncedAt: r.created_at || new Date().toISOString(),
  };
}

// Maps a library entry to a row of public.solutions (see supabase/schema.sql).
// user_id is filled in by the database from the access token.
function toRow(e) {
  return {
    submission_id: e.submissionId,
    title: e.title,
    slug: e.slug,
    url: e.url,
    question_id: e.questionId,
    language: e.language,
    language_name: e.languageName,
    code: e.code,
    runtime: e.runtime,
    memory: e.memory,
    runtime_percentile: e.runtimePercentile,
    memory_percentile: e.memoryPercentile,
    submitted_at: e.submittedAt,
    judged_at: e.judgedAt,
    code_hash: e.codeHash,
    source: e.source,
    saved_at: e.savedAt,
  };
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
