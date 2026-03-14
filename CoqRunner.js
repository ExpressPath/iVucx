// CoqRunner.js — local jsCoq (jscoq-0.17.1) friendly proof checker
// Exposes global `CoqRunner.checkProofText(text, opts)` returning a Promise that resolves to:
//  { ok: true } or { ok: false, error: { remaining, summaries, raw, timeout? } }

// NOTE: This file is designed to prefer local ./jscoq/* copies of jsCoq (for GitHub Pages).
// It will try multiple candidate paths and initialize jsCoq once.

(function(global){
  const CoqRunner = {};
  // internal cache across calls
  const cache = { initing: null, sid: null, busy: false, scriptSrc: null };

  // try loading a script, return loaded src
  function loadScript(src){
    return new Promise((resolve, reject) => {
      // already loaded?
      if (document.querySelector('script[data-src="'+src+'"]') || (window.jsCoq && cache.scriptSrc === src)) {
        return resolve(src);
      }
      const s = document.createElement('script');
      s.dataset.src = src;
      s.src = src;
      s.async = true;
      s.onload = () => { cache.scriptSrc = src; resolve(src); };
      s.onerror = () => reject(new Error('failed to load script: ' + src));
      document.head.appendChild(s);
    });
  }

  // try a list of candidate script paths sequentially
  async function tryLoadLocalJsCoq() {
    // candidate locations relative to repo root (common layouts)
    const candidates = [
      './jscoq/jscoq.js',
      './jscoq-0.17.1/jscoq.js',
      './jscoq/jscoq-0.17.1/jscoq.js',
      './jscoq/dist/jscoq.js'
    ];
    for (const c of candidates) {
      try {
        await loadScript(c);
        return c;
      } catch (e) {
        // try next
      }
    }
    // if none succeeded, throw
    throw new Error('failed to load local jsCoq; put jscoq bundle under ./jscoq/ or ./jscoq-0.17.1/');
  }

  // ensure jsCoq is loaded and initialized; returns { jsCoq, sid, basePath }
  async function ensureJsCoq(opts = {}) {
    if (cache.sid && window.jsCoq) return { jsCoq: window.jsCoq, sid: cache.sid, basePath: cache.basePath };
    if (!cache.initing) {
      cache.initing = (async () => {
        // 1) try local copies first
        let scriptSrc;
        try {
          scriptSrc = await tryLoadLocalJsCoq();
        } catch (e) {
          // fallback: try CDN (last resort)
          const cdn = opts.cdnUrl || 'https://cdn.jsdelivr.net/npm/jscoq@0.17.1/dist/jscoq.js';
          try {
            await loadScript(cdn);
            scriptSrc = cdn;
          } catch (e2) {
            throw new Error('failed to load jsCoq from local and CDN');
          }
        }
        // determine base path from scriptSrc (strip "jscoq.js")
        const basePath = scriptSrc.replace(/jscoq\.js(\?.*)?$/i, '');

        window.jsCoq = window.jsCoq || window.JsCoq || window.JSCoq || window.jscoq;

        if (!window.jsCoq || typeof window.jsCoq.init !== 'function') {
          throw new Error('jsCoq is not available after loading script');
        }
        // init with safe defaults; use local basePath
        const sid = window.jsCoq.init({
          base_path_: basePath,
          init_pkgs: ['init'],
          all_pkgs: true
        });
        cache.sid = sid;
        cache.basePath = basePath;
        return { jsCoq: window.jsCoq, sid, basePath };
      })();
    }
    return cache.initing;
  }

  // simple lock to serialize commits (avoid concurrency)
  async function acquireLock() {
    while (cache.busy) await new Promise(r => setTimeout(r,20));
    cache.busy = true;
  }
  function releaseLock(){ cache.busy = false; }

  // core check function (awaits until finish)
  async function checkProofText(text, opts = {}) {
    if (typeof text !== 'string') throw new TypeError('text must be string');
    const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
    const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 50;

    const { jsCoq, sid } = await ensureJsCoq(opts);
    await acquireLock();

    const captured = [];
    let finishedFlag = false;
    let admittedSeen = false;
    let errorSeen = false;

    function capturePayload(p){
      const s = (typeof p === 'string') ? p : (() => { try { return JSON.stringify(p); } catch(e){ return String(p); }})();
      captured.push(s);
      const low = s.toLowerCase();
      if (/\badmitted\b/.test(low)) admittedSeen = true;
      if (/\berror\b|\bfail(ed)?\b/.test(low)) errorSeen = true;
      if (/\b(no more subgoals|proof completed|qed|completed|done)\b/.test(low)) finishedFlag = true;
    }

    // save old handlers and install ours as safely as possible
    const old = { onLog: jsCoq.onLog, onError: jsCoq.onError, onMessage: jsCoq.onMessage, onFeedback: jsCoq.onFeedback };
    try { try { jsCoq.onLog = capturePayload; } catch(e){} } catch(e){}
    try { try { jsCoq.onError = capturePayload; } catch(e){} } catch(e){}
    try { try { jsCoq.onMessage = capturePayload; } catch(e){} } catch(e){}
    try { try { jsCoq.onFeedback = capturePayload; } catch(e){} } catch(e){}

    try {
      // send code
      let node;
      try {
        node = jsCoq.add(sid, -1, text);
        if (typeof jsCoq.edit === 'function') jsCoq.edit(node);
        if (typeof jsCoq.commit === 'function') jsCoq.commit(node);
      } catch(e){
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
                const summaries = g.goals.map(x => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0,400));
                if (rem === 0 && !errorSeen && !admittedSeen) return { ok: true };
                return { ok: false, error: { remaining: rem, summaries, raw: captured.slice() } };
              }
            }
          }
        } catch(e){
          // ignore, fall back to feedback
        }

        // 2) feedback/completion detection
        if (finishedFlag) {
          const all = captured.join('\n');
          const m = all.match(/(\d+)\s+(?:subgoals?|goals?)/i);
          const rem = m ? Number(m[1]) : (admittedSeen ? 0 : null);
          const summaries = captured.slice(-6);
          if (rem === 0 && !errorSeen && !admittedSeen) return { ok: true };
          return { ok: false, error: { remaining: rem, summaries, raw: captured.slice() } };
        }

        // 3) timeout
        if (Date.now() - start > timeoutMs) {
          return { ok: false, error: { remaining: lastRemaining, summaries: captured.slice(-6), raw: captured.slice(), timeout: true } };
        }

        await new Promise(r => setTimeout(r, pollMs));
      }

    } finally {
      // restore handlers and release lock
      try { jsCoq.onLog = old.onLog; } catch(e){}
      try { jsCoq.onError = old.onError; } catch(e){}
      try { jsCoq.onMessage = old.onMessage; } catch(e){}
      try { jsCoq.onFeedback = old.onFeedback; } catch(e){}
      releaseLock();
    }
  }

  CoqRunner.checkProofText = checkProofText;

  // export to global
  global.CoqRunner = CoqRunner;

})(window);

/* Usage:
  // ensure this script is included on your page AFTER the jscoq bundle is present or so it can auto-load it.
  (async () => {
    const text = `Theorem t : 1 = 2. Proof. reflexivity. Qed.`;
    const res = await CoqRunner.checkProofText(text, { timeoutMs: 20000 });
    console.log(res);
  })();
*/