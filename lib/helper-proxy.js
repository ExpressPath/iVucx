import { runProofCheckLocally } from './proof-check.js';

const HELPER_API_BASE_URL = String(
  process.env.HELPER_API_BASE_URL || 'https://nodejs-production-e71bc.up.railway.app/'
)
  .trim()
  .replace(/\/+$/, '');

const EXECUTION_API_BASE_URL = String(
  process.env.EXECUTION_API_BASE_URL
  || process.env.PROOF_EXECUTION_API_BASE_URL
  || process.env.RENDER_API_BASE_URL
  || ''
)
  .trim()
  .replace(/\/+$/, '');

const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const EXECUTION_API_KEY = String(
  process.env.EXECUTION_API_KEY
  || process.env.PROOF_EXECUTION_API_KEY
  || HELPER_API_KEY
  || ''
).trim();

const HELPER_API_TIMEOUT_MS = Number(process.env.HELPER_API_TIMEOUT_MS || 180000);
const EXECUTION_API_TIMEOUT_MS = Number(
  process.env.EXECUTION_API_TIMEOUT_MS
  || process.env.PROOF_EXECUTION_API_TIMEOUT_MS
  || HELPER_API_TIMEOUT_MS
);

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
        if (typeof result.conversion.stderr === 'string' && result.conversion.stderr.trim()) {
          return result.conversion.stderr.trim();
        }
        if (typeof result.conversion.stdout === 'string' && result.conversion.stdout.trim()) {
          return result.conversion.stdout.trim();
        }
      }
      if (result.proofCheck && typeof result.proofCheck === 'object') {
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

async function sendRemoteRequest(role, targetPath, options = {}) {
  const config = getRemoteConfig(role);
  if (!config.baseUrl) {
    const error = new Error(
      role === 'execution'
        ? 'Execution API is not configured on this server.'
        : 'Helper API is not configured on this server.'
    );
    error.statusCode = 503;
    throw error;
  }

  const { controller, timer } = createController(config.timeoutMs);
  const method = options.method || 'GET';
  const headers = buildHeaders(config.apiKey, options.headers || {});
  let body;

  if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
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
    const localResult = await runProofCheckLocally(language, normalizedPayload);
    return {
      ...localResult,
      upstreamStatus: localResult.httpStatus || 200,
      source: 'same-app'
    };
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
    source: 'remote-execution'
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

async function requestDistributedOperation(targetPath, payload) {
  const normalizedPayload = payload && typeof payload === 'object' ? payload : {};
  const shouldVerify = normalizedPayload.verify !== false;
  const helperPayload = {
    ...normalizedPayload,
    verify: false,
    async: false
  };

  if (!shouldVerify) {
    return sendRemoteRequest('helper', targetPath, {
      method: 'POST',
      body: {
        ...normalizedPayload,
        async: false
      }
    });
  }

  const [proofCheckResult, helperResult] = await Promise.allSettled([
    requestProofCheck(normalizedPayload),
    sendRemoteRequest('helper', targetPath, {
      method: 'POST',
      body: helperPayload
    })
  ]);

  if (proofCheckResult.status === 'rejected') {
    throw proofCheckResult.reason;
  }
  if (helperResult.status === 'rejected') {
    throw helperResult.reason;
  }

  const proofCheck = proofCheckResult.value;
  const helperResponse = helperResult.value;
  const helperPayloadResult = helperResponse.payload && typeof helperResponse.payload === 'object'
    ? helperResponse.payload
    : null;

  if (!proofCheck.ok) {
    const result = buildProofCheckFailureResult(normalizedPayload, proofCheck);
    return {
      ok: false,
      status: statusCodeForResult(result),
      payload: {
        success: false,
        result
      }
    };
  }

  if (!helperResponse.ok || !helperPayloadResult || !helperPayloadResult.result) {
    const result = buildConversionFailureResult(
      normalizedPayload,
      proofCheck,
      helperPayloadResult,
      helperResponse.status,
      helperResponse.text
    );
    return {
      ok: false,
      status: statusCodeForResult(result),
      payload: {
        success: false,
        result
      }
    };
  }

  const helperOperationResult = helperPayloadResult.result;
  const mergedResult = {
    ...helperOperationResult,
    verifyBeforeConvert: true,
    proofCheck,
    conversion: helperOperationResult.conversion || null
  };

  return {
    ok: true,
    status: statusCodeForResult(mergedResult),
    payload: {
      success: true,
      result: mergedResult
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
    const upstream = await requestDistributedOperation(targetPath, req.body || {});
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
    const upstream = await sendRemoteRequest('helper', '/api/helper/info', { method: 'GET' });

    if (!upstream.payload || typeof upstream.payload !== 'object') {
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.contentType);
      res.send(upstream.text);
      return;
    }

    const payload = {
      ...upstream.payload,
      capabilities: {
        ...(upstream.payload.capabilities || {}),
        proofCheck: true,
        splitExecution: isExecutionConfigured()
      },
      deployment: {
        ...(upstream.payload.deployment || {}),
        helperServer: HELPER_API_BASE_URL || null,
        executionServer: EXECUTION_API_BASE_URL || null,
        proofExecution: isExecutionConfigured() ? 'external-execution-service' : 'same-app',
        conversion: upstream.payload
          && upstream.payload.runtimes
          && upstream.payload.runtimes.executionModel
          && upstream.payload.runtimes.executionModel.conversion === 'delegated'
          ? 'same-app-via-helper'
          : 'helper'
      }
    };

    if (!payload.runtimes || typeof payload.runtimes !== 'object') {
      payload.runtimes = {};
    }

    payload.runtimes.proofRuntimes = {
      lean: {
        available: true,
        route: '/api/lean-check',
        upstream: isExecutionConfigured() ? 'external-execution-service' : 'same-app'
      },
      coq: {
        available: true,
        route: '/api/coq-check',
        upstream: isExecutionConfigured() ? 'external-execution-service' : 'same-app'
      }
    };

    res.status(upstream.status).json(withRequestId(payload, req));
  } catch (error) {
    res.status(error.statusCode || 502).json(withRequestId({
      success: false,
      error: error.message
    }, req));
  }
}
