// CoqRunner.js
// Usage: await CoqRunner.checkProofText(coqSource [, opts])
// opts: { timeoutMs, pollMs, candidates }

(function (global) {
  const CoqRunner = {};
  const cache = { initting: null, manager: null, basePath: null, busy: false, scriptUrl: null };

  const WRAPPER_ID = 'coq-runner-wrapper';
  const SNIPPET_ID = 'coq-runner-snippet';

  const DEFAULT_CANDIDATES = [
    './jscoq/jscoq.js'
  ];

  function ensureRunnerDom() {
    let wrapper = document.getElementById(WRAPPER_ID);
    if (!wrapper) {
      wrapper = document.createElement('div');
      wrapper.id = WRAPPER_ID;
      wrapper.setAttribute('aria-hidden', 'true');
      wrapper.style.position = 'fixed';
      wrapper.style.width = '1px';
      wrapper.style.height = '1px';
      wrapper.style.top = '-10000px';
      wrapper.style.left = '-10000px';
      wrapper.style.opacity = '0';
      wrapper.style.pointerEvents = 'none';
      document.body.appendChild(wrapper);
    }

    let snippet = document.getElementById(SNIPPET_ID);
    if (!snippet) {
      snippet = document.createElement('textarea');
      snippet.id = SNIPPET_ID;
      snippet.setAttribute('aria-hidden', 'true');
      wrapper.appendChild(snippet);
    }

    return { wrapper, snippet };
  }

  function findJsCoqGlobal() {
    if (window.jsCoq && window.jsCoq.JsCoq && (typeof window.jsCoq.JsCoq.init === 'function' || typeof window.jsCoq.JsCoq.start === 'function')) {
      return { name: 'jsCoq.JsCoq', lib: window.jsCoq.JsCoq };
    }
    if (window.jsCoq && (typeof window.jsCoq.init === 'function' || typeof window.jsCoq.start === 'function')) {
      return { name: 'jsCoq', lib: window.jsCoq };
    }
    if (window.JsCoq && (typeof window.JsCoq.init === 'function' || typeof window.JsCoq.start === 'function')) {
      return { name: 'JsCoq', lib: window.JsCoq };
    }
    return null;
  }

  function resolveUrl(path) {
    const bases = [];
    if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI) {
      bases.push(document.baseURI);
    }
    if (typeof window !== 'undefined' && window.location && typeof window.location.href === 'string' && window.location.href) {
      bases.push(window.location.href);
    }
    if (typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string' && window.location.origin && window.location.origin !== 'null') {
      bases.push(window.location.origin + '/');
    }

    for (const base of bases) {
      try {
        return new URL(path, base).href;
      } catch (e) {
        // try next base
      }
    }

    try {
      return new URL(path).href;
    } catch (e) {
      const detail = bases.length ? bases.join(', ') : '(none)';
      throw new Error('Invalid base URL for ' + path + ' (bases: ' + detail + ')');
    }
  }

  async function loadBundle(url) {
    const absUrl = resolveUrl(url);
    if (cache.scriptUrl === absUrl && findJsCoqGlobal()) return absUrl;

    try {
      const mod = await import(/* webpackIgnore: true */ absUrl);
      const candidate = mod.JsCoq || mod.default || mod;
      if (candidate && (typeof candidate.init === 'function' || typeof candidate.start === 'function')) {
        window.jsCoq = candidate;
        cache.scriptUrl = absUrl;
        return absUrl;
      }
    } catch (e) {
      // fall back to classic script tag
    }

    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = absUrl;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('script load error: ' + absUrl));
      document.head.appendChild(s);
    });

    const found = findJsCoqGlobal();
    if (!found) throw new Error('script loaded but no jsCoq global found: ' + absUrl);
    window.jsCoq = found.lib;
    cache.scriptUrl = absUrl;
    return absUrl;
  }

  function attachGoalSpy(manager) {
    if (manager.__coqRunnerGoalSpy) return;
    if (typeof manager.coqGoalInfo !== 'function') return;
    const original = manager.coqGoalInfo.bind(manager);
    manager.__coqRunnerGoalSpy = true;
    manager.__coqRunnerLastGoals = null;
    manager.__coqRunnerLastGoalsAt = 0;
    manager.coqGoalInfo = function (sid, goals) {
      manager.__coqRunnerLastGoals = goals;
      manager.__coqRunnerLastGoalsAt = Date.now();
      return original(sid, goals);
    };
  }

  async function ensureJsCoq(opts = {}) {
    if (cache.manager && findJsCoqGlobal()) {
      return { manager: cache.manager, basePath: cache.basePath };
    }

    if (!cache.initting) {
      cache.initting = (async () => {
        const candidates = opts.candidates || DEFAULT_CANDIDATES;
        let lastErr = null;

        for (const c of candidates) {
          try {
            const absUrl = await loadBundle(c);

            let basePath = absUrl.replace(/\/?[^/]*$/, '/');

            const found = findJsCoqGlobal();
            if (!found) throw new Error('no jsCoq global after loading bundle');
            const api = found.lib;
            ensureRunnerDom();

            const options = {
              wrapper_id: WRAPPER_ID,
              base_path: basePath,
              prelaunch: true,
              prelude: true,
              implicit_libs: true,
              init_pkgs: ['init'],
              all_pkgs: ['coq'],
              show: false,
              focus: false,
              replace: false
            };

            let manager;
            if (typeof api.start === 'function') {
              manager = await api.start(basePath, [SNIPPET_ID], options);
            } else if (typeof api.init === 'function') {
              manager = await api.init(basePath, [SNIPPET_ID], options);
            } else {
              throw new Error('jsCoq found but no start()/init()');
            }

            await waitForManagerReady(manager);
            attachGoalSpy(manager);

            cache.manager = manager;
            cache.basePath = basePath;
            cache.scriptUrl = c;
            return { manager, basePath };
          } catch (e) {
            lastErr = e;
            cache.manager = null;
            cache.basePath = null;
            cache.scriptUrl = null;
            try { delete window.jsCoq; } catch (err) {}
            try { delete window.JsCoq; } catch (err) {}
          }
        }

        throw new Error('failed to load jsCoq bundle: ' + (lastErr && lastErr.message));
      })();
    }

    return cache.initting;
  }

  async function waitForManagerReady(manager, timeoutMs = 45000) {
    if (!manager) throw new Error('jsCoq manager is unavailable');

    const whenReady = manager.when_ready && manager.when_ready.promise ? manager.when_ready.promise : null;
    if (whenReady && typeof whenReady.then === 'function') {
      await Promise.race([
        whenReady,
        sleep(timeoutMs).then(() => { throw new Error('jsCoq manager ready timeout'); })
      ]);
      return;
    }

    const start = Date.now();
    while (true) {
      const sid = manager && manager.doc && manager.doc.sentences && manager.doc.sentences[0] && manager.doc.sentences[0].coq_sid;
      const isReady = !!(manager.navEnabled && sid && Number(sid) > 1);
      if (isReady) return;
      if (Date.now() - start > timeoutMs) throw new Error('jsCoq manager ready timeout');
      await sleep(100);
    }
  }

  async function waitForManagerIdle(manager, startedAt, timeoutMs = 45000) {
    while (true) {
      if (manager.error && manager.error.length > 0) return;
      const hasBusy = !!(manager.doc && Array.isArray(manager.doc.sentences) && manager.doc.sentences.some((stm) => {
        if (!stm || !stm.phase) return false;
        return stm.phase === 'pending' || stm.phase === 'adding' || stm.phase === 'added' || stm.phase === 'processing';
      }));
      if (!hasBusy) return;
      if (Date.now() - startedAt > timeoutMs) throw new Error('jsCoq execution timeout');
      await sleep(60);
    }
  }

  async function waitForGoalsUpdate(manager, sinceTs, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (manager.__coqRunnerLastGoalsAt && manager.__coqRunnerLastGoalsAt > sinceTs) return;
      await sleep(50);
    }
  }

  async function acquireLock() {
    while (cache.busy) await sleep(20);
    cache.busy = true;
  }
  function releaseLock() { cache.busy = false; }

  function parseGoalsFromText(allText) {
    if (!allText || !allText.trim()) return null;
    const out = { remaining: null, summaries: [] };
    if (/no more subgoals/i.test(allText)) out.remaining = 0;
    const m = allText.match(/(\d+)\s+(?:subgoals?|goals?)/i);
    if (m) out.remaining = Number(m[1]);
    const lines = allText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i];
      if (/subgoal|goal/i.test(L) || /^={3,}$/.test(L)) {
        const snippet = [L];
        for (let k = 1; k <= 4 && i + k < lines.length; k++) {
          if (!lines[i + k]) break;
          snippet.push(lines[i + k]);
        }
        out.summaries.push(snippet.join(' | '));
      }
    }
    if (out.summaries.length === 0) out.summaries.push(allText.slice(0, 200));
    return out;
  }

  function countGoalsFromResponse(res) {
    if (res === null || res === undefined) return null;
    if (typeof res === 'string') {
      const parsed = parseGoalsFromText(res);
      return parsed && typeof parsed.remaining === 'number' ? parsed.remaining : null;
    }
    if (Array.isArray(res)) {
      if (res.length === 0) return 0;
      const first = res[0];
      if (first && typeof first === 'object') {
        if ('goal' in first || 'hyp' in first || 'hyps' in first || 'type' in first) return res.length;
      }
      for (const item of res) {
        const nested = countGoalsFromResponse(item);
        if (nested !== null) return nested;
      }
      return null;
    }
    if (typeof res === 'object') {
      if (Array.isArray(res.goals)) return res.goals.length;
      if (res.goals && typeof res.goals === 'object') {
        const nestedGoals = countGoalsFromResponse(res.goals);
        if (nestedGoals !== null) return nestedGoals;
      }
      if (Array.isArray(res.fg)) return res.fg.length;
      if (Array.isArray(res.fg_goals)) return res.fg_goals.length;
      if (Array.isArray(res.bg)) return res.bg.length;
      if (Array.isArray(res.bg_goals)) return res.bg_goals.length;
      if (Array.isArray(res.shelved)) return res.shelved.length;
      if (Array.isArray(res.given_up)) return res.given_up.length;
      if (Array.isArray(res.givenUp)) return res.givenUp.length;
      if (typeof res.goals === 'number' && Number.isFinite(res.goals)) return res.goals;
    }
    return null;
  }

  function stringifyCoqPayload(payload) {
    try {
      return JSON.stringify(payload);
    } catch (e) {
      return String(payload);
    }
  }

  function extractCoqError(manager) {
    try {
      const stm = manager.error && manager.error[0];
      if (!stm) return 'Coq validation error';
      const feedback = Array.isArray(stm.feedback)
        ? stm.feedback.find((item) => item && item.level === 'Error')
        : null;
      let message = '';
      if (feedback && manager.pprint && typeof manager.pprint.pp2Text === 'function') {
        const text = manager.pprint.pp2Text(feedback.msg);
        if (text) message = text;
      }
      if (!message && feedback && feedback.msg) message = stringifyCoqPayload(feedback.msg);
      if (!message && stm && stm.msg) message = stringifyCoqPayload(stm.msg);
      return message || 'Coq validation error';
    } catch (e) {
      return 'Coq validation error';
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function checkProofText(text, opts = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;

    const { manager } = await ensureJsCoq(opts);
    attachGoalSpy(manager);
    await acquireLock();

    try {
      if (!manager || !manager.provider || typeof manager.provider.load !== 'function') {
        throw new Error('jsCoq manager provider is unavailable');
      }
      if (manager.error && Array.isArray(manager.error)) manager.error.length = 0;

      const docName = 'Main_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.v';
      const loadOpts = { reset: true, flags: {} };
      manager.provider.load(String(text || ''), docName, loadOpts);
      if (typeof manager.provider.focus === 'function') manager.provider.focus();

      const started = Date.now();
      while (true) {
        const advanced = typeof manager.goNext === 'function' ? manager.goNext(false) : false;
        await waitForManagerIdle(manager, started, timeoutMs);
        if (manager.error && manager.error.length > 0) break;
        if (!advanced) break;
      }

      const goalRequestAt = Date.now();
      const last = manager.lastAdded ? manager.lastAdded() : null;
      if (last && last.coq_sid && manager.coq && typeof manager.coq.goals === 'function') {
        manager.coq.goals(last.coq_sid);
        await waitForGoalsUpdate(manager, goalRequestAt, 2000);
      }

      const goalsCount = countGoalsFromResponse(manager.__coqRunnerLastGoals);

      if (manager.error && manager.error.length > 0) {
        const msg = extractCoqError(manager);
        return {
          ok: false,
          error: {
            remaining: typeof goalsCount === 'number' ? goalsCount : -1,
            summaries: [msg]
          }
        };
      }

      if (typeof goalsCount === 'number') {
        if (goalsCount === 0) return { ok: true };
        return {
          ok: false,
          error: {
            remaining: goalsCount,
            summaries: ['Remaining goals: ' + goalsCount]
          }
        };
      }

      return {
        ok: false,
        error: {
          remaining: -1,
          summaries: ['Goals could not be determined']
        }
      };
    } finally {
      releaseLock();
    }
  }

  CoqRunner.checkProofText = checkProofText;
  if (!global.CoqRunner) global.CoqRunner = CoqRunner;
  if (!global.checkProofText) global.checkProofText = (text, opts) => CoqRunner.checkProofText(text, opts);

})(window);
