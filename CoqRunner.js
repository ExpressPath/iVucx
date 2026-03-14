// CoqRunner.js — improved, copy-paste replace (full file)
// Usage: await CoqRunner.checkProofText(coqSource [, opts])
// opts: { timeoutMs, pollMs, candidates }.
// Place this file in your repo. Ensure jsCoq build assets are available under ./jscoq/
// (e.g. ./jscoq/dist/frontend/index.js and ./jscoq/coq-worker.js), or adjust candidates.

(function (global) {
  const CoqRunner = {};
  const cache = { initting: null, sid: null, basePath: null, busy: false, scriptUrl: null };

  // Try reasonable local candidates first, then fall back to CDN if needed.
  const DEFAULT_CANDIDATES = [
    './jscoq/dist/frontend/index.js',
    './jscoq/jscoq.js',
    './jscoq/package/dist/jscoq.js',
    './jscoq-0.17.1/dist/jscoq.js',
    // last resort (network)
    'https://cdn.jsdelivr.net/npm/jscoq@0.17.1/dist/jscoq.js'
  ];

  // helper: fetch text safely (returns null on failure)
  async function tryFetchText(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status ' + r.status);
      return await r.text();
    } catch (e) {
      return null;
    }
  }

  // find any global object with an init/start function
  function findJsCoqGlobal() {
    // direct case: wasm/UMD or module placed object at window.jsCoq.JsCoq
    if (window.jsCoq && window.jsCoq.JsCoq && (typeof window.jsCoq.JsCoq.init === 'function' || typeof window.jsCoq.JsCoq.start === 'function')) {
      return { name: 'jsCoq.JsCoq', lib: window.jsCoq.JsCoq };
    }
    // if a module namespace was assigned directly to window.jsCoq with init/start
    if (window.jsCoq && (typeof window.jsCoq.init === 'function' || typeof window.jsCoq.start === 'function')) {
      return { name: 'jsCoq', lib: window.jsCoq };
    }

    try {
      const keys = Object.keys(window);
      for (const k of keys) {
        if (k.toLowerCase().includes('coq')) {
          const v = window[k];
          if (v && (typeof v.init === 'function' || typeof v.start === 'function')) return { name: k, lib: v };
        }
      }
    } catch (e) { /* ignore */ }

    // known common variants (safety)
    const variants = ['jsCoq', 'JsCoq', 'JSCoq', 'jscoq'];
    for (const v of variants) {
      if (window[v] && (typeof window[v].init === 'function' || typeof window[v].start === 'function')) return { name: v, lib: window[v] };
      // also if window[v].JsCoq exists
      if (window[v] && window[v].JsCoq && (typeof window[v].JsCoq.init === 'function' || typeof window[v].JsCoq.start === 'function')) return { name: v + '.JsCoq', lib: window[v].JsCoq };
    }
    return null;
  }

  // loadBundle: detect module vs UMD; load accordingly.
  async function loadBundle(url, asModuleHint) {
    if (cache.scriptUrl === url && findJsCoqGlobal()) return url;

    // fetch to decide whether content exists and if it's module-like
    const text = await tryFetchText(url);
    if (text === null) throw new Error('fetch failed: ' + url);

    // heuristics for module: import.meta, import(...), import ... from, export ...
    const looksModule = /\b(import\.meta|import\s*\(|\bfrom\s+['"]|^\s*import\s+|^\s*export\s+)/im.test(text) || asModuleHint;

    if (looksModule) {
      // Preferred: insert <script type="module"> so import.meta and relative imports behave correctly.
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.type = 'module';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('module script load error: ' + url));
        document.head.appendChild(s);
      });

      // try to find a global created by that module (some bundles export to window)
      let found = findJsCoqGlobal();
      if (found) {
        window.jsCoq = found.lib;
        cache.scriptUrl = url;
        return url;
      }

      // fallback: try dynamic import of the same URL (works if same-origin & CORS allows)
      try {
        const mod = await import(/* webpackIgnore: true */ url);
        // normalize common shapes
        const candidate = mod.JsCoq || mod.default || mod;
        if (candidate && (typeof candidate.init === 'function' || typeof candidate.start === 'function')) {
          window.jsCoq = candidate;
          cache.scriptUrl = url;
          return url;
        }
      } catch (e) {
        // dynamic import failed as fallback; we will throw below
      }

      // no global or usable export found
      throw new Error('script loaded but no jsCoq global found: ' + url);
    } else {
      // UMD: load as classic script tag
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script load error: ' + url));
        document.head.appendChild(s);
      });
      const found = findJsCoqGlobal();
      if (!found) throw new Error('script loaded but no jsCoq global found: ' + url);
      window.jsCoq = found.lib;
      cache.scriptUrl = url;
      return url;
    }
  }

  // ensure jsCoq loaded & initialized; returns { jsCoq, sid, basePath }
  async function ensureJsCoq(opts = {}) {
    if (cache.sid && findJsCoqGlobal()) {
      // normalize window.jsCoq to the library object that has start/init
      const f = findJsCoqGlobal();
      window.jsCoq = f.lib;
      return { jsCoq: window.jsCoq, sid: cache.sid, basePath: cache.basePath };
    }

    if (!cache.initting) {
      cache.initting = (async () => {
        const candidates = opts.candidates || DEFAULT_CANDIDATES;
        let lastErr = null;
        let chosen = null;
        for (const c of candidates) {
          try {
            await loadBundle(c, false);
            chosen = c;
            break;
          } catch (e) {
            lastErr = e;
            // continue to next candidate
          }
        }
        if (!chosen) throw new Error('failed to load jsCoQ bundle: ' + (lastErr && lastErr.message));

        // base path: use the directory part of the chosen url
        let basePath = chosen.replace(/\/?[^/]*$/, '');
        if (!basePath.endsWith('/')) basePath += '/';

        // try to discover the library object again
        const found = findJsCoqGlobal();
        if (!found) throw new Error('no jsCoq global after loading bundle');
        // normalize window.jsCoq to the library that exposes init/start/add/goals etc.
        window.jsCoq = found.lib;

        // api may be in window.jsCoq or nested (some builds expose JsCoq)
        const api = (window.jsCoq.JsCoq && (typeof window.jsCoq.JsCoq.init === 'function' || typeof window.jsCoq.JsCoq.start === 'function')) ? window.jsCoq.JsCoq : window.jsCoq;

        // check for start/init
        const starter = api.start || api.init;
        if (typeof starter !== 'function') {
          throw new Error('jsCoq found but no start()/init()');
        }

        // call starter and store sid (some APIs return a session id, others return an object; keep both)
        try {
          cache.sid = starter({ base_path_: basePath, init_pkgs: ['init'], all_pkgs: true });
        } catch (e) {
          // some implementations return a Promise
          cache.sid = await Promise.resolve(starter({ base_path_: basePath, init_pkgs: ['init'], all_pkgs: true }));
        }

        cache.basePath = basePath;
        return { jsCoq: window.jsCoq, sid: cache.sid, basePath };
      })();
    }
    return cache.initting;
  }

  // small lock to avoid concurrent commits
  async function acquireLock() {
    while (cache.busy) await new Promise(r => setTimeout(r, 20));
    cache.busy = true;
  }
  function releaseLock() { cache.busy = false; }

  // parse simple goal info from captured raw text
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

  // safe getter for jsCoq handlers (may be undefined)
  function jsCoQ_safe(jsCoqObj, prop) {
    try { return jsCoqObj && jsCoqObj[prop]; } catch (e) { return undefined; }
  }

  // main exported function: checkProofText
  async function checkProofText(text, opts = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be a string');
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
    const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 50;

    const { jsCoq, sid } = await ensureJsCoq(opts);
    await acquireLock();

    const captured = [];
    let finishedFlag = false;
    let admittedSeen = false;
    let errorSeen = false;

    function capturePayload(p) {
      const s = (typeof p === 'string') ? p : (() => { try { return JSON.stringify(p); } catch (e) { return String(p); } })();
      captured.push(s);
      const low = s.toLowerCase();
      if (/\badmitted\b/.test(low)) admittedSeen = true;
      if (/\berror\b|\bfail(ed)?\b/.test(low)) errorSeen = true;
      if (/\b(no more subgoals|proof completed|qed|completed|done)\b/.test(low)) finishedFlag = true;
    }

    // determine the runtime object that exposes add/edit/commit/goals
    const runtime = (window.jsCoq && window.jsCoq.JsCoq) ? window.jsCoq.JsCoq : window.jsCoq;

    // backup handlers
    const old = { onLog: jsCoQ_safe(runtime, 'onLog'), onError: jsCoQ_safe(runtime, 'onError'), onMessage: jsCoQ_safe(runtime, 'onMessage'), onFeedback: jsCoQ_safe(runtime, 'onFeedback') };

    // install capture handlers as possible
    try { if ('onLog' in runtime) runtime.onLog = capturePayload; } catch (e) {}
    try { if ('onError' in runtime) runtime.onError = capturePayload; } catch (e) {}
    try { if ('onMessage' in runtime) runtime.onMessage = capturePayload; } catch (e) {}
    try { if ('onFeedback' in runtime) runtime.onFeedback = capturePayload; } catch (e) {}

    try {
      // send code: adapt to different API names
      let node;
      try {
        // some APIs expose add/edit/commit on runtime, others on a manager object; we try the common ones.
        const addFn = runtime.add || (runtime.JsCoq && runtime.JsCoq.add) || (window.jsCoq && window.jsCoq.add);
        const editFn = runtime.edit || (runtime.JsCoq && runtime.JsCoq.edit) || (window.jsCoq && window.jsCoq.edit);
        const commitFn = runtime.commit || (runtime.JsCoq && runtime.JsCoq.commit) || (window.jsCoq && window.jsCoq.commit);

        if (typeof addFn !== 'function') throw new Error('add() API not found on jsCoq runtime');
        node = addFn(sid, -1, text);

        if (typeof editFn === 'function') editFn(node);
        if (typeof commitFn === 'function') commitFn(node);
      } catch (e) {
        throw new Error('add/commit failed: ' + (e && e.message ? e.message : String(e)));
      }

      // wait loop: prefer runtime.goals() if available
      const start = Date.now();
      let lastRemaining = null;
      let stableCount = 0;

      while (true) {
        // 1) precise path: goals()
        try {
          const goalsFn = runtime.goals || (runtime.JsCoq && runtime.JsCoq.goals) || (window.jsCoq && window.jsCoq.goals);
          if (typeof goalsFn === 'function') {
            const g = goalsFn();
            if (g && Array.isArray(g.goals)) {
              const rem = g.goals.length;
              if (rem === lastRemaining) stableCount++; else { lastRemaining = rem; stableCount = 0; }
              if (stableCount >= 1) {
                const summaries = g.goals.map(x => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400));
                if (rem === 0 && !errorSeen && !admittedSeen) return { ok: true };
                return { ok: false, error: { remaining: rem, summaries, raw: captured.slice() } };
              }
            }
          }
        } catch (e) {
          /* ignore and fallback */
        }

        // 2) feedback/completion detection
        if (finishedFlag) {
          const all = captured.join('\n\n');
          const parsed = parseGoalsFromText(all);
          const rem = parsed && typeof parsed.remaining === 'number' ? parsed.remaining : (admittedSeen ? 0 : null);
          const summaries = parsed ? parsed.summaries : captured.slice(-6);
          if (rem === 0 && !errorSeen && !admittedSeen) return { ok: true };
          return { ok: false, error: { remaining: rem, summaries, raw: captured.slice() } };
        }

        // 3) timeout
        if (Date.now() - start > timeoutMs) {
          const parsed = parseGoalsFromText(captured.join('\n\n'));
          return { ok: false, error: { remaining: parsed ? parsed.remaining : lastRemaining, summaries: captured.slice(-6), raw: captured.slice(), timeout: true } };
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

    } finally {
      // restore handlers
      try { if ('onLog' in runtime) runtime.onLog = old.onLog; } catch (e) {}
      try { if ('onError' in runtime) runtime.onError = old.onError; } catch (e) {}
      try { if ('onMessage' in runtime) runtime.onMessage = old.onMessage; } catch (e) {}
      try { if ('onFeedback' in runtime) runtime.onFeedback = old.onFeedback; } catch (e) {}
      releaseLock();
    }
  }

  CoqRunner.checkProofText = checkProofText;

  // convenience global
  if (!global.CoqRunner) global.CoqRunner = CoqRunner;
  if (!global.checkProofText) global.checkProofText = async (text, opts) => await CoqRunner.checkProofText(text, opts);

})(window);

/* Example:
(async () => {
  const res = await checkProofText(`Theorem t : 1 = 1. Proof. reflexivity. Qed.`);
  console.log(res);
})();
*/