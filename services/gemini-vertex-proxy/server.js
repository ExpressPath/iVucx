import http from 'node:http';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const MAX_BODY_BYTES = 1_000_000;
const METADATA_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

let tokenCache = {
  accessToken: '',
  expiresAt: 0
};

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
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

  const response = await fetch(METADATA_TOKEN_URL, {
    headers: { 'Metadata-Flavor': 'Google' }
  });
  const payload = await response.json().catch(() => null);
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
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(resolvedModel)}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(requestBody)
  });
  const payload = await response.json().catch(() => null);
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
    if (expectedKey && req.headers['x-ivucx-helper-key'] !== expectedKey) {
      sendJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const body = await readJsonBody(req);
    const requestBody = body && body.requestBody;
    if (!requestBody || typeof requestBody !== 'object') {
      sendJson(res, 400, { error: 'requestBody is required.' });
      return;
    }

    const payload = await callVertex({
      model: body.model,
      requestBody
    });
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, Number(error.status) || 500, {
      error: error.message || 'Gemini proxy failed.'
    });
  }
});

server.listen(Number(process.env.PORT) || 8080, () => {
  console.log('iVucx Gemini Vertex proxy listening');
});
