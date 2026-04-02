const HELPER_API_BASE_URL = String(
  process.env.HELPER_API_BASE_URL || 'https://nodejs-production-e71bc.up.railway.app/'
)
  .trim()
  .replace(/\/+$/, '');
const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const HELPER_API_TIMEOUT_MS = Number(process.env.HELPER_API_TIMEOUT_MS || 180000);

export function isHelperConfigured() {
  return !!HELPER_API_BASE_URL;
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

  if (!isHelperConfigured()) {
    res.status(503).json({
      ok: false,
      status: 'unconfigured',
      error: 'Helper API is not configured on this server.'
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, HELPER_API_TIMEOUT_MS);

  const headers = {
    Accept: 'application/json'
  };
  if (HELPER_API_KEY) {
    headers.Authorization = `Bearer ${HELPER_API_KEY}`;
  }

  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body || {});
  }

  try {
    const response = await fetch(HELPER_API_BASE_URL + targetPath, {
      method: req.method,
      headers,
      body,
      signal: controller.signal
    });
    const text = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    clearTimeout(timer);

    res.status(response.status);
    res.setHeader('Content-Type', contentType);
    res.send(text);
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    res.status(timedOut ? 504 : 502).json({
      ok: false,
      status: timedOut ? 'timeout' : 'error',
      error: timedOut
        ? 'Helper API request timed out.'
        : (err && err.message ? err.message : String(err))
    });
  }
}
