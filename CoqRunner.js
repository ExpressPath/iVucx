// CoqRunner.js
// Usage: await CoqRunner.checkProofText(coqSource [, opts])
// opts: { timeoutMs, pollMs, candidates }

(function (global) {
  const CoqRunner = {};
  const cache = { initting: null, manager: null, basePath: null, busy: false, scriptUrl: null, jsCoqLib: null, workerShim: false };

  const WRAPPER_ID = 'coq-runner-wrapper';
  const SNIPPET_ID = 'coq-runner-snippet';

  const DEFAULT_CANDIDATES = [
    'https://cdn.jsdelivr.net/npm/jscoq@0.17.1/jscoq.js',
    'https://unpkg.com/jscoq@0.17.1/jscoq.js'
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
    if (cache.jsCoqLib && (typeof cache.jsCoqLib.init === 'function' || typeof cache.jsCoqLib.start === 'function')) {
      return { name: 'cache.jsCoqLib', lib: cache.jsCoqLib };
    }
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

    let importErr = null;
    try {
      const mod = await withAmdDisabled(async () => {
        return await import(/* webpackIgnore: true */ absUrl);
      });
      const candidate = mod.JsCoq || (mod.default && mod.default.JsCoq) || mod.default || mod;
      if (candidate && (typeof candidate.init === 'function' || typeof candidate.start === 'function')) {
        cache.jsCoqLib = candidate;
        window.jsCoq = candidate;
        cache.scriptUrl = absUrl;
        return absUrl;
      }
    } catch (e) {
      importErr = e;
    }

    if (importErr) {
      const msg = importErr && importErr.message ? importErr.message : String(importErr);
      throw new Error('module import failed: ' + msg);
    }

    throw new Error('module import failed: unknown error');
  }

  async function withAmdDisabled(fn) {
    const saved = {
      define: window.define,
      require: window.require,
      requirejs: window.requirejs
    };
    try {
      window.define = undefined;
      window.require = undefined;
      window.requirejs = undefined;
      return await fn();
    } finally {
      window.define = saved.define;
      window.require = saved.require;
      window.requirejs = saved.requirejs;
    }
  }

  async function checkUrlExists(url) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) return true;
      if (res.status === 405 || res.status === 501) {
        const res2 = await fetch(url, { method: 'GET', cache: 'no-store' });
        return res2.ok;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  async function pickBackend(basePath) {
    const jsWorker = new URL('backend/jsoo/jscoq_worker.bc.js', basePath).href;
    const jsOk = await checkUrlExists(jsWorker);
    if (jsOk) {
      return { backend: 'js' };
    }

    const waWorker = new URL('dist/wacoq_worker.js', basePath).href;
    const waBc = new URL('backend/wasm/wacoq_worker.bc', basePath).href;
    const [waOk, waBcOk] = await Promise.all([
      checkUrlExists(waWorker),
      checkUrlExists(waBc)
    ]);

    if (waOk && waBcOk) {
      return { backend: 'wa' };
    }

    const missing = [];
    missing.push(jsWorker);
    if (!waOk) missing.push(waWorker);
    if (!waBcOk) missing.push(waBc);
    throw new Error('Missing jsCoq assets: ' + missing.join(', '));
  }

  async function resolveAssetRoot(scriptBase) {
    const normalized = scriptBase.endsWith('/') ? scriptBase : scriptBase + '/';
    const baseSet = new Set([
      normalized,
      normalized.endsWith('package/') ? normalized.slice(0, -8) : normalized + 'package/'
    ]);

    const tried = [];
    for (const base of baseSet) {
      const baseAbs = resolveUrl(base);
      const jsWorker = new URL('backend/jsoo/jscoq_worker.bc.js', baseAbs).href;
      const jsOk = await checkUrlExists(jsWorker);
      tried.push({ base: baseAbs, jsWorker, jsOk });
      if (jsOk) return { basePath: baseAbs };
    }

    const detail = tried.map((t) => {
      return t.base + ' -> jsWorker=' + (t.jsOk ? 'ok' : 'missing');
    }).join(' | ');

    throw new Error('Missing jsCoq assets for any base path. Tried: ' + detail);
  }

  async function resolvePkgPath(scriptBase, assetBase) {
    const normalized = scriptBase.endsWith('/') ? scriptBase : scriptBase + '/';
    const rootBase = normalized.endsWith('package/') ? normalized.slice(0, -8) : normalized;
    const candidates = [
      rootBase + 'coq-pkgs/',
      (assetBase.endsWith('/') ? assetBase : assetBase + '/') + 'coq-pkgs/'
    ];

    for (const base of candidates) {
      const baseAbs = resolveUrl(base);
      const coqJson = new URL('coq.json', baseAbs).href;
      if (await checkUrlExists(coqJson)) {
        return baseAbs.replace(/\/+$/, '');
      }
    }

    return null;
  }

  function ensureWorkerShim() {
    if (cache.workerShim) return;
    if (typeof window === 'undefined' || typeof window.Worker !== 'function') return;
    const OriginalWorker = window.Worker;
    const shim = function WorkerShim(url, opts) {
      try {
        const href = url instanceof URL ? url.href : String(url);
        const u = new URL(href, window.location.href);
        const sameOrigin = u.origin === window.location.origin;
        const isJsCoqWorker = /jscoq_worker\.bc\.js|wacoq_worker\.js/.test(u.pathname);
        if (!sameOrigin && isJsCoqWorker) {
          const blob = new Blob([`importScripts(${JSON.stringify(u.href)});`], { type: 'application/javascript' });
          const blobUrl = URL.createObjectURL(blob);
          const worker = new OriginalWorker(blobUrl);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
          return worker;
        }
      } catch (e) {
        // fall back to native Worker
      }
      return new OriginalWorker(url, opts);
    };
    shim.prototype = OriginalWorker.prototype;
    window.Worker = shim;
    cache.workerShim = true;
  }

  function attachGoalSpy(manager) {
    if (manager.__coqRunnerGoalSpy) return;
    manager.__coqRunnerGoalSpy = true;
    manager.__coqRunnerLastGoals = null;
    manager.__coqRunnerLastGoalsAt = 0;
    manager.__coqRunnerGoalInfoSeen = false;

    const record = (goals) => {
      manager.__coqRunnerLastGoals = goals;
      manager.__coqRunnerLastGoalsAt = Date.now();
      manager.__coqRunnerGoalInfoSeen = true;
    };

    let observed = false;
    if (manager.coq && Array.isArray(manager.coq.observers)) {
      manager.coq.observers.push({
        coqGoalInfo: function (sid, goals) { record(goals); }
      });
      observed = true;
    }

    if (!observed && typeof manager.coqGoalInfo === 'function') {
      const original = manager.coqGoalInfo.bind(manager);
      manager.coqGoalInfo = function (sid, goals) {
        record(goals);
        return original(sid, goals);
      };
    }
  }

  function attachFeedbackSpy(manager) {
    if (manager.__coqRunnerFeedbackSpy) return;
    manager.__coqRunnerFeedbackSpy = true;
    manager.__coqRunnerFeedback = [];
    if (manager.coq && Array.isArray(manager.coq.observers)) {
      manager.coq.observers.push({
        feedMessage: function (sid, lvl, loc, msg) {
          const level = Array.isArray(lvl) ? lvl[0] : lvl;
          if (level !== 'Error' && level !== 'Warning') return;
          manager.__coqRunnerFeedback.push({ sid, level, loc, msg });
        }
      });
    }
  }

  function coqExnToText(manager, payload) {
    if (!payload) return 'Coq exception';
    try {
      if (payload.pp && manager && manager.pprint && typeof manager.pprint.pp2Text === 'function') {
        const text = manager.pprint.pp2Text(payload.pp);
        if (text) return text;
      }
    } catch (e) {}
    if (payload.msg) return stringifyCoqPayload(payload.msg);
    return stringifyCoqPayload(payload);
  }

  function attachExceptionSpy(manager) {
    if (manager.__coqRunnerExnSpy) return;
    manager.__coqRunnerExnSpy = true;
    manager.__coqRunnerCoqExnMessages = [];
    manager.__coqRunnerJsonExnMessages = [];

    if (typeof manager.coqCoqExn === 'function') {
      const original = manager.coqCoqExn.bind(manager);
      manager.coqCoqExn = function (payload) {
        try {
          const msg = coqExnToText(manager, payload);
          if (msg) manager.__coqRunnerCoqExnMessages.push(msg);
          markRestart(manager);
        } catch (e) {}
        return original(payload);
      };
    }
    if (typeof manager.coqJsonExn === 'function') {
      const original = manager.coqJsonExn.bind(manager);
      manager.coqJsonExn = function (payload) {
        try {
          const msg = coqExnToText(manager, payload);
          if (msg) manager.__coqRunnerJsonExnMessages.push(msg);
          markRestart(manager);
        } catch (e) {}
        return original(payload);
      };
    }
  }

  function formatLoc(loc) {
    if (!loc) return '';
    if (typeof loc === 'string') return loc;
    if (Array.isArray(loc)) {
      const parts = loc.map((item) => formatLoc(item)).filter(Boolean);
      if (parts.length) return parts.join('-');
    }
    if (typeof loc === 'object') {
      const line = loc.line ?? loc.line_nb ?? loc.line_nb;
      const col = loc.column ?? loc.col ?? loc.bp ?? loc.char_nb ?? loc.char;
      if (Number.isFinite(line)) {
        if (Number.isFinite(col)) return String(line) + ':' + String(col);
        return String(line);
      }
    }
    try {
      return JSON.stringify(loc);
    } catch (e) {
      return String(loc);
    }
  }

  function feedbackMsgToText(manager, msg) {
    if (!msg) return '';
    try {
      if (manager && manager.pprint && typeof manager.pprint.pp2Text === 'function') {
        const text = manager.pprint.pp2Text(msg);
        if (text) return text;
      }
    } catch (e) {}
    try {
      return JSON.stringify(msg);
    } catch (e) {
      return String(msg);
    }
  }

  function collectFeedback(manager) {
    const out = { errors: [], warnings: [] };
    const seen = new Set();
    const sentences = manager && manager.doc && Array.isArray(manager.doc.sentences) ? manager.doc.sentences : [];
    for (const stm of sentences) {
      if (!stm || !Array.isArray(stm.feedback)) continue;
      for (const fb of stm.feedback) {
        if (!fb || !fb.level) continue;
        const level = String(fb.level);
        if (level !== 'Error' && level !== 'Warning') continue;
        const msgText = feedbackMsgToText(manager, fb.msg);
        const locText = formatLoc(fb.loc);
        const full = (locText ? locText + ' ' : '') + (msgText || '(no message)');
        const key = level + '|' + String(stm.coq_sid || '') + '|' + full;
        if (seen.has(key)) continue;
        seen.add(key);
        if (level === 'Error') out.errors.push(full);
        else out.warnings.push(full);
      }
    }
    const extra = manager && Array.isArray(manager.__coqRunnerFeedback) ? manager.__coqRunnerFeedback : [];
    for (const fb of extra) {
      if (!fb || !fb.level) continue;
      const level = String(fb.level);
      if (level !== 'Error' && level !== 'Warning') continue;
      const msgText = feedbackMsgToText(manager, fb.msg);
      const locText = formatLoc(fb.loc);
      const full = (locText ? locText + ' ' : '') + (msgText || '(no message)');
      const key = level + '|' + String(fb.sid || '') + '|' + full;
      if (seen.has(key)) continue;
      seen.add(key);
      if (level === 'Error') out.errors.push(full);
      else out.warnings.push(full);
    }
    return out;
  }

  function buildRunDetails(manager, goalsCount) {
    const processedCount = manager && manager.doc && Array.isArray(manager.doc.sentences)
      ? Math.max(0, manager.doc.sentences.length - 1)
      : null;
    const last = manager && typeof manager.lastAdded === 'function' ? manager.lastAdded() : null;
    const goalRaw = manager ? manager.__coqRunnerLastGoals : null;
    const goalInfoSeen = !!(manager && manager.__coqRunnerGoalInfoSeen);
    let editorMode = null;
    try {
      const snippet = manager && manager.provider && manager.provider.snippets && manager.provider.snippets[0];
      const modeOpt = snippet && snippet.editor && typeof snippet.editor.getOption === 'function'
        ? snippet.editor.getOption('mode')
        : null;
      if (typeof modeOpt === 'string') editorMode = modeOpt;
      else if (modeOpt && typeof modeOpt === 'object' && typeof modeOpt.name === 'string') editorMode = modeOpt.name;
      else if (modeOpt) editorMode = String(modeOpt);
    } catch (e) {}
    const details = {
      processedCount,
      lastSid: last && last.coq_sid ? last.coq_sid : null,
      goalInfoSeen,
      goalInfoEmpty: goalInfoSeen && (goalRaw === null || goalRaw === undefined),
      goalsRawType: goalRaw === null ? 'null' : Array.isArray(goalRaw) ? 'array' : typeof goalRaw,
      goalsRawCount: typeof goalsCount === 'number' ? goalsCount : null,
      editorMode,
      bundleUrl: cache.scriptUrl || null,
      assetBase: cache.basePath || null
    };
    if (manager && Array.isArray(manager.__coqRunnerCoqExnMessages) && manager.__coqRunnerCoqExnMessages.length) {
      details.coqExceptions = manager.__coqRunnerCoqExnMessages.slice(0, 5);
    }
    if (manager && Array.isArray(manager.__coqRunnerJsonExnMessages) && manager.__coqRunnerJsonExnMessages.length) {
      details.jsonExceptions = manager.__coqRunnerJsonExnMessages.slice(0, 5);
    }
    const feedback = collectFeedback(manager);
    if (feedback.errors.length) details.errors = feedback.errors;
    if (feedback.warnings.length) details.warnings = feedback.warnings;
    return details;
  }

  function analyzeInputText(text) {
    const content = String(text || '');
    const lines = content.split(/\r?\n/);
    let nonEmptyLines = 0;
    let bulletLines = 0;
    let linesEndingWithPeriod = 0;
    for (const line of lines) {
      if (/\S/.test(line)) nonEmptyLines += 1;
      if (/^\s*[-+*]\s+\S/.test(line)) bulletLines += 1;
      if (/\.\s*$/.test(line)) linesEndingWithPeriod += 1;
    }
    const asciiPeriodCount = (content.match(/\./g) || []).length;
    const fullWidthPeriodCount = (content.match(/[。．｡]/g) || []).length;
    const hasQedLike = /\b(Qed|Defined|Admitted|Abort)\b/.test(content);
    const hasQedDot = /\b(Qed|Defined|Admitted|Abort)\b\s*\./.test(content);
    const hasProofLike = /\b(Goal|Theorem|Lemma|Proof)\b/.test(content);
    const commentScan = scanCoqComments(content);
    return {
      length: content.length,
      nonEmptyLines,
      asciiPeriodCount,
      fullWidthPeriodCount,
      bulletLines,
      hasQedLike,
      hasQedDot,
      linesEndingWithPeriod,
      hasProofLike,
      commentDepth: commentScan.depth,
      extraCommentClosers: commentScan.extraClose
    };
  }

  function splitCoqSentences(text) {
    const src = String(text || '');
    const out = [];
    let i = 0;
    let start = 0;
    let depth = 0;
    let inString = false;
    let lineSawNonSpace = false;

    const pushSlice = (from, to) => {
      const slice = src.slice(from, to);
      if (/\S/.test(slice)) out.push(slice);
    };

    while (i < src.length) {
      const ch = src[i];
      const next = i + 1 < src.length ? src[i + 1] : '';

      if (ch === '\n') {
        lineSawNonSpace = false;
        i += 1;
        continue;
      }

      if (inString) {
        if (ch === '"' && src[i - 1] !== '\\') inString = false;
        i += 1;
        continue;
      }

      if (depth > 0) {
        if (ch === '(' && next === '*') {
          depth += 1;
          i += 2;
          continue;
        }
        if (ch === '*' && next === ')') {
          depth -= 1;
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }

      if (!lineSawNonSpace) {
        if (ch === ' ' || ch === '\t' || ch === '\r') {
          i += 1;
          continue;
        }
        lineSawNonSpace = true;
        if (ch === '-' || ch === '+' || ch === '*' || ch === '{' || ch === '}') {
          // Flush any pending sentence before the bullet.
          if (i > start) pushSlice(start, i);
          let j = i;
          if (ch === '{' || ch === '}') {
            j = i + 1;
          } else {
            while (j < src.length && (src[j] === '-' || src[j] === '+' || src[j] === '*')) j++;
          }
          pushSlice(i, j);
          start = j;
          i = j;
          continue;
        }
      }

      if (ch === '"') {
        inString = true;
        i += 1;
        continue;
      }

      if (ch === '(' && next === '*') {
        depth = 1;
        i += 2;
        continue;
      }

      if (ch === '.') {
        const after = i + 1 < src.length ? src[i + 1] : '';
        if (after === '' || /\s/.test(after)) {
          pushSlice(start, i + 1);
          start = i + 1;
          i += 1;
          continue;
        }
      }

      i += 1;
    }

    return out;
  }

  async function execSentencesFallback(text, manager, timeoutMs) {
    const coq = manager && manager.coq;
    if (!coq || typeof coq.add !== 'function' || typeof coq.execPromise !== 'function') {
      throw new Error('jsCoq worker is unavailable for fallback execution');
    }

    manager.__coqRunnerFeedback = [];
    await resetManagerDoc(manager, timeoutMs);

    const sentences = splitCoqSentences(text);
    let sid = 2;
    let executed = 0;
    for (const sentence of sentences) {
      if (!/\S/.test(sentence)) continue;
      coq.add(1, sid, sentence);
      const execP = coq.execPromise(sid);
      await Promise.race([
        execP,
        sleep(timeoutMs).then(() => { throw new Error('jsCoq execution timeout'); })
      ]);
      executed += 1;
      const feedback = collectFeedback(manager);
      if (feedback.errors.length > 0) break;
      sid += 1;
    }

    const lastSid = sid - 1;
    if (lastSid >= 2 && typeof coq.goals === 'function') {
      const goalRequestAt = Date.now();
      coq.goals(lastSid);
      await waitForGoalsUpdate(manager, goalRequestAt, 2000);
    }

    const goalsCount = countGoalsFromResponse(
      manager.__coqRunnerLastGoals,
      manager.__coqRunnerGoalInfoSeen
    );
    const feedback = collectFeedback(manager);
    const details = buildRunDetails(manager, goalsCount);
    details.fallbackUsed = true;
    details.fallbackSentenceCount = sentences.length;
    details.fallbackExecutedCount = executed;
    return { goalsCount, feedback, details };
  }

  function scanCoqComments(content) {
    let depth = 0;
    let extraClose = 0;
    let inString = false;
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      const next = i + 1 < content.length ? content[i + 1] : '';
      if (inString) {
        if (ch === '"' && content[i - 1] !== '\\') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '(' && next === '*') {
        depth += 1;
        i += 1;
        continue;
      }
      if (ch === '*' && next === ')') {
        if (depth > 0) depth -= 1;
        else extraClose += 1;
        i += 1;
      }
    }
    return { depth, extraClose };
  }

  function summarizeTokens(manager, maxLines = 200) {
    const summary = {
      lineCount: 0,
      scannedLines: 0,
      statementend: 0,
      coqBullet: 0,
      brace: 0,
      comment: 0,
      nullType: 0,
      topTypes: [],
      samples: []
    };

    try {
      const snippet = manager && manager.provider && manager.provider.snippets && manager.provider.snippets[0];
      const editor = snippet && snippet.editor;
      if (!editor || typeof editor.getLineTokens !== 'function') return summary;
      const doc = editor.getDoc();
      const lineCount = doc.lineCount();
      summary.lineCount = lineCount;
      const typeCounts = new Map();

      const pushSample = (lineNo, lineText, tokens) => {
        if (summary.samples.length >= 3) return;
        const trimmed = lineText.length > 120 ? lineText.slice(0, 120) + '…' : lineText;
        const tokenText = tokens.map(t => {
          const tstr = t.string || '';
          const tshort = tstr.length > 18 ? tstr.slice(0, 18) + '…' : tstr;
          return tshort + '/' + (t.type || 'none');
        }).join(' ');
        summary.samples.push('L' + lineNo + ': ' + trimmed + ' => ' + tokenText);
      };

      const limit = Math.min(lineCount, maxLines);
      for (let i = 0; i < limit; i++) {
        const lineText = doc.getLine(i);
        const tokens = editor.getLineTokens(i);
        summary.scannedLines += 1;
        if (lineText && /\S/.test(lineText)) {
          pushSample(i + 1, lineText, tokens);
        }
        for (const tok of tokens) {
          const type = tok.type || 'none';
          typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
          if (!tok.type) summary.nullType += 1;
          if (type.includes('comment')) summary.comment += 1;
          if (type.includes('statementend')) summary.statementend += 1;
          if (type.includes('coq-bullet')) summary.coqBullet += 1;
          if (type.includes('brace')) summary.brace += 1;
        }
      }

      const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
      summary.topTypes = sorted.slice(0, 6).map(([name, count]) => name + ':' + count);
    } catch (e) {
      return summary;
    }

    return summary;
  }

  function callJsCoq(startFn, basePath, ids, options, ctx) {
    const arity = typeof startFn.length === 'number' ? startFn.length : 0;
    if (arity <= 2) return startFn.call(ctx, ids, options);
    return startFn.call(ctx, basePath, ids, options);
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

            let scriptBase = absUrl.replace(/\/?[^/]*$/, '/');

            const found = findJsCoqGlobal();
            if (!found) throw new Error('no jsCoq global after loading bundle');
            const api = found.lib;
            ensureRunnerDom();

            const assetRoot = await resolveAssetRoot(scriptBase);
            const basePath = assetRoot.basePath;
            const pkgPath = await resolvePkgPath(scriptBase, basePath);
            const backendChoice = await pickBackend(basePath);
            const options = {
              wrapper_id: WRAPPER_ID,
              base_path: basePath,
              backend: backendChoice.backend,
              prelaunch: true,
              prelude: true,
              implicit_libs: true,
              debug: false,
              init_pkgs: ['init'],
              all_pkgs: ['coq'],
              show: false,
              focus: false,
              replace: false,
              editor: {
                mode: { name: 'coq', singleLineStringErrors: false }
              }
            };
            if (pkgPath) {
              options.pkg_path = pkgPath;
            }

            let manager;
            if (typeof api.start === 'function') {
              ensureWorkerShim();
              manager = await callJsCoq(api.start, basePath, [SNIPPET_ID], options, api);
            } else if (typeof api.init === 'function') {
              ensureWorkerShim();
              manager = await callJsCoq(api.init, basePath, [SNIPPET_ID], options, api);
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

        const list = candidates.join(', ');
        const lastMsg = lastErr && lastErr.message ? lastErr.message : String(lastErr);
        throw new Error('failed to load jsCoq bundle. Tried: ' + list + '. Last error: ' + lastMsg);
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

  async function waitForProviderReady(manager, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (manager && manager.provider && Array.isArray(manager.provider.snippets) && manager.provider.snippets.length > 0) {
        return true;
      }
      await sleep(50);
    }
    return false;
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

  function countGoalsFromResponse(res, goalInfoSeen) {
    if (res === null || res === undefined) return goalInfoSeen ? 0 : null;
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
        const nested = countGoalsFromResponse(item, goalInfoSeen);
        if (nested !== null) return nested;
      }
      return null;
    }
    if (typeof res === 'object') {
      if (Array.isArray(res.goals)) return res.goals.length;
      if (res.goals && typeof res.goals === 'object') {
        const nestedGoals = countGoalsFromResponse(res.goals, goalInfoSeen);
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
    attachFeedbackSpy(manager);
    attachExceptionSpy(manager);
    await acquireLock();

    try {
      manager.__coqRunnerLastGoals = null;
      manager.__coqRunnerLastGoalsAt = 0;
      manager.__coqRunnerGoalInfoSeen = false;
      if (manager.__coqRunnerCoqExnMessages) manager.__coqRunnerCoqExnMessages.length = 0;
      if (manager.__coqRunnerJsonExnMessages) manager.__coqRunnerJsonExnMessages.length = 0;

      const providerReady = await waitForProviderReady(manager, Math.min(5000, timeoutMs));
      if (!providerReady) {
        const details = buildRunDetails(manager, null);
        return {
          ok: false,
          details,
          error: {
            remaining: -1,
            summaries: ['Coq provider not ready (snippet missing).']
          }
        };
      }
      if (manager.provider && Array.isArray(manager.provider.snippets) && manager.provider.snippets[0]) {
        manager.provider.currentFocus = manager.provider.snippets[0];
      }

      if (!manager || !manager.provider || typeof manager.provider.load !== 'function') {
        throw new Error('jsCoq manager provider is unavailable');
      }
      if (manager.error && Array.isArray(manager.error)) manager.error.length = 0;

      const docName = 'Main_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.v';
      await resetManagerDoc(manager, timeoutMs);
      manager.provider.load(String(text || ''), docName);
      if (typeof manager.provider.focus === 'function') manager.provider.focus();

      const started = Date.now();
      let advancedAny = false;
      while (true) {
        const advanced = typeof manager.goNext === 'function' ? manager.goNext(false) : false;
        if (advanced) advancedAny = true;
        await waitForManagerIdle(manager, started, timeoutMs);
        if (manager.error && manager.error.length > 0) break;
        if (!advanced) break;
      }

      if (!advancedAny && /\S/.test(String(text || ''))) {
        const details = buildRunDetails(manager, null);
        details.input = analyzeInputText(text);
        details.tokenSummary = summarizeTokens(manager);
        const hints = [];
        if (details.input.asciiPeriodCount === 0) {
          if (details.input.fullWidthPeriodCount > 0) {
            hints.push('Found full-width period characters (。/．/｡). Replace with "."');
          } else {
            hints.push('No "." found. Coq sentences must end with "."');
          }
        }
        if (details.input.nonEmptyLines === 0) {
          hints.push('Input is empty or whitespace-only.');
        }
        if (details.input.asciiPeriodCount > 0 && details.editorMode !== 'coq') {
          hints.push('Editor mode is not Coq; tokenization may be missing.');
        }
        if (details.input.commentDepth > 0) {
          hints.push('Unclosed comment detected (missing "*)").');
        }
        if (details.input.extraCommentClosers > 0) {
          hints.push('Extra comment terminator detected ("*)").');
        }
        if (details.input.hasQedLike && !details.input.hasQedDot) {
          hints.push('Proof closer keyword is missing a terminating "." (e.g., "Qed.").');
        }
        if (details.input.linesEndingWithPeriod === 0 && details.input.asciiPeriodCount > 0) {
          hints.push('No line ends with "."; periods may only appear inside identifiers or numbers.');
        }

        const tokenMissing = details.tokenSummary &&
          details.tokenSummary.statementend === 0 &&
          details.tokenSummary.coqBullet === 0 &&
          details.tokenSummary.brace === 0 &&
          details.tokenSummary.comment === 0 &&
          details.tokenSummary.nullType > 0;

        if (tokenMissing) {
          try {
            const fallback = await execSentencesFallback(text, manager, timeoutMs);
            const goalsCount = fallback.goalsCount;
            const fb = fallback.feedback;
            const fallbackDetails = fallback.details;
            if ((fallbackDetails.coqExceptions && fallbackDetails.coqExceptions.length) ||
                (fallbackDetails.jsonExceptions && fallbackDetails.jsonExceptions.length)) {
              markRestart(manager);
              const summaries = [];
              if (fallbackDetails.coqExceptions) summaries.push(...fallbackDetails.coqExceptions);
              if (fallbackDetails.jsonExceptions) summaries.push(...fallbackDetails.jsonExceptions);
              return {
                ok: false,
                details: fallbackDetails,
                error: {
                  remaining: typeof goalsCount === 'number' ? goalsCount : -1,
                  summaries
                }
              };
            }
            if (fb.errors.length > 0) {
              markRestart(manager);
              return {
                ok: false,
                details: fallbackDetails,
                error: {
                  remaining: typeof goalsCount === 'number' ? goalsCount : -1,
                  summaries: fb.errors
                }
              };
            }
            if (typeof goalsCount === 'number' && goalsCount === 0) {
              return { ok: true, details: fallbackDetails };
            }
            if (typeof goalsCount === 'number') {
              return {
                ok: false,
                details: fallbackDetails,
                error: {
                  remaining: goalsCount,
                  summaries: ['Remaining goals: ' + goalsCount]
                }
              };
            }
          } catch (e) {
            hints.push('Fallback tokenizer failed: ' + (e && e.message ? e.message : String(e)));
          }
        }

        if (details.tokenSummary) {
          if (details.tokenSummary.statementend === 0 && details.tokenSummary.coqBullet === 0) {
            if (details.tokenSummary.nullType > 0 && details.tokenSummary.comment === 0) {
              hints.push('Token types are missing; CodeMirror may not be tokenizing the input.');
            }
            if (details.tokenSummary.comment > 0 && details.tokenSummary.comment >= details.tokenSummary.nullType) {
              hints.push('Most tokens are comments; the proof may be commented out.');
            }
          }
        }

        return {
          ok: false,
          details,
          error: {
            remaining: -1,
            summaries: hints.length
              ? ['No Coq statements were processed.', ...hints]
              : ['No Coq statements were processed (check for missing periods).']
          }
        };
      }

      const goalRequestAt = Date.now();
      const last = manager.lastAdded ? manager.lastAdded() : null;
      if (last && last.coq_sid && manager.coq && typeof manager.coq.goals === 'function') {
        manager.coq.goals(last.coq_sid);
        await waitForGoalsUpdate(manager, goalRequestAt, 2000);
      }

      const goalsCount = countGoalsFromResponse(
        manager.__coqRunnerLastGoals,
        manager.__coqRunnerGoalInfoSeen
      );

      const details = buildRunDetails(manager, goalsCount);

      if ((details.coqExceptions && details.coqExceptions.length) ||
          (details.jsonExceptions && details.jsonExceptions.length)) {
        markRestart(manager);
        const summaries = [];
        if (details.coqExceptions) summaries.push(...details.coqExceptions);
        if (details.jsonExceptions) summaries.push(...details.jsonExceptions);
        return {
          ok: false,
          details,
          error: {
            remaining: typeof goalsCount === 'number' ? goalsCount : -1,
            summaries
          }
        };
      }

      if (manager.error && manager.error.length > 0) {
        markRestart(manager);
        const msg = extractCoqError(manager);
        return {
          ok: false,
          details,
          error: {
            remaining: typeof goalsCount === 'number' ? goalsCount : -1,
            summaries: [msg]
          }
        };
      }

      if (typeof goalsCount === 'number') {
        if (goalsCount === 0) return { ok: true, details };
        return {
          ok: false,
          details,
          error: {
            remaining: goalsCount,
            summaries: ['Remaining goals: ' + goalsCount]
          }
        };
      }

      return {
        ok: false,
        details,
        error: {
          remaining: -1,
          summaries: [
            manager.__coqRunnerGoalInfoSeen
              ? 'Goals could not be determined (empty GoalInfo)'
              : 'Goals could not be determined (no GoalInfo)'
          ]
        }
      };
    } catch (err) {
      markRestart(manager);
      throw err;
    } finally {
      releaseLock();
    }
  }

  function markRestart(manager) {
    if (manager) manager.__coqRunnerNeedsRestart = true;
  }

  function hasBusySentences(manager) {
    if (!manager || !manager.doc || !Array.isArray(manager.doc.sentences)) return false;
    return manager.doc.sentences.some((stm) => {
      if (!stm || !stm.phase) return false;
      return stm.phase === 'pending' || stm.phase === 'adding' || stm.phase === 'added' || stm.phase === 'processing';
    });
  }

  async function resetManagerDoc(manager, timeoutMs) {
    const needsRestart = !!(manager && manager.__coqRunnerNeedsRestart);
    const shouldRestart = needsRestart || hasBusySentences(manager);
    if (shouldRestart && manager && manager.coq && typeof manager.coq.restart === 'function') {
      try { await manager.coq.restart(); } catch (e) {}
      try { await waitForManagerReady(manager, Math.min(15000, timeoutMs || 15000)); } catch (e) {}
    } else {
      try {
        if (manager && manager.coq && typeof manager.coq.cancel === 'function' && hasBusySentences(manager)) {
          manager.coq.cancel(2);
          await sleep(50);
        }
      } catch (e) {}
    }

    try {
      if (manager && manager.provider && typeof manager.provider.retract === 'function') {
        manager.provider.retract();
      }
    } catch (e) {}

    try {
      if (manager && manager.doc && Array.isArray(manager.doc.sentences) && manager.doc.sentences[0]) {
        const dummy = manager.doc.sentences[0];
        manager.doc.sentences = [dummy];
        manager.doc.stm_id = [, dummy];
        manager.doc.goals = [];
      }
    } catch (e) {}

    try {
      if (manager && Array.isArray(manager.error)) manager.error.length = 0;
    } catch (e) {}
    if (manager) manager.__coqRunnerNeedsRestart = false;
  }

  CoqRunner.checkProofText = checkProofText;
  if (!global.CoqRunner) global.CoqRunner = CoqRunner;
  if (!global.checkProofText) global.checkProofText = (text, opts) => CoqRunner.checkProofText(text, opts);

})(window);
