// CodeShelf – toolbar popup: browse, copy and export saved solutions, and
// sign in to back them up to the CodeShelf cloud.
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const listEl = $('list');
  const searchEl = $('search');
  const form = $('cloud-form');
  let solutions = [];
  let session = null; // { userId, email, ... } from storage
  let lastError = null;

  async function load() {
    const all = await chrome.storage.local.get(null);
    solutions = Object.entries(all)
      .filter(([key]) => key.startsWith('solution:'))
      .map(([, value]) => value)
      .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
    session = all['auth:session'] || null;
    lastError = all['cloud:lastError'] || null;
    if (all['auth:lastError'] && !session) {
      form.hidden = false;
      showError(`Google sign-in failed: ${all['auth:lastError']}`);
      chrome.storage.local.remove('auth:lastError');
    }
    renderCloud();
    renderList();
  }

  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function formatDate(iso) {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '';
  }

  function showError(message, notice = false) {
    $('cloud-error').textContent = message || '';
    $('cloud-error').classList.toggle('notice', notice);
    $('cloud-error').hidden = !message;
  }

  const isMine = (s) => !!session && s.ownerId === session.userId;
  const isSynced = (s) => isMine(s) && !!s.syncedAt;

  // --- cloud panel -----------------------------------------------------------------

  function renderCloud() {
    const mine = solutions.filter((s) => !s.ownerId || isMine(s));
    const synced = mine.filter(isSynced).length;
    $('cloud-dot').classList.toggle('on', !!session && !lastError);
    $('cloud-label').textContent = session
      ? `${session.email || 'Signed in'} · ${synced}/${mine.length} backed up`
      : 'Not signed in · solutions are saved on this browser only';
    $('cloud-sync').hidden = !session;
    $('cloud-account').hidden = !session;
    $('cloud-toggle').textContent = session ? 'Sign out' : form.hidden ? 'Sign in' : 'Cancel';
    if (session) form.hidden = true;
    if (session && lastError) showError(`Last backup failed: ${lastError}`);
  }

  async function send(message) {
    const res = await chrome.runtime.sendMessage(message);
    if (!res || res.status === 'error') throw new Error((res && res.error) || 'No response from CodeShelf');
    return res;
  }

  $('cloud-toggle').addEventListener('click', async () => {
    showError('');
    if (session) {
      await send({ type: 'AUTH_SIGN_OUT' }).catch((err) => showError(err.message));
      return load();
    }
    form.hidden = !form.hidden;
    renderCloud();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    const type = (event.submitter && event.submitter.value) || 'AUTH_SIGN_IN';
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      const data = Object.fromEntries(new FormData(form));
      const res = await send({ type, email: data.email, password: data.password });
      if (res.status === 'confirm-email') {
        showError('Account created. Check your email to confirm it, then sign in.', true);
      } else {
        form.reset();
        if (res.sync && res.sync.status === 'queued') showError(`Signed in, but backup failed: ${res.sync.error}`);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      form.elements.password.value = '';
      buttons.forEach((b) => (b.disabled = false));
      load();
    }
  });

  // The popup usually closes while Google's window is open; sign-in finishes in the
  // background and the popup shows the account next time it's opened.
  $('google').addEventListener('click', async () => {
    showError('');
    const button = $('google');
    button.disabled = true;
    try {
      const res = await send({ type: 'AUTH_GOOGLE' });
      if (res.sync && res.sync.status === 'queued') showError(`Signed in, but backup failed: ${res.sync.error}`);
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
      load();
    }
  });

  $('cloud-sync').addEventListener('click', async () => {
    showError('');
    const button = $('cloud-sync');
    button.disabled = true;
    button.textContent = 'Syncing…';
    try {
      const res = await send({ type: 'CLOUD_SYNC' });
      if (res.status === 'queued') showError(`Sync failed: ${res.error}`);
      else {
        const notes = [];
        if (res.restored) notes.push(`restored ${res.restored} from your account`);
        if (res.reuploaded) notes.push(`re-uploaded ${res.reuploaded} missing from the cloud`);
        showError(notes.length ? `Synced: ${notes.join(', ')}.` : 'Everything is backed up.', true);
      }
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Sync now';
      load();
    }
  });

  $('cloud-delete').addEventListener('click', async (event) => {
    event.preventDefault();
    if (!confirm('Delete all your solutions from the CodeShelf cloud and sign out? Copies on this browser are kept.')) return;
    showError('');
    try {
      await send({ type: 'CLOUD_DELETE' });
      showError('Your cloud data was deleted and you were signed out.', true);
    } catch (err) {
      showError(err.message);
    }
    load();
  });

  // --- solution list ---------------------------------------------------------------

  function renderList() {
    const q = searchEl.value.trim().toLowerCase();
    const shown = q
      ? solutions.filter((s) =>
          [s.title, s.slug, s.languageName, s.language].some((v) => String(v || '').toLowerCase().includes(q)),
        )
      : solutions;

    $('count').textContent = `${solutions.length} saved`;
    $('empty').hidden = solutions.length > 0;
    listEl.replaceChildren(
      ...shown.map((s) => {
        const copyBtn = el('button', { type: 'button', textContent: 'Copy code' });
        copyBtn.addEventListener('click', async () => {
          await navigator.clipboard.writeText(s.code);
          copyBtn.textContent = 'Copied';
          setTimeout(() => (copyBtn.textContent = 'Copy code'), 1200);
        });
        const stats = [s.runtime, s.memory].filter(Boolean).join(' · ');
        const badge = isSynced(s) ? 'backed up' : s.ownerId && !isMine(s) ? 'other account' : 'local only';
        return el('li', {}, [
          el('details', {}, [
            el('summary', {}, [
              el('div', { className: 'title' }, [
                `${s.questionId ? `${s.questionId}. ` : ''}${s.title}`,
                el('span', { className: `badge${isSynced(s) ? ' synced' : ''}`, textContent: badge }),
              ]),
              el('div', { className: 'meta' }, [
                el('span', { className: 'lang', textContent: s.languageName || s.language }),
                `${stats ? ` · ${stats}` : ''} · ${formatDate(s.submittedAt || s.savedAt)}`,
              ]),
            ]),
            el('div', { className: 'body' }, [
              el('pre', { textContent: s.code }),
              el('div', { className: 'actions' }, [
                copyBtn,
                el('a', {
                  href: `https://leetcode.com/problems/${s.slug}/submissions/${s.submissionId}/`,
                  target: '_blank',
                  rel: 'noopener',
                  textContent: 'Open on LeetCode ↗',
                }),
              ]),
            ]),
          ]),
        ]);
      }),
    );
  }

  $('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(solutions, null, 2)], { type: 'application/json' });
    const a = el('a', {
      href: URL.createObjectURL(blob),
      download: `codeshelf-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  searchEl.addEventListener('input', renderList);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && Object.keys(changes).some((k) => k.startsWith('solution:') || k.startsWith('cloud:') || k.startsWith('auth:'))) load();
  });
  load();
})();
