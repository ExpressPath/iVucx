const DEFAULT_WINDOW_MS = 60 * 1000;
const DEFAULT_PROOF_REQUEST_MAX_BYTES = 300000;
const DEFAULT_CODE_MAX_BYTES = 250000;
const DEFAULT_MAX_RATE_BUCKETS = 10000;

const buckets = new Map();

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return firstHeaderValue(value[0]);
  return typeof value === 'string' ? value.split(',')[0].trim() : '';
}

function getClientKey(req) {
  const headers = req && req.headers ? req.headers : {};
  const direct = safeString(req && req.ip)
    || safeString(req && req.socket && req.socket.remoteAddress);
  if (safeString(process.env.VERCEL)) {
    return firstHeaderValue(headers['x-vercel-forwarded-for']) || direct || 'unknown';
  }
  if (safeString(process.env.CF_PAGES) || safeString(process.env.CLOUDFLARE_WORKER)) {
    return firstHeaderValue(headers['cf-connecting-ip']) || direct || 'unknown';
  }
  if (String(process.env.TRUST_PROXY_HEADERS || '').trim().toLowerCase() === 'true') {
    return firstHeaderValue(headers['x-real-ip'])
      || firstHeaderValue(headers['x-forwarded-for'])
      || direct
      || 'unknown';
  }
  return direct || 'unknown';
}

function getCodeBytes(body) {
  if (!body || typeof body !== 'object') return 0;
  const code = typeof body.code === 'string'
    ? body.code
    : (typeof body.source === 'string' ? body.source : '');
  return Buffer.byteLength(code, 'utf8');
}

function getCode(body) {
  if (!body || typeof body !== 'object') return '';
  if (typeof body.code === 'string') return body.code;
  if (typeof body.source === 'string') return body.source;
  return '';
}

function inferLanguage(targetPath, body) {
  const explicit = safeString(body && body.language).toLowerCase();
  if (explicit === 'lean' || explicit === 'coq') return explicit;
  const path = safeString(targetPath).toLowerCase();
  if (path.includes('lean')) return 'lean';
  if (path.includes('coq')) return 'coq';
  return '';
}

function getBodyBytes(body) {
  if (body === undefined || body === null) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch (error) {
    return Number.POSITIVE_INFINITY;
  }
}

function createGuardError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) error.details = details;
  return error;
}

function stripCoqCommentsAndStrings(input) {
  const source = String(input || '');
  let output = '';
  let commentDepth = 0;
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || '';
    if (commentDepth > 0) {
      if (current === '(' && next === '*') {
        commentDepth += 1;
        output += '  ';
        index += 1;
      } else if (current === '*' && next === ')') {
        commentDepth -= 1;
        output += '  ';
        index += 1;
      } else {
        output += current === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inString) {
      if (current === '"' && next === '"') {
        output += '  ';
        index += 1;
      } else if (current === '"') {
        inString = false;
        output += '"';
      } else {
        output += current === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (current === '(' && next === '*') {
      commentDepth = 1;
      output += '  ';
      index += 1;
    } else if (current === '"') {
      inString = true;
      output += '"';
    } else {
      output += current;
    }
  }
  return output;
}

function stripLeanCommentsAndStrings(input) {
  const source = String(input || '');
  let output = '';
  let blockDepth = 0;
  let inLineComment = false;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1] || '';
    if (inLineComment) {
      if (current === '\n') {
        inLineComment = false;
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (blockDepth > 0) {
      if (current === '/' && next === '-') {
        blockDepth += 1;
        output += '  ';
        index += 1;
      } else if (current === '-' && next === '/') {
        blockDepth -= 1;
        output += '  ';
        index += 1;
      } else {
        output += current === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (inString) {
      if (!escaped && current === '"') inString = false;
      escaped = !escaped && current === '\\';
      if (current !== '\\') escaped = false;
      output += current === '\n' ? '\n' : ' ';
      continue;
    }
    if (current === '-' && next === '-') {
      inLineComment = true;
      output += '  ';
      index += 1;
    } else if (current === '/' && next === '-') {
      blockDepth = 1;
      output += '  ';
      index += 1;
    } else if (current === '"') {
      inString = true;
      escaped = false;
      output += ' ';
    } else {
      output += current;
    }
  }
  return output;
}

function collectDangerousProofDirectives(language, code) {
  if (!language || !code) return [];
  const source = language === 'coq'
    ? stripCoqCommentsAndStrings(code)
    : stripLeanCommentsAndStrings(code);
  const dangerous = [];
  const add = (kind, match) => {
    dangerous.push({
      kind,
      statement: String(match || '').trim().slice(0, 200)
    });
  };

  if (language === 'coq') {
    const coqDangerous = /(?:^|[.\n])\s*((Declare\s+ML\s+Module|Load|Cd|Add\s+(?:Rec\s+)?LoadPath|Redirect|Extraction|Separate\s+Extraction)\b[\s\S]*?\.(?=\s|$))/g;
    for (const match of source.matchAll(coqDangerous)) {
      add(match[2], match[1]);
    }
    return dangerous;
  }

  const leanDangerous = [
    ['output command', /#(?:eval|reduce|compile|exit)\b[^\n;]*/gi],
    ['unsafe print command', /#print(?!\s+axioms\b)\b[^\n;]*/gi],
    ['metaprogram execution', /\b(?:run_cmd|run_tac|elab|elab_rules|macro_rules|initialize|builtin_initialize)\b[^\n;]*/gi],
    ['compile-time file inclusion', /\b(?:include_str|include_bytes)\b[^\n;]*/gi],
    ['external or unsafe declaration', /(?:@\[extern[^\]]*\]|\b(?:unsafe|partial)\b)[^\n;]*/gi]
  ];
  for (const [kind, pattern] of leanDangerous) {
    for (const match of source.matchAll(pattern)) {
      add(kind, match[0]);
    }
  }
  return dangerous;
}

function routeClass(targetPath) {
  const path = safeString(targetPath).toLowerCase();
  if (path.includes('/jobs')) return 'proof-jobs';
  if (path.includes('/lean-check') || path.includes('/coq-check') || path.includes('/helper/check')) return 'proof-check';
  if (path.includes('/helper/submit')
    || path.includes('/helper/convert')
    || path.includes('/helper/persist')
    || path.includes('/proof-convert')) return 'proof-submit';
  return 'default';
}

function routeLimit(route) {
  if (route === 'proof-submit') {
    return {
      maxTokens: Number(process.env.IVUCX_PROOF_SUBMIT_RATE_LIMIT || 10),
      windowMs: Number(process.env.IVUCX_PROOF_RATE_WINDOW_MS || DEFAULT_WINDOW_MS)
    };
  }
  if (route === 'proof-check') {
    return {
      maxTokens: Number(process.env.IVUCX_PROOF_CHECK_RATE_LIMIT || 20),
      windowMs: Number(process.env.IVUCX_PROOF_RATE_WINDOW_MS || DEFAULT_WINDOW_MS)
    };
  }
  if (route === 'proof-jobs') {
    return {
      maxTokens: Number(process.env.IVUCX_PROOF_JOBS_RATE_LIMIT || 180),
      windowMs: Number(process.env.IVUCX_PROOF_RATE_WINDOW_MS || DEFAULT_WINDOW_MS)
    };
  }
  return {
    maxTokens: Number(process.env.IVUCX_API_RATE_LIMIT || 240),
    windowMs: Number(process.env.IVUCX_API_RATE_WINDOW_MS || DEFAULT_WINDOW_MS)
  };
}

function requestCost(route, codeBytes) {
  if (route === 'proof-submit') return 2 + Math.ceil(codeBytes / 50000);
  if (route === 'proof-check') return 1 + Math.ceil(codeBytes / 75000);
  return 1;
}

function pruneBuckets(now, preserveKey = '') {
  const maxBuckets = Math.max(
    1000,
    Math.floor(Number(process.env.IVUCX_LOCAL_RATE_BUCKETS_MAX) || DEFAULT_MAX_RATE_BUCKETS)
  );
  if (buckets.size < maxBuckets) return;
  for (const [key, bucket] of buckets.entries()) {
    if (!bucket || bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size < maxBuckets || buckets.has(preserveKey)) return;

  let evictionKey = '';
  let earliestReset = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of buckets.entries()) {
    if (key === preserveKey) continue;
    const resetAt = Number(bucket && bucket.resetAt) || 0;
    if (resetAt < earliestReset) {
      evictionKey = key;
      earliestReset = resetAt;
    }
  }
  if (evictionKey) buckets.delete(evictionKey);
}

export function assertProofRequestAllowed(req, targetPath, options = {}) {
  const body = options.body === undefined ? (req && req.body) : options.body;
  const route = routeClass(targetPath);
  const bodyBytes = getBodyBytes(body);
  const codeBytes = getCodeBytes(body);
  const code = getCode(body);
  const language = inferLanguage(targetPath, body);
  const maxBodyBytes = Number(process.env.IVUCX_PROOF_REQUEST_MAX_BYTES || DEFAULT_PROOF_REQUEST_MAX_BYTES);
  const maxCodeBytes = Number(process.env.IVUCX_PROOF_CODE_MAX_BYTES || DEFAULT_CODE_MAX_BYTES);

  if (bodyBytes > maxBodyBytes) {
    throw createGuardError(413, 'Proof request body exceeds the server size limit.', {
      limit: maxBodyBytes,
      bodyBytes
    });
  }
  if (codeBytes > maxCodeBytes) {
    throw createGuardError(413, 'Proof code exceeds the server size limit.', {
      limit: maxCodeBytes,
      codeBytes
    });
  }
  const dangerous = collectDangerousProofDirectives(language, code);
  if (dangerous.length > 0) {
    throw createGuardError(422, 'Proof code contains server-side execution directives that are not allowed for verification.', {
      dangerous
    });
  }

  const now = Date.now();
  const clientKey = `${route}:${getClientKey(req)}`;
  pruneBuckets(now, clientKey);
  const limit = routeLimit(route);
  const maxTokens = Math.max(1, Number(limit.maxTokens) || 1);
  const windowMs = Math.max(1000, Number(limit.windowMs) || DEFAULT_WINDOW_MS);
  let bucket = buckets.get(clientKey);
  if (!bucket || bucket.resetAt <= now) {
    bucket = {
      tokens: maxTokens,
      resetAt: now + windowMs
    };
    buckets.set(clientKey, bucket);
  }

  const cost = Math.max(1, requestCost(route, codeBytes));
  if (bucket.tokens < cost) {
    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    const error = createGuardError(429, 'Too many proof verification requests. Retry after the current rate window.', {
      retryAfter,
      route,
      limit: maxTokens
    });
    error.retryAfter = retryAfter;
    throw error;
  }
  bucket.tokens -= cost;

  return {
    route,
    limit: maxTokens,
    remaining: Math.max(0, bucket.tokens),
    resetAt: bucket.resetAt
  };
}
