import { getProofConversionRuntimes, runProofConversionLocally } from './proof-convert.js';
import { runProofCheckLocally } from './proof-check.js';
import { runProofTaskWithLimit } from './proof-task-limit.js';
import { attachExecutionRequestAuthHeaders, isLikelyOracleControlPlaneUrl } from './execution-auth.js';

const HELPER_API_BASE_URL = String(
  process.env.HELPER_API_BASE_URL || ''
)
  .trim()
  .replace(/\/+$/, '');

const RAW_EXPLICIT_EXECUTION_API_BASE_URL = String(
  process.env.EXECUTION_API_BASE_URL
  || process.env.EXECUTION_SERVER_BASE_URL
  || process.env.PROOF_EXECUTION_API_BASE_URL
  || process.env.ORACLE_SERVER_BASE_URL
  || process.env.RENDER_API_BASE_URL
  || ''
)
  .trim()
  .replace(/\/+$/, '');

const EXPLICIT_EXECUTION_API_BASE_URL = (
  HELPER_API_BASE_URL && isLikelyOracleControlPlaneUrl(RAW_EXPLICIT_EXECUTION_API_BASE_URL)
)
  ? ''
  : RAW_EXPLICIT_EXECUTION_API_BASE_URL;
const PREFER_HELPER_EXECUTION_API = parseBoolean(
  process.env.PREFER_HELPER_EXECUTION_API || process.env.HELPER_EXECUTION_API_PREFERRED,
  Boolean(HELPER_API_BASE_URL)
);
const EXECUTION_API_BASE_URL = PREFER_HELPER_EXECUTION_API && HELPER_API_BASE_URL
  ? HELPER_API_BASE_URL
  : (EXPLICIT_EXECUTION_API_BASE_URL || HELPER_API_BASE_URL);

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
  if (role === 'execution') {
    return {
      baseUrl: EXECUTION_API_BASE_URL,
      apiKey: EXECUTION_API_KEY,
      timeoutMs: EXECUTION_API_TIMEOUT_MS
    };
  }

  return {
    baseUrl: HELPER_API_BASE_URL,
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
  return Boolean(
    HELPER_API_BASE_URL
    && EXECUTION_API_BASE_URL
    && normalizeBaseUrl(HELPER_API_BASE_URL) === normalizeBaseUrl(EXECUTION_API_BASE_URL)
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
  if (!config.baseUrl) {
    throw createRemoteConfigurationError(role);
  }

  const { controller, timer } = createController(config.timeoutMs);
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

  try {
    const response = await fetch(config.baseUrl + targetPath, {
      method,
      headers,
      body,
      signal: controller.signal
    });
    const text = await response.text();
    const payload = safeParseJson(text);
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    cleanupTimer(timer);

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      text,
      payload
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
      timedOut
    };
    throw error;
  }
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
    const executionBridgeBaseUrl = resolveExecutionBridgeBaseUrl(req);
    const executionViaHelper = isExecutionRoutedViaHelper();
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
        executionBridge: Boolean(executionBridgeBaseUrl)
      },
      deployment: {
        ...(upstream.payload.deployment || {}),
        helperServer: HELPER_API_BASE_URL || null,
        executionServer: effectiveExecutionBaseUrl || null,
        proofExecution: executionViaHelper
          ? 'github-actions-via-helper'
          : (effectiveExecutionBaseUrl ? 'execution-api' : 'same-app-fallback'),
        conversion: executionViaHelper
          ? 'railway-helper-to-github-actions'
          : (effectiveExecutionBaseUrl ? 'railway-helper-to-execution-api' : 'same-app-fallback')
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
