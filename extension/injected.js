// CodeShelf – page-world observer.
//
// Runs in LeetCode's MAIN world at document_start so it can wrap fetch/XHR
// before LeetCode's own bundles load. It is strictly passive: it reads copies
// of requests/responses the page already makes for the logged-in user and
// never issues requests of its own or alters what the page receives.
//
// Flow it observes:
//   POST /problems/<slug>/submit/            body: { lang, question_id, typed_code }
//                                            resp: { submission_id }
//   GET  /submissions/detail/<id>/v2/check/  polled until state === "SUCCESS" (older UI: no "v2/");
//                                            status_code 10 === "Accepted"
//   POST /graphql/ submissionDetails         the page's own query for the result
//                                            panel (code, runtime, memory, status)
(() => {
  'use strict';

  if (window.__codeshelfInstalled) return;
  window.__codeshelfInstalled = true;

  // Enable from the LeetCode tab's console: localStorage.setItem('codeshelf:debug', '1'), then reload.
  const DEBUG = (() => {
    try {
      return localStorage.getItem('codeshelf:debug') === '1';
    } catch {
      return false;
    }
  })();
  const SUBMIT_RE = /\/problems\/([^/]+)\/submit\/?$/;
  // "Run" uses non-numeric ids, so it never matches.
  const CHECK_RE = /\/submissions\/detail\/(\d+)\/(?:v\d+\/)?check\/?$/;
  const GRAPHQL_RE = /\/graphql\/?$/;
  const STATUS_ACCEPTED = 10;
  const MAX_TRACKED = 50;
  // An Accepted submissionDetails response this fresh is treated as "just submitted" and
  // auto-saved; older ones (browsing history) only get the manual button.
  const RECENT_MS = 15 * 60 * 1000;

  const submissions = new Map(); // submissionId -> what was sent
  const results = new Map(); // submissionId -> final judge result
  const emitted = new Set(); // submissionIds already sent for auto-save
  const detailsLog = []; // why each submissionDetails response was or wasn't used (diagnostics)
  const checkLog = []; // shape of finished check responses (diagnostics)

  const log = (...args) => DEBUG && console.log('[CodeShelf debug]', ...args);

  function toURL(raw) {
    try {
      return new URL(raw, location.href);
    } catch {
      return null;
    }
  }

  function remember(map, key, value) {
    map.set(key, value);
    if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
  }

  function post(type, payload) {
    window.postMessage({ source: 'codeshelf', type, payload }, location.origin);
  }

  // Recent submission-related traffic (paths and GraphQL operation names only, never bodies),
  // reported by the "not captured" diagnostic and logged live in debug mode.
  const seen = [];
  function trace(transport, url, method, body) {
    if (!url) return;
    const path = url.pathname;
    const where = url.origin === location.origin ? path : `${url.host}${path}`;
    let entry = null;
    if (GRAPHQL_RE.test(path) && isLeetCode(url)) {
      let op = '?';
      try {
        op = JSON.parse(body).operationName || '?';
      } catch {}
      entry = `${transport} ${method} ${where} op:${op}`;
    } else if (/submi|check|judge|interpret/i.test(path)) {
      entry = `${transport} ${method} ${where}`;
    }
    if (!entry) return;
    if (seen[seen.length - 1] !== entry) seen.push(entry);
    if (seen.length > 40) seen.shift();
    if (/submi|check|judge/i.test(entry)) log(entry);
  }

  function isLeetCode(url) {
    return url.hostname === location.hostname || url.hostname.endsWith('.leetcode.com');
  }

  function note(id, outcome) {
    detailsLog.push(`${id}: ${outcome}`);
    if (detailsLog.length > 10) detailsLog.shift();
    log('submissionDetails', id, outcome);
  }

  function classify(url, method) {
    if (!url || !isLeetCode(url)) return null;
    let m;
    if (method === 'POST' && (m = url.pathname.match(SUBMIT_RE))) {
      return { kind: 'submit', key: decodeURIComponent(m[1]) };
    }
    if ((m = url.pathname.match(CHECK_RE))) {
      return { kind: 'check', key: m[1] };
    }
    if (method === 'POST' && GRAPHQL_RE.test(url.pathname)) {
      return { kind: 'graphql', key: null };
    }
    return null;
  }

  // GraphQL is only worth reading for the submissionDetails query.
  function refineGraphql(target, bodyText) {
    if (!target || target.kind !== 'graphql') return target;
    try {
      const body = JSON.parse(bodyText);
      const isDetails =
        body.operationName === 'submissionDetails' ||
        /submissionDetails\s*\(/.test(String(body.query || ''));
      if (!isDetails) return null;
      const vars = body.variables || {};
      const fromUrl = location.pathname.match(/\/submissions\/(\d+)/);
      const id = vars.submissionId ?? vars.submission_id ?? vars.id ?? (fromUrl && fromUrl[1]);
      if (id == null) {
        note('?', `no submission id in variables (${Object.keys(vars).join(',') || 'none'})`);
        return null;
      }
      return { kind: 'details', key: String(id) };
    } catch {
      return null;
    }
  }

  function slugFromPath() {
    const m = location.pathname.match(/\/problems\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function problemTitle(slug) {
    const fromDoc = document.title.replace(/\s*-\s*LeetCode\s*$/i, '').trim();
    if (fromDoc && !/^leetcode\b/i.test(fromDoc)) return fromDoc;
    return slug
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  function toNumber(value) {
    const n = Number(value);
    return value != null && Number.isFinite(n) ? n : null;
  }

  function onSubmit(slug, requestText, json) {
    if (!json || json.submission_id == null || requestText == null) return;
    const body = JSON.parse(requestText);
    if (typeof body.typed_code !== 'string') return;

    const id = String(json.submission_id);
    remember(submissions, id, {
      submissionId: id,
      slug,
      title: problemTitle(slug),
      url: `${location.origin}/problems/${slug}/`,
      questionId: body.question_id != null ? String(body.question_id) : null,
      lang: body.lang,
      code: body.typed_code, // exactly what LeetCode received
      submittedAt: new Date().toISOString(),
    });
    log('submit captured', id, slug);
    tryEmit(id);
  }

  // Normalises the check response; field names differ slightly between check API versions.
  function onCheck(id, json) {
    if (!json || typeof json !== 'object') return;
    const state = String(json.state ?? json.status ?? '').toUpperCase();
    if (state === 'PENDING' || state === 'STARTED' || state === 'QUEUED') return; // still judging
    const code = Number(json.status_code ?? json.statusCode);
    if (state !== 'SUCCESS' && !Number.isFinite(code)) return;
    if (results.has(id)) return;

    checkLog.push(`${id}: state=${state || '?'} code=${code} keys=${Object.keys(json).slice(0, 30).join(',')}`);
    if (checkLog.length > 5) checkLog.shift();

    remember(results, id, {
      ...json,
      status_code: code,
      status_msg: json.status_msg ?? json.statusMsg ?? json.status_display ?? null,
      status_runtime: json.status_runtime ?? json.runtimeDisplay ?? json.display_runtime ?? null,
      status_memory: json.status_memory ?? json.memoryDisplay ?? null,
      pretty_lang: json.pretty_lang ?? json.prettyLang ?? null,
    });
    log('judge finished', id, code, json.status_msg);
    tryEmit(id);
  }

  function detailsFrom(json) {
    const data = json && json.data;
    if (!data) return null;
    if (data.submissionDetails) return data.submissionDetails;
    return Object.values(data).find((v) => v && typeof v === 'object' && typeof v.code === 'string') || null;
  }

  function onDetails(id, json) {
    const d = detailsFrom(json);
    if (!d) return note(id, `no submissionDetails in response (${json && json.errors ? 'GraphQL errors' : 'empty'})`);

    const statusKnown = d.statusCode != null || d.statusDisplay != null;
    const accepted = Number(d.statusCode) === STATUS_ACCEPTED || /^accepted$/i.test(String(d.statusDisplay || ''));
    if (statusKnown && !accepted) return note(id, `not accepted (status ${d.statusCode ?? d.statusDisplay})`);
    if (typeof d.code !== 'string' || !d.code) return note(id, 'response has no code field');

    const q = d.question || {};
    const slug = q.titleSlug || slugFromPath();
    const lang = typeof d.lang === 'string' ? d.lang : (d.lang && d.lang.name) || d.langName || null;
    if (!slug || !lang) return note(id, `missing ${!slug ? 'problem slug' : 'language'}`);

    const ts = toNumber(d.timestamp);
    const tsMs = ts ? (ts < 1e12 ? ts * 1000 : ts) : null;
    const details = {
      submissionId: id,
      slug,
      title: q.title || problemTitle(slug),
      url: `${location.origin}/problems/${slug}/`,
      questionId: q.questionId != null ? String(q.questionId) : null,
      lang,
      code: d.code, // the stored submission, i.e. exactly what was submitted
      submittedAt: tsMs ? new Date(tsMs).toISOString() : null,
      languageName: (d.lang && d.lang.verboseName) || lang,
      statusMsg: 'Accepted',
      runtime: d.runtimeDisplay || null,
      memory: d.memoryDisplay || null,
      runtimePercentile: toNumber(d.runtimePercentile),
      memoryPercentile: toNumber(d.memoryPercentile),
      judgedAt: null,
    };

    if (accepted && submissions.has(id) && !results.has(id)) {
      // A submit we watched in this tab gets its verdict here if the check poll was missed.
      onCheck(id, {
        state: 'SUCCESS',
        status_code: STATUS_ACCEPTED,
        status_msg: 'Accepted',
        status_runtime: details.runtime,
        status_memory: details.memory,
        pretty_lang: details.languageName,
        runtime_percentile: details.runtimePercentile,
        memory_percentile: details.memoryPercentile,
      });
      note(id, 'accepted, matched a submit from this tab');
    } else if (accepted && tsMs && Math.abs(Date.now() - tsMs) < RECENT_MS) {
      // Submit request wasn't visible (e.g. another script replaced fetch), but this is a fresh Accepted result.
      emitAccepted(details);
      note(id, 'accepted and recent, auto-saving');
    } else {
      note(id, accepted ? 'accepted but older than 15 min, manual save only' : 'status unknown, manual save only');
    }

    // Lets the in-page button offer a manual save for any Accepted submission being viewed.
    post('SUBMISSION_DETAILS', details);
  }

  function emitAccepted(payload) {
    if (emitted.has(payload.submissionId)) return;
    emitted.add(payload.submissionId);
    post('ACCEPTED_SUBMISSION', payload);
  }

  // Submit and verdict responses are matched by id, so arrival order doesn't matter.
  function tryEmit(id) {
    const sub = submissions.get(id);
    const res = results.get(id);
    if (!sub || !res) return;
    submissions.delete(id);

    if (res.status_code !== STATUS_ACCEPTED) {
      log('not accepted, ignoring', id, res.status_msg);
      return;
    }

    const finishedMs = toNumber(res.task_finish_time);
    emitAccepted({
      ...sub,
      languageName: res.pretty_lang || sub.lang,
      statusMsg: res.status_msg,
      runtime: res.status_runtime || null,
      memory: res.status_memory || null,
      runtimePercentile: toNumber(res.runtime_percentile),
      memoryPercentile: toNumber(res.memory_percentile),
      judgedAt: finishedMs ? new Date(finishedMs).toISOString() : null,
    });
  }

  function handle(target, requestText, responseText) {
    Promise.all([requestText, responseText])
      .then(([req, res]) => {
        const json = JSON.parse(res);
        if (target.kind === 'submit') onSubmit(target.key, req, json);
        else if (target.kind === 'check') onCheck(target.key, json);
        else if (target.kind === 'details') onDetails(target.key, json);
      })
      .catch((err) => {
        if (target.kind === 'details') note(target.key, `could not read response: ${err && err.message}`);
        log('could not inspect', target, err);
      });
  }

  // --- fetch -----------------------------------------------------------------
  const nativeFetch = window.fetch;
  const hookedFetch = function (input, init) {
    let target = null;
    let requestText = null;
    try {
      const isRequest = input instanceof Request;
      const url = toURL(isRequest ? input.url : String(input));
      const method = String((init && init.method) || (isRequest ? input.method : 'GET')).toUpperCase();
      const body = init && typeof init.body === 'string' ? init.body : null;
      trace('fetch', url, method, body);
      target = classify(url, method);
      if (target && target.kind === 'graphql') target = refineGraphql(target, body);
      if (target && target.kind === 'submit') {
        if (init && init.body != null) {
          requestText = Promise.resolve(body);
        } else if (isRequest) {
          requestText = input.clone().text(); // must clone before the page's fetch consumes it
        }
      }
    } catch (err) {
      target = null;
      log('fetch pre-inspect failed', err);
    }

    const pending = nativeFetch.apply(this, arguments);
    if (!target) return pending;

    return pending.then((response) => {
      try {
        handle(target, requestText, response.clone().text());
      } catch (err) {
        log('fetch inspect failed', err);
      }
      return response;
    });
  };
  window.fetch = hookedFetch;

  // --- XMLHttpRequest (in case LeetCode switches transport) -------------------
  const xhrTargets = new WeakMap();
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  const hookedOpen = function (method, url) {
    try {
      const target = classify(toURL(String(url)), String(method).toUpperCase());
      if (target) xhrTargets.set(this, { ...target, method: String(method).toUpperCase(), url: toURL(String(url)) });
      else xhrTargets.delete(this);
    } catch (err) {
      log('xhr open inspect failed', err);
    }
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.open = hookedOpen;

  // LeetCode reads its GraphQL responses as Blobs, so handle every text-bearing responseType.
  function xhrResponseText(xhr) {
    const type = xhr.responseType;
    if (type === '' || type === 'text') return Promise.resolve(xhr.responseText);
    if (type === 'json') return Promise.resolve(JSON.stringify(xhr.response));
    if (type === 'blob' && xhr.response) return xhr.response.text();
    if (type === 'arraybuffer' && xhr.response) return Promise.resolve(new TextDecoder().decode(xhr.response));
    return null;
  }

  XMLHttpRequest.prototype.send = function (body) {
    let target = xhrTargets.get(this);
    if (target) {
      const bodyText = typeof body === 'string' ? body : null;
      trace('xhr', target.url, target.method, bodyText);
      target = refineGraphql(target, bodyText);
    }
    if (target) {
      const requestText = Promise.resolve(typeof body === 'string' ? body : null);
      this.addEventListener(
        'load',
        () => {
          try {
            const text = xhrResponseText(this);
            if (text) handle(target, requestText, text);
            else if (target.kind === 'details') note(target.key, `unreadable responseType "${this.responseType}"`);
          } catch (err) {
            log('xhr inspect failed', err);
          }
        },
        { once: true },
      );
    }
    return nativeSend.apply(this, arguments);
  };

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (!event.data || event.data.source !== 'codeshelf-content' || event.data.type !== 'DIAG_REQUEST') return;
    post('DIAG', {
      fetchHooked: window.fetch === hookedFetch,
      fetchLooksNative: /\[native code\]/.test(Function.prototype.toString.call(window.fetch)),
      xhrHooked: XMLHttpRequest.prototype.open === hookedOpen,
      pendingSubmits: [...submissions.keys()],
      verdictsSeen: [...results.keys()],
      detailsLog: detailsLog.slice(),
      checkLog: checkLog.slice(),
      seenByHook: seen.slice(),
    });
  });

  console.info(`[CodeShelf] Watching submissions on this page${DEBUG ? ' (debug on)' : ''}`);
})();
