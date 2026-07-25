import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = Math.max(65536, Number(process.env.GEMINI_PROXY_RESPONSE_MAX_BYTES) || 2 * 1024 * 1024);
const REQUEST_TIMEOUT_MS = Math.max(10000, Number(process.env.GEMINI_PROXY_TIMEOUT_MS) || 90000);
const METADATA_TIMEOUT_MS = Math.max(2000, Number(process.env.GEMINI_METADATA_TIMEOUT_MS) || 5000);
const MAX_CONCURRENT_REQUESTS = Math.max(1, Number(process.env.GEMINI_PROXY_MAX_CONCURRENT) || 4);
const MAX_QUEUED_REQUESTS = Math.max(1, Number(process.env.GEMINI_PROXY_MAX_QUEUED) || 20);
const IS_PRODUCTION = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let tokenCache = {
  accessToken: '',
  expiresAt: 0
};
let activeRequests = 0;
const requestQueue = [];

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(JSON.stringify(payload));
}

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''));
  const expectedBuffer = Buffer.from(String(expected || ''));
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

async function readBoundedJson(response, maxBytes = MAX_RESPONSE_BYTES) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > maxBytes) {
    const error = new Error('Upstream response is too large.');
    error.statusCode = 502;
    throw error;
  }
  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      const error = new Error('Upstream response is too large.');
      error.statusCode = 502;
      throw error;
    }
    try { return text ? JSON.parse(text) : null; } catch (error) { return null; }
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      const error = new Error('Upstream response is too large.');
      error.statusCode = 502;
      throw error;
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    return null;
  }
}

async function fetchJsonWithTimeout(url, options, timeoutMs, maxBytes = MAX_RESPONSE_BYTES) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await readBoundedJson(response, maxBytes);
    return { response, payload };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeout = new Error('Upstream request timed out.');
      timeout.statusCode = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function drainRequestQueue() {
  while (activeRequests < MAX_CONCURRENT_REQUESTS && requestQueue.length) {
    const task = requestQueue.shift();
    activeRequests += 1;
    Promise.resolve()
      .then(task.run)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeRequests = Math.max(0, activeRequests - 1);
        drainRequestQueue();
      });
  }
}

function runWithRequestLimit(run) {
  if (requestQueue.length >= MAX_QUEUED_REQUESTS) {
    const error = new Error('Gemini proxy queue is full.');
    error.statusCode = 429;
    throw error;
  }
  return new Promise((resolve, reject) => {
    requestQueue.push({ run, resolve, reject });
    drainRequestQueue();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error('Request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

async function getAccessToken() {
  const nowMs = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAt - 60000 > nowMs) {
    return tokenCache.accessToken;
  }

  const { response, payload } = await fetchJsonWithTimeout(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' }
  }, METADATA_TIMEOUT_MS, 256 * 1024);
  if (!response.ok) {
    throw new Error(`Metadata token request failed: ${response.status}`);
  }

  const accessToken = safeString(payload && payload.access_token);
  if (!accessToken) {
    throw new Error('Metadata token response did not include an access token.');
  }
  tokenCache = {
    accessToken,
    expiresAt: nowMs + (Number(payload.expires_in) || 3600) * 1000
  };
  return accessToken;
}

async function callVertex({ model, requestBody }) {
  const project = safeString(
    process.env.GOOGLE_CLOUD_PROJECT
      || process.env.GCP_PROJECT
      || process.env.GCLOUD_PROJECT
  );
  if (!project) {
    throw new Error('GOOGLE_CLOUD_PROJECT is not configured.');
  }

  const location = safeString(
    process.env.GOOGLE_CLOUD_LOCATION
      || process.env.VERTEX_AI_LOCATION,
    'us-central1'
  );
  const resolvedModel = safeString(model || process.env.GEMINI_MODEL, DEFAULT_MODEL);
  if (resolvedModel.length > 160 || !/^gemini-[a-z0-9._-]+$/i.test(resolvedModel)) {
    const error = new Error('Unsupported Gemini model.');
    error.statusCode = 400;
    throw error;
  }
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(resolvedModel)}:generateContent`;
  const boundedRequestBody = {
    ...requestBody,
    generationConfig: {
      ...(requestBody && requestBody.generationConfig && typeof requestBody.generationConfig === 'object'
        ? requestBody.generationConfig
        : {}),
      candidateCount: 1,
      maxOutputTokens: Math.max(1, Math.min(8192, Number(requestBody?.generationConfig?.maxOutputTokens) || 4096))
    }
  };
  const { response, payload } = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(boundedRequestBody)
  }, REQUEST_TIMEOUT_MS);
  if (!response.ok) {
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : `Vertex AI request failed: ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return payload;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/generate') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const expectedKey = safeString(process.env.IVUCX_GEMINI_PROXY_KEY);
    if (IS_PRODUCTION && !expectedKey) {
      sendJson(res, 503, { error: 'Gemini proxy authorization is not configured.' });
      return;
    }
    if (expectedKey && !secureEqual(req.headers['x-ivucx-helper-key'], expectedKey)) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const body = await readJsonBody(req);
    const requestBody = body && body.requestBody;
    if (!requestBody || typeof requestBody !== 'object') {
      sendJson(res, 400, { error: 'requestBody is required.' });
      return;
    }

    const payload = await runWithRequestLimit(() => callVertex({
      model: body.model,
      requestBody
    }));
    sendJson(res, 200, payload);
  } catch (error) {
    const status = Number(error.statusCode || error.status) || 500;
    sendJson(res, status, {
      error: IS_PRODUCTION && status >= 500
        ? 'Gemini proxy failed.'
        : (error.message || 'Gemini proxy failed.')
    });
  }
});

server.listen(Number(process.env.PORT) || 8080, () => {
  console.log('iVucx Gemini Vertex proxy listening');
});
