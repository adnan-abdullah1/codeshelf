// CodeShelf – isolated-world bridge and in-page button.
//
// injected.js runs in the page's world and cannot use chrome.* APIs, so it
// posts captured submissions here. This script validates them, forwards them
// to the background service worker, and shows a "Save to CodeShelf" button in
// LeetCode's Accepted result panel (floating bottom-right if the panel can't
// be found).
(() => {
  'use strict';

  const BUTTON_ID = 'codeshelf-save-button';
  const RESULT_SELECTOR = '[data-e2e-locator="submission-result"]';
  const FLOAT_MS = 10000; // how long the floating fallback stays after an auto-save
  const GRACE_MS = 3000; // wait this long for data before saying a visible Accepted panel wasn't captured

  const payloads = new Map(); // submissionId -> payload
  const states = new Map(); // submissionId -> { state, detail }
  let lastAccepted = { id: null, at: 0 };
  let panel = { key: null, since: 0 }; // when the current Accepted panel first appeared

  function isValid(p) {
    return (
      p &&
      typeof p.submissionId === 'string' &&
      /^\d+$/.test(p.submissionId) &&
      typeof p.slug === 'string' &&
      /^[a-z0-9-]+$/.test(p.slug) &&
      typeof p.lang === 'string' &&
      typeof p.code === 'string' &&
      p.code.length > 0
    );
  }

  // After the extension is reloaded or updated, scripts left in already-open tabs can no
  // longer reach it ("Extension context invalidated") until the page is refreshed.
  const isStale = (err) => !chrome.runtime || !chrome.runtime.id || /context invalidated/i.test(String(err && err.message));

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  // Signed out (or owned by another account): saved locally but not in this user's cloud.
  const stateFor = (res, fallback) => {
    const status = (res && res.status) || fallback;
    return status === 'saved' && res && (res.cloud === 'off' || res.cloud === 'other') ? 'local' : status;
  };

  function setState(id, state, detail = '') {
    states.set(id, { state, detail });
    schedule();
  }

  // Tooltip text for a background result.
  function describe(res) {
    if (!res) return '';
    if (res.reason || res.error) return res.reason || `Saved locally; backup failed: ${res.error}`;
    if (res.cloud === 'synced') return 'Saved and backed up to your CodeShelf account';
    if (res.cloud === 'off') return 'Saved locally. Sign in from the CodeShelf toolbar icon to back it up to the cloud.';
    if (res.cloud === 'other') return 'Saved locally; it belongs to another CodeShelf account on this browser.';
    if (res.cloud === 'pending') return 'Saved locally; waiting to back up';
    return '';
  }

  async function save(payload) {
    const id = payload.submissionId;
    setState(id, 'saving');
    try {
      const res = await send({ type: 'CODESHELF_ACCEPTED', payload });
      console.log('[CodeShelf] Background result:', res);
      setState(id, stateFor(res, 'error'), describe(res));
    } catch (err) {
      if (isStale(err)) {
        console.warn('[CodeShelf] Extension was reloaded; refresh this page to save this submission.');
        setState(id, 'stale', 'CodeShelf was updated or reloaded. Click to refresh the page; recent Accepted submissions are saved automatically after the refresh.');
        return;
      }
      console.warn('[CodeShelf] Could not reach background:', err);
      setState(id, 'error', String(err.message || err));
    }
  }

  async function loadStatus(id) {
    if (states.has(id)) return;
    setState(id, 'checking');
    try {
      const res = await send({ type: 'CODESHELF_STATUS', submissionId: id });
      if (states.get(id).state === 'checking') {
        setState(id, stateFor(res, 'none'), describe(res));
      }
    } catch {
      setState(id, 'none');
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== 'codeshelf') return;
    if (msg.type === 'DIAG') {
      if (diagResolve) diagResolve(msg.payload);
      return;
    }
    const payload = msg.payload;
    if (!isValid(payload)) return;
    const id = payload.submissionId;

    if (msg.type === 'ACCEPTED_SUBMISSION') {
      payloads.set(id, payload); // exact submitted code wins over details
      lastAccepted = { id, at: Date.now() };
      setTimeout(schedule, FLOAT_MS + 50);
      console.log(`[CodeShelf] Accepted: ${payload.title} (${payload.languageName}) #${id}`, payload);
      save(payload);
    } else if (msg.type === 'SUBMISSION_DETAILS') {
      if (!payloads.has(id)) payloads.set(id, payload);
      loadStatus(id);
      schedule();
    }
  });

  // --- "not captured" diagnostics ---------------------------------------------------
  // Paths and GraphQL operation names only; never request bodies or code.

  let diagResolve = null;
  function collectDiagnostics() {
    const fromHook = new Promise((resolve) => {
      const timer = setTimeout(() => resolve('no reply from page script'), 1000);
      diagResolve = (d) => {
        clearTimeout(timer);
        resolve(d);
      };
      window.postMessage({ source: 'codeshelf-content', type: 'DIAG_REQUEST' }, location.origin);
    });
    return fromHook.then((hook) => {
      let version = '?';
      try {
        version = chrome.runtime.getManifest().version;
      } catch {}
      const browserSaw = performance
        .getEntriesByType('resource')
        .filter((e) => /submi|check|judge|graphql/i.test(e.name))
        .map((e) => {
          const u = new URL(e.name);
          return `${e.initiatorType} ${u.host === location.host ? '' : u.host}${u.pathname}`;
        });
      return { version, page: location.pathname, hook, browserSaw: [...new Set(browserSaw)].slice(-40) };
    });
  }

  let diagLoggedFor = null;
  let copiedUntil = 0;
  async function copyDiagnostics() {
    const text = JSON.stringify(await collectDiagnostics(), null, 2);
    console.warn('[CodeShelf] Diagnostics:\n' + text);
    try {
      await navigator.clipboard.writeText(text);
      copiedUntil = Date.now() + 3000;
      setTimeout(schedule, 3050);
      schedule();
    } catch (err) {
      console.warn('[CodeShelf] Could not copy; copy the Diagnostics log above instead.', err);
    }
  }

  // --- button ------------------------------------------------------------------

  const ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4v15"/><path d="M8 4v15"/>' +
    '<path d="M12 6l3.5 13"/><path d="M17 4v15"/><path d="M2 20h20"/></svg>';

  const LOOKS = {
    none: { label: 'Save to CodeShelf', color: '#2563eb', clickable: true },
    checking: { label: 'CodeShelf…', color: '#4b5563', clickable: false },
    saving: { label: 'Saving…', color: '#4b5563', clickable: false },
    saved: { label: 'Saved & backed up', color: '#059669', clickable: false },
    local: { label: 'Saved on this browser', color: '#0f766e', clickable: false },
    duplicate: { label: 'Same code already saved', color: '#0d9488', clickable: false },
    queued: { label: 'Saved locally · sync pending', color: '#b45309', clickable: true },
    error: { label: 'Save failed – retry', color: '#dc2626', clickable: true },
    stale: { label: 'Reload page to save', color: '#b45309', clickable: true },
    missing: { label: 'CodeShelf: not captured', color: '#4b5563', clickable: true },
    copied: { label: 'Diagnostics copied', color: '#4b5563', clickable: true },
  };

  const BASE_STYLE =
    'display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:0;' +
    'border-radius:8px;font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
    'color:#fff;white-space:nowrap;transition:background-color .15s;';
  const INLINE_STYLE = 'margin-left:8px;';
  const FLOAT_STYLE =
    'position:fixed;right:20px;bottom:20px;z-index:2147483647;box-shadow:0 4px 14px rgba(0,0,0,.35);';

  function createButton() {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.innerHTML = `${ICON}<span></span>`;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.submissionId;
      const payload = payloads.get(id);
      if (!payload) {
        copyDiagnostics();
        return;
      }
      const state = (states.get(id) || {}).state || 'none';
      if (state === 'stale') {
        location.reload();
        return;
      }
      const look = LOOKS[state];
      if (look && look.clickable) save(payload);
    });
    return btn;
  }

  function submissionIdFromUrl() {
    const m = location.pathname.match(/\/submissions\/(\d+)/);
    return m ? m[1] : null;
  }

  // Put the button next to LeetCode's own buttons in the result header (after LeetHub's, if present).
  function inlineTarget(anchor) {
    let node = anchor.parentElement;
    for (let depth = 0; node && node !== document.body && depth < 6; depth++, node = node.parentElement) {
      const buttons = [...node.querySelectorAll('button')].filter((b) => b.id !== BUTTON_ID);
      if (buttons.length) return buttons.find((b) => /leethub/i.test(b.textContent)) || buttons[buttons.length - 1];
    }
    return null;
  }

  function render() {
    scheduled = false;
    if (!document.body) return;

    const anchor = document.querySelector(RESULT_SELECTOR);
    const acceptedPanel = !!anchor && /accepted/i.test(anchor.textContent || '');
    const recent = lastAccepted.id && Date.now() - lastAccepted.at < FLOAT_MS;
    const id = submissionIdFromUrl() || (acceptedPanel || recent ? lastAccepted.id : null);

    let btn = document.getElementById(BUTTON_ID);
    if (!acceptedPanel && !recent) {
      if (btn) btn.remove();
      return;
    }
    if (!btn) btn = createButton();

    const target = acceptedPanel ? inlineTarget(anchor) : null;
    if (target) {
      if (target.nextElementSibling !== btn) target.after(btn);
    } else if (btn.parentElement !== document.body) {
      document.body.appendChild(btn);
    }

    const panelKey = `${location.pathname}|${id}`;
    if (panel.key !== panelKey) {
      panel = { key: panelKey, since: Date.now() };
      setTimeout(schedule, GRACE_MS + 50);
    }
    const waiting = Date.now() - panel.since < GRACE_MS;
    let stateKey =
      id && payloads.has(id) ? (states.get(id) || {}).state || 'none' : waiting ? 'checking' : 'missing';
    if (stateKey === 'missing' && diagLoggedFor !== panelKey) {
      diagLoggedFor = panelKey;
      collectDiagnostics().then((d) =>
        console.warn('[CodeShelf] Not captured. Diagnostics:\n' + JSON.stringify(d, null, 2)),
      );
    }
    if (stateKey === 'missing' && Date.now() < copiedUntil) stateKey = 'copied';
    const look = LOOKS[stateKey] || LOOKS.error;
    const detail =
      stateKey === 'missing'
        ? 'CodeShelf is running but did not capture this submission. Click to copy diagnostics.'
        : (states.get(id) || {}).detail || '';
    const signature = [id, stateKey, detail, !!target].join('|');
    if (btn.dataset.signature === signature) return; // avoid touching the DOM (and re-triggering the observer)

    btn.dataset.signature = signature;
    btn.dataset.submissionId = id || '';
    btn.querySelector('span').textContent = look.label;
    btn.title = detail || look.label;
    btn.disabled = !look.clickable;
    btn.style.cssText =
      BASE_STYLE +
      (target ? INLINE_STYLE : FLOAT_STYLE) +
      `background:${look.color};cursor:${look.clickable ? 'pointer' : 'default'};opacity:${look.clickable || stateKey !== 'missing' ? 1 : 0.8};`;
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(render);
  }

  // LeetCode is a single-page app: re-check whenever the DOM changes (throttled to one pass per frame).
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
