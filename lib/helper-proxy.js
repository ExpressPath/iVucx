import { getProofConversionRuntimes, runProofConversionLocally } from './proof-convert.js';
import { runProofCheckLocally } from './proof-check.js';
import { runProofTaskWithLimit } from './proof-task-limit.js';
import { attachExecutionRequestAuthHeaders, isLikelyOracleControlPlaneUrl } from './execution-auth.js';
import { resolveSupabaseAdminEnv } from './supabase-admin.js';

const CONFIGURED_HELPER_API_BASE_URLS = parseBaseUrlList(
  process.env.HELPER_API_BASE_URLS,
  process.env.HELPER_WORKER_BASE_URLS
);
const HELPER_API_BASE_URLS = CONFIGURED_HELPER_API_BASE_URLS.length
  ? CONFIGURED_HELPER_API_BASE_URLS
  : parseBaseUrlList(process.env.HELPER_API_BASE_URL);
const HELPER_STANDBY_BASE_URLS = parseBaseUrlList(
  process.env.HELPER_STANDBY_BASE_URLS,
  process.env.HELPER_STANDBY_API_BASE_URLS,
  process.env.HELPER_BURST_BASE_URLS,
  process.env.HELPER_BURST_API_BASE_URLS
);
const HELPER_API_BASE_URL = HELPER_API_BASE_URLS[0] || '';

const CONFIGURED_EXECUTION_API_BASE_URLS = parseBaseUrlList(
  process.env.EXECUTION_API_BASE_URLS,
  process.env.EXECUTION_WORKER_BASE_URLS
);
const RAW_EXPLICIT_EXECUTION_API_BASE_URLS = CONFIGURED_EXECUTION_API_BASE_URLS.length
  ? CONFIGURED_EXECUTION_API_BASE_URLS
  : parseBaseUrlList(
  process.env.EXECUTION_API_BASE_URL
  || process.env.EXECUTION_SERVER_BASE_URL
  || process.env.PROOF_EXECUTION_API_BASE_URL
  || process.env.ORACLE_SERVER_BASE_URL
  || process.env.RENDER_API_BASE_URL
  || ''
  );
const RAW_EXPLICIT_EXECUTION_API_BASE_URL = RAW_EXPLICIT_EXECUTION_API_BASE_URLS[0] || '';

const EXPLICIT_EXECUTION_API_BASE_URLS = HELPER_API_BASE_URL
  ? RAW_EXPLICIT_EXECUTION_API_BASE_URLS.filter((baseUrl) => !isLikelyOracleControlPlaneUrl(baseUrl))
  : RAW_EXPLICIT_EXECUTION_API_BASE_URLS;
const EXPLICIT_EXECUTION_API_BASE_URL = EXPLICIT_EXECUTION_API_BASE_URLS[0] || '';
const PREFER_HELPER_EXECUTION_API = parseBoolean(
  process.env.PREFER_HELPER_EXECUTION_API || process.env.HELPER_EXECUTION_API_PREFERRED,
  Boolean(HELPER_API_BASE_URL)
);
const EXECUTION_API_BASE_URLS = PREFER_HELPER_EXECUTION_API && HELPER_API_BASE_URL
  ? HELPER_API_BASE_URLS
  : (EXPLICIT_EXECUTION_API_BASE_URLS.length ? EXPLICIT_EXECUTION_API_BASE_URLS : HELPER_API_BASE_URLS);
const EXECUTION_API_BASE_URL = EXECUTION_API_BASE_URLS[0] || '';

const NODE_ENV = String(process.env.NODE_ENV || 'development').trim().toLowerCase() || 'development';
const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const EXECUTION_API_KEY = String(
  process.env.EXECUTION_API_KEY
  || process.env.EXECUTION_SERVER_API_KEY
  || process.env.PROOF_EXECUTION_API_KEY
  || process.env.ORACLE_SERVER_API_KEY
  || HELPER_API_KEY
  || ''
).trim();

const HELPER_API_TIMEOUT_MS = Number(process.env.HELPER_API_TIMEOUT_MS || 180000);
const EXECUTION_API_TIMEOUT_MS = Number(
  process.env.EXECUTION_API_TIMEOUT_MS
  || process.env.EXECUTION_SERVER_TIMEOUT_MS
  || process.env.PROOF_EXECUTION_API_TIMEOUT_MS
  || process.env.ORACLE_SERVER_TIMEOUT_MS
  || HELPER_API_TIMEOUT_MS
);
const EXECUTION_BASE_URL_HEADER = 'x-ivucx-execution-base-url';
const ALLOW_LOCAL_EXECUTION_FALLBACK = parseBoolean(
  process.env.ALLOW_LOCAL_EXECUTION_FALLBACK || process.env.IVUCX_ALLOW_LOCAL_EXECUTION_FALLBACK,
  NODE_ENV !== 'production'
);
const ALLOW_LOCAL_HELPER_FALLBACK = parseBoolean(
  process.env.ALLOW_LOCAL_HELPER_FALLBACK || process.env.IVUCX_ALLOW_LOCAL_HELPER_FALLBACK,
  NODE_ENV !== 'production'
);
const REMOTE_POOL_CIRCUIT_OPEN_MS = Number(process.env.REMOTE_POOL_CIRCUIT_OPEN_MS || 15000);
const REMOTE_POOL_RETRY_LIMIT = Math.max(1, Number(process.env.REMOTE_POOL_RETRY_LIMIT || 3));
const REMOTE_POOL_STATE = new Map();
const HELPER_AUTOSCALE_ENABLED = parseBoolean(process.env.HELPER_AUTOSCALE_ENABLED, false);
const HELPER_AUTOSCALE_SCALER_URL = normalizeBaseUrl(
  process.env.HELPER_AUTOSCALE_SCALER_URL
  || process.env.GCE_HELPER_SCALER_URL
  || ''
);
const HELPER_AUTOSCALE_SCALER_KEY = String(
  process.env.HELPER_AUTOSCALE_SCALER_KEY
  || process.env.GCE_HELPER_SCALER_KEY
  || ''
).trim();
const HELPER_AUTOSCALE_CODE_BYTES = Number(process.env.HELPER_AUTOSCALE_CODE_BYTES || 10000);
const HELPER_AUTOSCALE_INFLIGHT = Number(process.env.HELPER_AUTOSCALE_INFLIGHT || 2);
const HELPER_AUTOSCALE_WARMUP_MS = Number(process.env.HELPER_AUTOSCALE_WARMUP_MS || 90000);
const HELPER_AUTOSCALE_ACTIVE_MS = Number(process.env.HELPER_AUTOSCALE_ACTIVE_MS || 30 * 60 * 1000);
const HELPER_AUTOSCALE_TOUCH_MS = Number(process.env.HELPER_AUTOSCALE_TOUCH_MS || 2 * 60 * 1000);
const HELPER_AUTOSCALE_COOLDOWN_MS = Number(process.env.HELPER_AUTOSCALE_COOLDOWN_MS || 60 * 1000);
const HELPER_AUTOSCALE_REQUEST_TIMEOUT_MS = Number(process.env.HELPER_AUTOSCALE_REQUEST_TIMEOUT_MS || 4000);
const HELPER_AUTOSCALE_STATE = {
  lastScaleOutAt: 0,
  burstReadyAfter: 0,
  burstActiveUntil: 0,
  lastTouchAt: 0,
  lastError: ''
};

function parseBaseUrlList(...values) {
  const urls = [];
  const seen = new Set();

  values.forEach((value) => {
    String(value || '')
      .split(/[\s,]+/)
      .map(normalizeBaseUrl)
      .filter(Boolean)
      .forEach((url) => {
        if (!seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      });
  });

  return urls;
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  switch (String(value).trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallbackValue;
  }
}

function createRemoteConfigurationError(role) {
  if (role === 'helper') {
    const error = new Error(
      'Helper API is not configured on this server. Set HELPER_API_BASE_URL or enable ALLOW_LOCAL_HELPER_FALLBACK for development.'
    );
    error.statusCode = 503;
    return error;
  }

  const error = new Error(
    'Execution API is not configured on this server. Set EXECUTION_API_BASE_URL or HELPER_API_BASE_URL, or enable ALLOW_LOCAL_EXECUTION_FALLBACK for development.'
  );
  error.statusCode = 503;
  return error;
}

function getRemoteConfig(role) {
  const helperBaseUrls = getActiveHelperBaseUrls();
  if (role === 'execution') {
    return {
      baseUrl: PREFER_HELPER_EXECUTION_API ? helperBaseUrls[0] || '' : EXECUTION_API_BASE_URL,
      baseUrls: PREFER_HELPER_EXECUTION_API ? helperBaseUrls : EXECUTION_API_BASE_URLS,
      apiKey: EXECUTION_API_KEY,
      timeoutMs: EXECUTION_API_TIMEOUT_MS
    };
  }

  return {
    baseUrl: HELPER_API_BASE_URL,
    baseUrls: helperBaseUrls,
    apiKey: HELPER_API_KEY,
    timeoutMs: HELPER_API_TIMEOUT_MS
  };
}

function normalizeLanguageKey(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }

  const error = new Error('language must be Lean or Coq');
  error.statusCode = 400;
  throw error;
}

function toLanguageLabel(language) {
  return normalizeLanguageKey(language) === 'lean' ? 'Lean' : 'Coq';
}

function buildExecutionTargetPath(language) {
  return normalizeLanguageKey(language) === 'lean' ? '/api/lean-check' : '/api/coq-check';
}

function createController(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  return { controller, timer };
}

function cleanupTimer(timer) {
  clearTimeout(timer);
}

function withRequestId(payload, req) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }

  if (req && req.id && !Object.prototype.hasOwnProperty.call(payload, 'requestId')) {
    return {
      requestId: req.id,
      ...payload
    };
  }

  return payload;
}

function safeParseJson(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function buildHeaders(apiKey, extraHeaders = {}) {
  const headers = {
    Accept: 'application/json',
    ...extraHeaders
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return firstHeaderValue(value[0]);
  }

  if (typeof value !== 'string') {
    return '';
  }

  return value.split(',')[0].trim();
}

function normalizeBaseUrl(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.replace(/\/+$/, '');
}

function inferExecutionBaseUrlFromRequest(req) {
  if (!req || typeof req !== 'object') {
    return '';
  }

  const forwardedProto = firstHeaderValue(req.headers && req.headers['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(req.headers && req.headers['x-forwarded-host']);
  const host = forwardedHost || firstHeaderValue(req.headers && req.headers.host);
  if (!host) {
    return '';
  }

  const protocol = forwardedProto
    || (req.protocol && String(req.protocol).trim())
    || 'https';

  return normalizeBaseUrl(`${protocol}://${host}`);
}

function isExecutionRoutedViaHelper() {
  if (PREFER_HELPER_EXECUTION_API && HELPER_API_BASE_URLS.length) {
    return true;
  }
  const helperBaseUrls = new Set(getActiveHelperBaseUrls().map(normalizeBaseUrl));
  return Boolean(
    helperBaseUrls.size
    && EXECUTION_API_BASE_URLS.length
    && EXECUTION_API_BASE_URLS.every((baseUrl) => helperBaseUrls.has(normalizeBaseUrl(baseUrl)))
  );
}

function resolveExecutionBridgeBaseUrl(req) {
  if (EXPLICIT_EXECUTION_API_BASE_URL && !isExecutionRoutedViaHelper()) {
    return normalizeBaseUrl(EXPLICIT_EXECUTION_API_BASE_URL);
  }

  if (!HELPER_API_BASE_URL && ALLOW_LOCAL_EXECUTION_FALLBACK) {
    return normalizeBaseUrl(inferExecutionBaseUrlFromRequest(req));
  }

  return '';
}

function buildHelperForwardHeaders(req, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  const executionBaseUrl = resolveExecutionBridgeBaseUrl(req);
  if (executionBaseUrl) {
    headers[EXECUTION_BASE_URL_HEADER] = executionBaseUrl;
  }
  return headers;
}

function extractRemoteError(payload, fallbackMessage) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }
    if (payload.result && typeof payload.result === 'object') {
      const result = payload.result;
      if (typeof result.error === 'string' && result.error.trim()) {
        return result.error.trim();
      }
      if (result.conversion && typeof result.conversion === 'object') {
        if (
          result.conversion.lambda
          && typeof result.conversion.lambda === 'object'
          && typeof result.conversion.lambda.error === 'string'
          && result.conversion.lambda.error.trim()
        ) {
          return result.conversion.lambda.error.trim();
        }
        if (typeof result.conversion.stderr === 'string' && result.conversion.stderr.trim()) {
          return result.conversion.stderr.trim();
        }
        if (typeof result.conversion.stdout === 'string' && result.conversion.stdout.trim()) {
          return result.conversion.stdout.trim();
        }
      }
      if (result.proofCheck && typeof result.proofCheck === 'object') {
        if (typeof result.proofCheck.error === 'string' && result.proofCheck.error.trim()) {
          return result.proofCheck.error.trim();
        }
        if (typeof result.proofCheck.stderr === 'string' && result.proofCheck.stderr.trim()) {
          return result.proofCheck.stderr.trim();
        }
        if (typeof result.proofCheck.stdout === 'string' && result.proofCheck.stdout.trim()) {
          return result.proofCheck.stdout.trim();
        }
      }
    }
  }

  return fallbackMessage;
}

function describeHttpStatus(status) {
  if (status === 502) return 'Bad Gateway';
  if (status === 503) return 'Service Unavailable';
  if (status === 504) return 'Gateway Timeout';
  if (status === 422) return 'Unprocessable Content';
  if (status === 404) return 'Not Found';
  return 'Request Failed';
}

function shouldFallbackToLocalConversion(helperPayload, helperText) {
  const message = extractRemoteError(helperPayload, helperText || '')
    .toLowerCase();

  return (
    message.includes('spawn coqc enoent')
    || message.includes('spawn lean enoent')
    || message.includes('spawn lake enoent')
    || message.includes('converter is not configured')
    || message.includes('execution delegate is not configured')
  );
}

function uniqueBaseUrls(baseUrls) {
  const seen = new Set();
  const urls = [];
  baseUrls.forEach((baseUrl) => {
    const normalized = normalizeBaseUrl(baseUrl);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  });
  return urls;
}

function isAutoscaleConfigured() {
  return Boolean(
    HELPER_AUTOSCALE_ENABLED
    && HELPER_AUTOSCALE_SCALER_URL
    && HELPER_AUTOSCALE_SCALER_KEY
    && HELPER_STANDBY_BASE_URLS.length
  );
}

function isBurstPoolReady(now = Date.now()) {
  return now >= HELPER_AUTOSCALE_STATE.burstReadyAfter
    && now < HELPER_AUTOSCALE_STATE.burstActiveUntil;
}

function getActiveHelperBaseUrls() {
  if (!isBurstPoolReady()) {
    return HELPER_API_BASE_URLS;
  }
  return uniqueBaseUrls([...HELPER_API_BASE_URLS, ...HELPER_STANDBY_BASE_URLS]);
}

function getCodeBytesFromBody(body) {
  if (!body || typeof body !== 'object') {
    return 0;
  }
  if (typeof body.code === 'string') {
    return Buffer.byteLength(body.code, 'utf8');
  }
  if (typeof body.source === 'string') {
    return Buffer.byteLength(body.source, 'utf8');
  }
  return 0;
}

function getTotalInflight(role, baseUrls) {
  return baseUrls.reduce((total, baseUrl) => total + getWorkerState(role, baseUrl).inflight, 0);
}

function shouldTriggerScaleOut(role, targetPath, options, baseUrls) {
  if (!isAutoscaleConfigured() || (role !== 'execution' && role !== 'helper')) {
    return false;
  }

  const now = Date.now();
  if (isBurstPoolReady(now)) {
    return false;
  }
  if (now - HELPER_AUTOSCALE_STATE.lastScaleOutAt < HELPER_AUTOSCALE_COOLDOWN_MS) {
    return false;
  }

  const codeBytes = getCodeBytesFromBody(options.body);
  const inflight = getTotalInflight(role, baseUrls);

  return codeBytes >= HELPER_AUTOSCALE_CODE_BYTES
    || inflight >= HELPER_AUTOSCALE_INFLIGHT
    || targetPath === '/api/helper/submit'
    || targetPath === '/api/helper/convert';
}

async function callAutoscaler(path, payload) {
  const { controller, timer } = createController(HELPER_AUTOSCALE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(HELPER_AUTOSCALE_SCALER_URL + path, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${HELPER_AUTOSCALE_SCALER_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal
    });
    const text = await response.text();
    cleanupTimer(timer);
    if (!response.ok) {
      throw new Error(`autoscaler returned ${response.status}`);
    }
    return safeParseJson(text) || {};
  } catch (error) {
    cleanupTimer(timer);
    throw error;
  }
}

async function maybeTriggerScaleOut(role, targetPath, options, baseUrls) {
  if (!shouldTriggerScaleOut(role, targetPath, options, baseUrls)) {
    return;
  }

  const now = Date.now();
  HELPER_AUTOSCALE_STATE.lastScaleOutAt = now;
  HELPER_AUTOSCALE_STATE.burstReadyAfter = now + HELPER_AUTOSCALE_WARMUP_MS;
  HELPER_AUTOSCALE_STATE.burstActiveUntil = now + HELPER_AUTOSCALE_ACTIVE_MS;

  try {
    await callAutoscaler('/scale-out', {
      reason: 'heavy-proof-request',
      role,
      targetPath,
      codeBytes: getCodeBytesFromBody(options.body),
      inflight: getTotalInflight(role, baseUrls)
    });
    HELPER_AUTOSCALE_STATE.lastError = '';
  } catch (error) {
    HELPER_AUTOSCALE_STATE.lastError = error && error.message ? error.message : String(error);
  }
}

async function maybeTouchAutoscaler(role) {
  if (!isAutoscaleConfigured() || (role !== 'execution' && role !== 'helper') || !isBurstPoolReady()) {
    return;
  }

  const now = Date.now();
  if (now - HELPER_AUTOSCALE_STATE.lastTouchAt < HELPER_AUTOSCALE_TOUCH_MS) {
    return;
  }
  HELPER_AUTOSCALE_STATE.lastTouchAt = now;
  HELPER_AUTOSCALE_STATE.burstActiveUntil = now + HELPER_AUTOSCALE_ACTIVE_MS;

  try {
    await callAutoscaler('/touch', { reason: 'proof-request' });
    HELPER_AUTOSCALE_STATE.lastError = '';
  } catch (error) {
    HELPER_AUTOSCALE_STATE.lastError = error && error.message ? error.message : String(error);
  }
}

function getWorkerState(role, baseUrl) {
  const key = `${role}:${baseUrl}`;
  let state = REMOTE_POOL_STATE.get(key);
  if (!state) {
    state = {
      role,
      baseUrl,
      inflight: 0,
      consecutiveFailures: 0,
      successes: 0,
      failures: 0,
      lastLatencyMs: 1000,
      openUntil: 0,
      lastError: ''
    };
    REMOTE_POOL_STATE.set(key, state);
  }
  return state;
}

function getRemotePoolSnapshot(role) {
  const config = getRemoteConfig(role);
  return (config.baseUrls || [])
    .map((baseUrl) => {
      const state = getWorkerState(role, baseUrl);
      return {
        baseUrl,
        inflight: state.inflight,
        consecutiveFailures: state.consecutiveFailures,
        successes: state.successes,
        failures: state.failures,
        lastLatencyMs: Math.round(state.lastLatencyMs),
        available: state.openUntil <= Date.now(),
        circuitOpenUntil: state.openUntil > Date.now() ? new Date(state.openUntil).toISOString() : null,
        lastError: state.lastError || null
      };
    });
}

function scoreWorker(state, index, now) {
  if (state.openUntil > now) {
    return Number.POSITIVE_INFINITY;
  }
  return (state.inflight * 1000)
    + state.lastLatencyMs
    + (state.consecutiveFailures * 5000)
    + (index / 1000);
}

function selectRemoteWorker(role, baseUrls, attemptedBaseUrls = new Set()) {
  const now = Date.now();
  let selected = null;
  let selectedScore = Number.POSITIVE_INFINITY;

  baseUrls.forEach((baseUrl, index) => {
    if (attemptedBaseUrls.has(baseUrl)) {
      return;
    }
    const state = getWorkerState(role, baseUrl);
    const score = scoreWorker(state, index, now);
    if (score < selectedScore) {
      selected = state;
      selectedScore = score;
    }
  });

  if (selected) {
    return selected;
  }

  return baseUrls
    .filter((baseUrl) => !attemptedBaseUrls.has(baseUrl))
    .map((baseUrl) => getWorkerState(role, baseUrl))
    .sort((left, right) => left.openUntil - right.openUntil)[0] || null;
}

function markWorkerSuccess(state, startedAt) {
  const durationMs = Math.max(1, Date.now() - startedAt);
  state.inflight = Math.max(0, state.inflight - 1);
  state.consecutiveFailures = 0;
  state.successes += 1;
  state.lastError = '';
  state.openUntil = 0;
  state.lastLatencyMs = state.lastLatencyMs
    ? ((state.lastLatencyMs * 0.7) + (durationMs * 0.3))
    : durationMs;
}

function markWorkerFailure(state, startedAt, errorMessage) {
  const durationMs = Math.max(1, Date.now() - startedAt);
  state.inflight = Math.max(0, state.inflight - 1);
  state.consecutiveFailures += 1;
  state.failures += 1;
  state.lastLatencyMs = state.lastLatencyMs
    ? ((state.lastLatencyMs * 0.8) + (durationMs * 0.2))
    : durationMs;
  state.lastError = String(errorMessage || '').slice(0, 240);
  state.openUntil = Date.now() + Math.min(
    REMOTE_POOL_CIRCUIT_OPEN_MS * state.consecutiveFailures,
    REMOTE_POOL_CIRCUIT_OPEN_MS * 6
  );
}

function isRetryableRemoteStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

function canRetryRemoteRequest(method, targetPath, options) {
  if (options.retryOnFailure === true) {
    return true;
  }
  if (options.retryOnFailure === false) {
    return false;
  }

  const normalizedMethod = String(method || 'GET').toUpperCase();
  return normalizedMethod === 'GET'
    || normalizedMethod === 'HEAD'
    || targetPath === '/api/lean-check'
    || targetPath === '/api/coq-check';
}

async function buildLocalConversionFallback(payload, proofCheck) {
  const fallback = await runProofTaskWithLimit(
    () => runProofConversionLocally({
      ...payload,
      verify: false
    }),
    { kind: 'helper-conversion-fallback' }
  );

  return {
    ...fallback,
    verifyBeforeConvert: true,
    proofCheck,
    conversion: fallback.conversion || null,
    fallbackSource: 'same-app-fallback'
  };
}

async function sendRemoteRequest(role, targetPath, options = {}) {
  const config = getRemoteConfig(role);
  const baseUrls = Array.isArray(config.baseUrls) && config.baseUrls.length
    ? config.baseUrls
    : (config.baseUrl ? [config.baseUrl] : []);
  if (!baseUrls.length) {
    throw createRemoteConfigurationError(role);
  }

  const method = options.method || 'GET';
  let headers = buildHeaders(config.apiKey, options.headers || {});
  let body;
  let bodyText = '';

  if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
    bodyText = body;
  }

  if (role === 'execution') {
    headers = await attachExecutionRequestAuthHeaders({
      headers,
      method,
      targetPath,
      bodyText
    });
  }

  await maybeTriggerScaleOut(role, targetPath, options, baseUrls);
  await maybeTouchAutoscaler(role);

  const attemptedBaseUrls = new Set();
  const retryableRequest = canRetryRemoteRequest(method, targetPath, options);
  const maxAttempts = retryableRequest
    ? Math.min(baseUrls.length, REMOTE_POOL_RETRY_LIMIT)
    : 1;
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const worker = selectRemoteWorker(role, baseUrls, attemptedBaseUrls);
    if (!worker) {
      break;
    }
    attemptedBaseUrls.add(worker.baseUrl);
    worker.inflight += 1;
    const startedAt = Date.now();
    const { controller, timer } = createController(config.timeoutMs);

    try {
      const response = await fetch(worker.baseUrl + targetPath, {
        method,
        headers,
        body,
        signal: controller.signal
      });
      const text = await response.text();
      const payload = safeParseJson(text);
      const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
      cleanupTimer(timer);

      if (isRetryableRemoteStatus(response.status)) {
        markWorkerFailure(worker, startedAt, `${response.status} ${describeHttpStatus(response.status)}`);
        if (retryableRequest && attempt + 1 < maxAttempts) {
          continue;
        }
      } else {
        markWorkerSuccess(worker, startedAt);
      }

      return {
        ok: response.ok,
        status: response.status,
        contentType,
        text,
        payload,
        upstreamBaseUrl: worker.baseUrl
      };
    } catch (err) {
      cleanupTimer(timer);
      const timedOut = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
      const error = new Error(
        timedOut
          ? (role === 'execution' ? 'Execution API request timed out.' : 'Helper API request timed out.')
          : (err && err.message ? err.message : String(err))
      );
      error.statusCode = timedOut ? 504 : 502;
      error.details = {
        role,
        targetPath,
        timedOut,
        upstreamBaseUrl: worker.baseUrl
      };
      markWorkerFailure(worker, startedAt, error.message);
      lastError = error;
      if (!retryableRequest || attempt + 1 >= maxAttempts) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw createRemoteConfigurationError(role);
}

export function isHelperConfigured() {
  return !!HELPER_API_BASE_URL;
}

export function isExecutionConfigured() {
  return !!EXECUTION_API_BASE_URL;
}

export function canUseLocalExecutionFallback() {
  return ALLOW_LOCAL_EXECUTION_FALLBACK;
}

export function canUseLocalHelperFallback() {
  return ALLOW_LOCAL_HELPER_FALLBACK;
}

export function sendRemoteConfigurationError(res, role = 'execution') {
  const error = createRemoteConfigurationError(role);
  res.status(error.statusCode || 503).json({
    ok: false,
    success: false,
    status: 'error',
    error: error.message
  });
}

export function sendMethodNotAllowed(res, methods) {
  const allowed = Array.isArray(methods) ? methods.join(', ') : String(methods || '');
  if (allowed) {
    res.setHeader('Allow', allowed);
  }
  res.status(405).json({ error: 'Method not allowed' });
}

export function buildHelperQuery(query, excludedKeys = []) {
  const params = new URLSearchParams();
  const excluded = new Set(excludedKeys.map((key) => String(key)));
  const source = query && typeof query === 'object' ? query : {};

  Object.entries(source).forEach(([key, value]) => {
    if (excluded.has(key) || value == null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry != null) {
          params.append(key, String(entry));
        }
      });
      return;
    }
    params.set(key, String(value));
  });

  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function proxyHelperRequest(req, res, targetPath) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const upstream = await sendRemoteRequest('helper', targetPath, {
      method: req.method,
      headers: buildHelperForwardHeaders(req),
      body: req.method !== 'GET' && req.method !== 'HEAD' ? (req.body || {}) : undefined
    });

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.contentType);
    res.send(upstream.text);
  } catch (error) {
    res.status(error.statusCode || 502).json({
      ok: false,
      status: error.statusCode === 504 ? 'timeout' : 'error',
      error: error.message
    });
  }
}

export async function proxyExecutionApiRequest(req, res, targetPath) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (isLikelyOracleControlPlaneUrl(EXECUTION_API_BASE_URL)) {
      throw createLikelyWrongOracleEndpointError(EXECUTION_API_BASE_URL);
    }

    const upstream = await sendRemoteRequest('execution', targetPath, {
      method: req.method,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? (req.body || {}) : undefined
    });

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.contentType);
    res.send(upstream.text);
  } catch (error) {
    res.status(error.statusCode || 502).json({
      ok: false,
      status: error.statusCode === 504 ? 'timeout' : 'error',
      error: error.message
    });
  }
}

export async function proxyExecutionProofCheckRequest(req, res, targetPath) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    if (isLikelyOracleControlPlaneUrl(EXECUTION_API_BASE_URL)) {
      throw createLikelyWrongOracleEndpointError(EXECUTION_API_BASE_URL);
    }

    const upstream = await sendRemoteRequest('execution', targetPath, {
      method: req.method,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? (req.body || {}) : undefined
    });

    if (upstream.status === 422 && upstream.payload && typeof upstream.payload === 'object') {
      res.status(200).json({
        ...upstream.payload,
        httpStatus: upstream.status,
        upstreamStatus: upstream.status
      });
      return;
    }

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.contentType);
    res.send(upstream.text);
  } catch (error) {
    res.status(error.statusCode || 502).json({
      ok: false,
      status: error.statusCode === 504 ? 'timeout' : 'error',
      error: error.message
    });
  }
}

export async function requestProofCheck(payload) {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  const language = normalizeLanguageKey(normalizedPayload.language);
  const code = typeof normalizedPayload.code === 'string' ? normalizedPayload.code : '';

  if (!code.trim()) {
    const error = new Error('code must be a non-empty string');
    error.statusCode = 400;
    throw error;
  }

  if (!isExecutionConfigured()) {
    if (!ALLOW_LOCAL_EXECUTION_FALLBACK) {
      throw createRemoteConfigurationError('execution');
    }
    const localResult = await runProofTaskWithLimit(
      () => runProofCheckLocally(language, normalizedPayload),
      { kind: `${language}-helper-proof-check` }
    );
    return {
      ...localResult,
      upstreamStatus: localResult.httpStatus || 200,
      source: 'same-app-fallback'
    };
  }

  if (isLikelyOracleControlPlaneUrl(EXECUTION_API_BASE_URL)) {
    throw createLikelyWrongOracleEndpointError(EXECUTION_API_BASE_URL);
  }

  const upstream = await sendRemoteRequest('execution', buildExecutionTargetPath(language), {
    method: 'POST',
    body: {
      code,
      fileName: normalizedPayload.fileName || null
    }
  });

  const body = upstream.payload && typeof upstream.payload === 'object' ? upstream.payload : {};
  return {
    ok: Boolean(body.ok),
    language,
    fileName: normalizedPayload.fileName || (language === 'lean' ? 'Main.lean' : 'Main.v'),
    command: body.command || buildExecutionTargetPath(language),
    args: Array.isArray(body.args) ? body.args : [],
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
    signal: body.signal || null,
    timedOut: body.status === 'timeout' || upstream.status === 504,
    durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
    codeBytes: Buffer.byteLength(code, 'utf8'),
    stdout: typeof body.stdout === 'string' ? body.stdout : '',
    stderr: typeof body.stderr === 'string' ? body.stderr : '',
    error: typeof body.error === 'string' ? body.error : '',
    upstreamStatus: upstream.status,
    source: isExecutionRoutedViaHelper() ? 'github-actions-via-helper' : 'execution-server'
  };
}

function statusCodeForResult(result) {
  const explicitStatus = result && (
    (typeof result.httpStatus === 'number' ? result.httpStatus : null)
    || (typeof result.upstreamStatus === 'number' ? result.upstreamStatus : null)
  );
  if (explicitStatus && explicitStatus >= 400) {
    return explicitStatus;
  }
  if (result && result.ok) {
    return 200;
  }
  if (result && result.timedOut) {
    return 504;
  }
  return 422;
}

function createLikelyWrongOracleEndpointError(baseUrl) {
  const error = new Error(
    `Execution API base URL looks like the Oracle Cloud control-plane endpoint (${baseUrl}). Point EXECUTION_API_BASE_URL or ORACLE_SERVER_BASE_URL to the public URL of the real execution service app.`
  );
  error.statusCode = 503;
  return error;
}

function buildProofCheckFailureResult(payload, proofCheck) {
  return {
    ok: false,
    stage: 'proof-check',
    timedOut: Boolean(proofCheck && proofCheck.timedOut),
    httpStatus: proofCheck && typeof proofCheck.httpStatus === 'number'
      ? proofCheck.httpStatus
      : (proofCheck && typeof proofCheck.upstreamStatus === 'number' ? proofCheck.upstreamStatus : null),
    language: normalizeLanguageKey(payload.language),
    verifyBeforeConvert: true,
    proofCheck,
    conversion: null
  };
}

function buildConversionFailureResult(payload, proofCheck, helperPayload, helperStatus, helperText) {
  const helperResult = helperPayload && helperPayload.result && typeof helperPayload.result === 'object'
    ? helperPayload.result
    : null;

  if (helperResult) {
    return {
      ...helperResult,
      verifyBeforeConvert: true,
      proofCheck
    };
  }

  const errorMessage = extractRemoteError(helperPayload, helperText || 'Helper conversion failed.');
  return {
    ok: false,
    stage: 'conversion',
    timedOut: helperStatus === 504,
    httpStatus: helperStatus >= 400 ? helperStatus : null,
    language: normalizeLanguageKey(payload.language),
    verifyBeforeConvert: true,
    proofCheck,
    conversion: {
      ok: false,
      language: normalizeLanguageKey(payload.language),
      timedOut: helperStatus === 504,
      stdout: '',
      stderr: errorMessage,
      lambda: {
        error: errorMessage
      }
    }
  };
}

async function requestDistributedOperation(targetPath, payload, req) {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};

  if (!isHelperConfigured()) {
    if (!ALLOW_LOCAL_HELPER_FALLBACK) {
      throw createRemoteConfigurationError('helper');
    }
    const result = await runProofTaskWithLimit(
      () => runProofConversionLocally(normalizedPayload),
      { kind: 'helper-conversion-fallback' }
    );
    return {
      ok: Boolean(result.ok),
      status: statusCodeForResult(result),
      payload: {
        success: Boolean(result.ok),
        result
      }
    };
  }

  const helperResponse = await sendRemoteRequest('helper', targetPath, {
    method: 'POST',
    headers: buildHelperForwardHeaders(req),
    body: normalizedPayload
  });
  const helperPayloadResult = helperResponse.payload && typeof helperResponse.payload === 'object'
    ? helperResponse.payload
    : null;

  if ((!helperPayloadResult || (!helperPayloadResult.result && !helperPayloadResult.job))
    && shouldFallbackToLocalConversion(helperPayloadResult, helperResponse.text)
    && ALLOW_LOCAL_EXECUTION_FALLBACK) {
    const result = await runProofTaskWithLimit(
      () => runProofConversionLocally(normalizedPayload),
      { kind: 'helper-conversion-fallback' }
    );
    return {
      ok: Boolean(result.ok),
      status: statusCodeForResult(result),
      payload: {
        success: Boolean(result.ok),
        result
      }
    };
  }

  if (helperPayloadResult) {
    return {
      ok: helperResponse.ok,
      status: helperResponse.status,
      payload: helperPayloadResult
    };
  }

  return {
    ok: helperResponse.ok,
    status: helperResponse.status,
    payload: {
      success: false,
      error: `Helper proxy returned ${helperResponse.status} ${describeHttpStatus(helperResponse.status)}.`
    }
  };
}

export async function proxyDistributedCheck(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const result = await requestProofCheck(req.body || {});
    res.status(statusCodeForResult(result)).json(withRequestId({
      success: result.ok,
      result
    }, req));
  } catch (error) {
    res.status(error.statusCode || 502).json(withRequestId({
      success: false,
      error: error.message
    }, req));
  }
}

export async function proxyDistributedHelperOperation(req, res, targetPath) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const upstream = await requestDistributedOperation(targetPath, req.body || {}, req);
    res.status(upstream.status).json(withRequestId(upstream.payload, req));
  } catch (error) {
    res.status(error.statusCode || 502).json(withRequestId({
      success: false,
      error: error.message
    }, req));
  }
}

export async function proxyCompositeHelperInfo(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const effectiveExecutionBaseUrl = normalizeBaseUrl(EXECUTION_API_BASE_URL);
    const activeHelperBaseUrls = getActiveHelperBaseUrls();
    const activeExecutionBaseUrls = PREFER_HELPER_EXECUTION_API ? activeHelperBaseUrls : EXECUTION_API_BASE_URLS;
    const executionBridgeBaseUrl = resolveExecutionBridgeBaseUrl(req);
    const executionViaHelper = isExecutionRoutedViaHelper();
    const supabaseEnv = resolveSupabaseAdminEnv();
    const vercelSupabaseConfigured = Boolean(supabaseEnv.url && supabaseEnv.serviceRoleKey);
    const upstream = await sendRemoteRequest('helper', '/api/helper/info', {
      method: 'GET',
      headers: buildHelperForwardHeaders(req)
    });

    if (!upstream.payload || typeof upstream.payload !== 'object') {
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.contentType);
      res.send(upstream.text);
      return;
    }

    const payload = {
      ...upstream.payload,
      executionConfigured: Boolean(
        upstream.payload.executionConfigured
        || effectiveExecutionBaseUrl
        || executionBridgeBaseUrl
      ),
      capabilities: {
        ...(upstream.payload.capabilities || {}),
        proofCheck: true,
        splitExecution: Boolean(isExecutionConfigured() || executionBridgeBaseUrl),
        executionBridge: Boolean(executionBridgeBaseUrl),
        vercelProblemPersistence: vercelSupabaseConfigured
      },
      deployment: {
        ...(upstream.payload.deployment || {}),
        helperServer: HELPER_API_BASE_URL || null,
        helperServers: activeHelperBaseUrls,
        helperPrimaryServers: HELPER_API_BASE_URLS,
        helperStandbyServers: HELPER_STANDBY_BASE_URLS,
        executionServer: effectiveExecutionBaseUrl || null,
        executionServers: activeExecutionBaseUrls,
        proofExecution: executionViaHelper
          ? 'github-actions-via-helper'
          : (effectiveExecutionBaseUrl ? 'execution-api' : 'same-app-fallback'),
        conversion: executionViaHelper
          ? 'railway-helper-to-github-actions'
          : (effectiveExecutionBaseUrl ? 'railway-helper-to-execution-api' : 'same-app-fallback')
      },
      vercelPersistence: {
        supabaseConfigured: vercelSupabaseConfigured,
        urlConfigured: Boolean(supabaseEnv.url),
        urlSource: supabaseEnv.urlSource || null,
        serviceRoleConfigured: Boolean(supabaseEnv.serviceRoleKey),
        anonConfigured: Boolean(supabaseEnv.anonKey),
        route: '/api/helper/persist'
      },
      remotePools: {
        helper: getRemotePoolSnapshot('helper'),
        execution: getRemotePoolSnapshot('execution')
      },
      autoscaling: {
        enabled: isAutoscaleConfigured(),
        scalerConfigured: Boolean(HELPER_AUTOSCALE_SCALER_URL && HELPER_AUTOSCALE_SCALER_KEY),
        burstReady: isBurstPoolReady(),
        burstReadyAfter: HELPER_AUTOSCALE_STATE.burstReadyAfter
          ? new Date(HELPER_AUTOSCALE_STATE.burstReadyAfter).toISOString()
          : null,
        burstActiveUntil: HELPER_AUTOSCALE_STATE.burstActiveUntil
          ? new Date(HELPER_AUTOSCALE_STATE.burstActiveUntil).toISOString()
          : null,
        standbyServers: HELPER_STANDBY_BASE_URLS,
        lastScaleOutAt: HELPER_AUTOSCALE_STATE.lastScaleOutAt
          ? new Date(HELPER_AUTOSCALE_STATE.lastScaleOutAt).toISOString()
          : null,
        lastTouchAt: HELPER_AUTOSCALE_STATE.lastTouchAt
          ? new Date(HELPER_AUTOSCALE_STATE.lastTouchAt).toISOString()
          : null,
        lastError: HELPER_AUTOSCALE_STATE.lastError || null
      }
    };

    if (!payload.runtimes || typeof payload.runtimes !== 'object') {
      payload.runtimes = {};
    }

    if (!payload.execution || typeof payload.execution !== 'object') {
      payload.execution = {};
    }

    payload.execution = {
      ...payload.execution,
      configured: Boolean(
        payload.execution.configured
        || effectiveExecutionBaseUrl
        || executionBridgeBaseUrl
      ),
      baseUrl: payload.execution.baseUrl || effectiveExecutionBaseUrl || executionBridgeBaseUrl || null,
      via: payload.execution.via
        || (
          payload.execution.baseUrl
            ? 'helper-env'
            : (
              executionViaHelper
                ? 'helper-compatible-execution'
                : (executionBridgeBaseUrl ? 'request-bridge' : (effectiveExecutionBaseUrl ? 'execution-env' : 'unconfigured'))
            )
        )
    };

    if (!payload.runtimes.executionModel || typeof payload.runtimes.executionModel !== 'object') {
      payload.runtimes.executionModel = {};
    }

    payload.runtimes.executionModel = {
      ...payload.runtimes.executionModel,
      proofCheck: payload.runtimes.executionModel.proofCheck === 'unconfigured' && effectiveExecutionBaseUrl
        ? (executionViaHelper ? 'github-actions-via-helper' : 'execution-server')
        : payload.runtimes.executionModel.proofCheck,
      conversion: payload.runtimes.executionModel.conversion === 'unconfigured' && effectiveExecutionBaseUrl
        ? (executionViaHelper ? 'github-actions-via-helper' : 'execution-server')
        : payload.runtimes.executionModel.conversion
    };

    const localConversionRuntimes = getProofConversionRuntimes();
    const remoteConversionRuntimes = payload.runtimes.conversionRuntimes
      && typeof payload.runtimes.conversionRuntimes === 'object'
      ? payload.runtimes.conversionRuntimes
      : {};

    payload.runtimes.conversionRuntimes = {
      ...remoteConversionRuntimes,
      typedLambda: {
        ...(localConversionRuntimes.typedLambda || {}),
        ...(remoteConversionRuntimes.typedLambda || {})
      },
      cic: {
        ...(localConversionRuntimes.cic || {}),
        ...(remoteConversionRuntimes.cic || {})
      }
    };

    payload.runtimes.proofRuntimes = {
      lean: {
        available: true,
        route: '/api/lean-check',
        upstream: executionViaHelper
          ? 'github-actions-via-helper'
          : (effectiveExecutionBaseUrl ? 'execution-api' : 'same-app-fallback')
      },
      coq: {
        available: true,
        route: '/api/coq-check',
        upstream: executionViaHelper
          ? 'github-actions-via-helper'
          : (effectiveExecutionBaseUrl ? 'execution-api' : 'same-app-fallback')
      }
    };

    payload.deployment.stateStore = payload.runtimes.executionModel
      && payload.runtimes.executionModel.stateStore
      ? payload.runtimes.executionModel.stateStore
      : 'supabase';
    payload.deployment.planning = payload.runtimes.executionModel
      && payload.runtimes.executionModel.planning
      ? payload.runtimes.executionModel.planning
      : 'railway';
    payload.deployment.heavyConversion = payload.runtimes.executionModel
      && payload.runtimes.executionModel.conversion
      ? payload.runtimes.executionModel.conversion
      : (
        executionViaHelper
          ? 'github-actions-via-helper'
          : (effectiveExecutionBaseUrl ? 'execution-api' : 'same-app-fallback')
      );

    if (isLikelyOracleControlPlaneUrl(effectiveExecutionBaseUrl)) {
      payload.deployment.executionWarning = {
        code: 'likely-oracle-control-plane-url',
        message: `Execution server base URL ${effectiveExecutionBaseUrl} looks like the Oracle Cloud control-plane endpoint, not the real execution service app URL.`
      };
    }

    res.status(upstream.status).json(withRequestId(payload, req));
  } catch (error) {
    res.status(error.statusCode || 502).json(withRequestId({
      success: false,
      error: error.message
    }, req));
  }
}
