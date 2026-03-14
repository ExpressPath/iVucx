// CoqRunner.js — robust single-file loader + proof checker
// Usage: await CoqRunner.checkProofText(coqSource [, opts])
// opts: { timeoutMs, pollMs, candidates }.
// Place this file in your repo and ensure ./jscoq/... contains the built bundle (jscoq.js + dist/frontend + coq-worker.js).

(function (global) {
  const CoqRunner = {};
  const cache = { initting: null, sid: null, basePath: null, busy: false, scriptUrl: null };

  // sensible default candidates (local-first)
  const DEFAULT_CANDIDATES = [
    './jscoq/jscoq.js',
    './jscoq/dist/jscoq.js',
    './jscoq/package/dist/jscoq.js',
    './jscoq-0.17.1/dist/jscoq.js',
    // last resort (network)
    'https://cdn.jsdelivr.net/npm/jscoq@0.17.1/dist/jscoq.js'
  ];

  // helper: fetch text safely
  async function tryFetchText(url) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error('bad status ' + r.status);
      return await r.text();
    } catch (e) {
      return null;
    }
  }

  // load script: UMD by script tag, module by dynamic import or script[type=module]
  async function loadBundle(url, asModuleHint) {
    // if we already loaded this url, resolve
    if (cache.scriptUrl === url && (window.jsCoq || window.JsCoq || window.JSCoq)) return url;

    // if the fetched content looks like module (starts with 'export' or contains "export ")
    const text = await tryFetchText(url);
    if (text === null) throw new Error('fetch failed: ' + url);

    const looksModule = /^\s*export\s+/i.test(text) || /\bexport\s+\*/.test(text) || asModuleHint;

    if (looksModule) {
      // dynamic import: convert to absolute blob URL to allow CORS-free import
      try {
        const blob = new Blob([text], { type: 'text/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const mod = await import(/* webpackIgnore: true */ blobUrl);
        URL.revokeObjectURL(blobUrl);

        // if module exported init or default that has init, normalize it
        if (mod && typeof mod.init === 'function') {
          window.jsCoq = mod;
        } else if (mod && mod.default && typeof mod.default.init === 'function') {
          window.jsCoq = mod.default;
        } else {
          // module may re-export to window internally (check)
          const found = findJsCoqGlobal();
          if (!found) {
            throw new Error('module loaded but no jsCoq export found');
          }
          window.jsCoq = found.lib;
        }
        cache.scriptUrl = url;
        return url;
      } catch (e) {
        throw new Error('dynamic import failed: ' + e.message);
      }
    } else {
      // UMD path: insert script tag (non-module)
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script load error: ' + url));
        document.head.appendChild(s);
      });
      // try to find jsCoq global
      const found = findJsCoqGlobal();
      if (!found) throw new Error('script loaded but no jsCoq global found: ' + url);
      window.jsCoq = found.lib;
      cache.scriptUrl = url;
      return url;
    }
  }

  // find any global object with init()
  function findJsCoqGlobal() {

    if (window.jsCoq && window.jsCoq.JsCoq) {
      return { name: "jsCoq", lib: window.jsCoq.JsCoq };
    }

    try {
      const keys = Object.keys(window);
      for (const k of keys) {
        if (k.toLowerCase().includes('coq')) {
          const v = window[k];
          if (v && typeof v.init === 'function') return { name: k, lib: v };
        }
      }
    } catch (e) { /* ignore */ }
    // known variants
    const variants = ['jsCoq', 'JsCoq', 'JSCoq', 'jscoq'];
    for (const v of variants) {
      if (window[v] && typeof window[v].init === 'function') return { name: v, lib: window[v] };
    }
    return null;
  }

  // ensure jsCoq loaded & initialized; returns { jsCoq, sid, basePath }
  async function ensureJsCoq(opts = {}) {
    if (cache.sid && window.jsCoq) return { jsCoq: window.jsCoq, sid: cache.sid, basePath: cache.basePath };
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
            // try next
          }
        }
        if (!chosen) throw new Error('failed to load jsCoq bundle: ' + (lastErr && lastErr.message));
        // determine basePath from chosen url (strip final filename)
        let basePath = chosen.replace(/\/?jscoq\.js(\?.*)?$/i, '');
        if (!basePath || !basePath.endsWith('/')) basePath = basePath + '/';
        // find global again robustly
        const found = findJsCoqGlobal();
        if (!found) throw new Error('no jsCoq global after loading bundle');
        window.jsCoq = found.lib; // normalize
        
        
        // init
        const api = window.jsCoq.JsCoq || window.jsCoq;
        if (typeof api.init !== 'function') {
          throw new Error('jsCoq found but no init()');
        }
        cache.sid = (api.start || api.init)({ base_path_: basePath, init_pkgs: ['init'], all_pkgs: true });
        
        
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
    // extract snippets around "subgoal" or "Goal"
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

    // backup handlers
    const old = { onLog: jsCoQ_safe(jsCoq, 'onLog'), onError: jsCoQ_safe(jsCoq, 'onError'), onMessage: jsCoQ_safe(jsCoq, 'onMessage'), onFeedback: jsCoQ_safe(jsCoq, 'onFeedback') };
    // install capture handlers as possible
    try { if ('onLog' in jsCoq) jsCoq.onLog = capturePayload; } catch (e) {}
    try { if ('onError' in jsCoq) jsCoq.onError = capturePayload; } catch (e) {}
    try { if ('onMessage' in jsCoq) jsCoq.onMessage = capturePayload; } catch (e) {}
    try { if ('onFeedback' in jsCoq) jsCoq.onFeedback = capturePayload; } catch (e) {}

    try {
      // send code
      let node;
      try {
        node = jsCoq.add(sid, -1, text);
        if (typeof jsCoq.edit === 'function') jsCoq.edit(node);
        if (typeof jsCoq.commit === 'function') jsCoq.commit(node);
      } catch (e) {
        // immediate add/commit error
        throw new Error('add/commit failed: ' + (e && e.message ? e.message : String(e)));
      }

      // wait loop: prefer jsCoq.goals() if available
      const start = Date.now();
      let lastRemaining = null;
      let stableCount = 0;

      while (true) {
        // 1) precise path: jsCoq.goals()
        try {
          if (typeof jsCoq.goals === 'function') {
            const g = jsCoq.goals();
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
      try { if ('onLog' in jsCoq) jsCoq.onLog = old.onLog; } catch (e) {}
      try { if ('onError' in jsCoq) jsCoq.onError = old.onError; } catch (e) {}
      try { if ('onMessage' in jsCoq) jsCoq.onMessage = old.onMessage; } catch (e) {}
      try { if ('onFeedback' in jsCoq) jsCoq.onFeedback = old.onFeedback; } catch (e) {}
      releaseLock();
    }
  }

  // safe getter for jsCoq handlers (may be undefined)
  function jsCoQ_safe(jsCoqObj, prop) {
    try { return jsCoqObj && jsCoqObj[prop]; } catch (e) { return undefined; }
  }

  CoqRunner.checkProofText = checkProofText;

  // expose convenience global if not present
  if (!global.CoqRunner) global.CoqRunner = CoqRunner;
  if (!global.checkProofText) global.checkProofText = async (text, opts) => await CoqRunner.checkProofText(text, opts);

})(window);

/* Example usage (editor.html or console):
(async () => {
  const src = `Theorem t : 1 = 2. Proof. reflexivity. Qed.`;
  const res = await CoqRunner.checkProofText(src, { timeoutMs: 20000 });
  console.log(res);
})();
*/