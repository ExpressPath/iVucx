// checkProofText.js
// Usage: const res = await checkProofText(coqText, opts);
// opts optional: { cdnUrl, timeoutMs, pollMs, basePathSuffix }
// Default CDN/version chosen to match common jsCoq bundle.

async function checkProofText(text, opts = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be string');

  const CDN = opts.cdnUrl || 'https://cdn.jsdelivr.net/npm/jscoq@8.20.0/dist/jscoq.js';
  const basePath = (opts.basePathSuffix === undefined)
    ? 'https://cdn.jsdelivr.net/npm/jscoq@8.20.0/dist/' 
    : opts.basePathSuffix;
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
  const pollMs = typeof opts.pollMs === 'number' ? opts.pollMs : 50;

  // --- simple module-level cache (persist across calls) ---
  window.__checkProofText_cache = window.__checkProofText_cache || {};
  const cache = window.__checkProofText_cache;

  // load jsCoq script if needed
  async function ensureJsCoq() {
    if (window.jsCoq && cache.sid) return;
    if (!cache._loading) {
      cache._loading = (async () => {
        if (!window.jsCoq) {
          await new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = CDN;
            s.onload = () => res();
            s.onerror = (e) => rej(new Error('failed to load jsCoq script: ' + CDN));
            document.head.appendChild(s);
          });
        }
        // init jsCoq if not inited
        if (!cache.sid) {
          if (!window.jsCoq || typeof window.jsCoq.init !== 'function') {
            throw new Error('jsCoq not available after loading script');
          }
          // try init; use safe options
          cache.sid = window.jsCoq.init({
            base_path_: basePath,
            init_pkgs: ['init'],
            all_pkgs: true
          });
        }
      })();
    }
    return cache._loading;
  }

  // simple serialization: avoid concurrent commits that confuse handlers
  async function acquireBusy() {
    while (cache._busy) await new Promise(r => setTimeout(r, 20));
    cache._busy = true;
  }
  function releaseBusy() { cache._busy = false; }

  await ensureJsCoq();
  await acquireBusy();

  // capture state
  const jsCoq = window.jsCoq;
  const sid = cache.sid;
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

  // save old handlers then install ours (restore in finally)
  const old = { onLog: jsCoq.onLog, onError: jsCoq.onError, onMessage: jsCoq.onMessage, onFeedback: jsCoq.onFeedback };
  try {
    try { jsCoq.onLog = capturePayload; } catch (e) {}
    try { jsCoq.onError = capturePayload; } catch (e) {}
    try { jsCoq.onMessage = capturePayload; } catch (e) {}
    try { jsCoq.onFeedback = capturePayload; } catch (e) {}

    // send the code
    let node;
    try {
      node = jsCoq.add(sid, -1, text);
      if (typeof jsCoq.edit === 'function') jsCoq.edit(node);
      if (typeof jsCoq.commit === 'function') jsCoq.commit(node);
    } catch (e) {
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
            // require small stability to avoid transient reads
            if (stableCount >= 1) {
              const summaries = g.goals.map(x => (typeof x === 'string' ? x : JSON.stringify(x)).slice(0, 400));
              if (rem === 0 && !errorSeen && !admittedSeen) return { ok: true, error: null };
              return { ok: false, error: { remaining: rem, summaries, raw: captured.slice() } };
            }
          }
        }
      } catch (e) {
        // ignore and fallback to feedback detection
      }

      // 2) feedback/completion detection
      if (finishedFlag) {
        const all = captured.join('\n');
        const m = all.match(/(\d+)\s+(?:subgoals?|goals?)/i);
        const rem = m ? Number(m[1]) : (admittedSeen ? 0 : null);
        const summaries = captured.slice(-6);
        if (rem === 0 && !errorSeen && !admittedSeen) return { ok: true, error: null };
        return { ok: false, error: { remaining: rem, summaries, raw: captured.slice() } };
      }

      // 3) timeout
      if (Date.now() - start > timeoutMs) {
        return { ok: false, error: { remaining: lastRemaining, summaries: captured.slice(-6), raw: captured.slice(), timeout: true } };
      }

      await new Promise(r => setTimeout(r, pollMs));
    }

  } finally {
    // restore handlers and release busy lock
    try { jsCoq.onLog = old.onLog; } catch (e) {}
    try { jsCoq.onError = old.onError; } catch (e) {}
    try { jsCoq.onMessage = old.onMessage; } catch (e) {}
    try { jsCoq.onFeedback = old.onFeedback; } catch (e) {}
    releaseBusy();
  }
}

// --- example usage ---
// (1) await checkProofText(coqSource) to block until finished
// (2) returns { ok: true } or { ok: false, error: { remaining, summaries, raw, timeout? } }

// Example:
// (async () => {
//   const src = `Theorem t : 1 = 2. Proof. reflexivity. Qed.`;
//   const res = await checkProofText(src);
//   console.log(res);
// })();