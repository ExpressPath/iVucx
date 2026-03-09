const JSCOQ_CDN_BASE = 'https://cdn.jsdelivr.net/npm/jscoq@0.17.1/';

function normalizePath(value) {
  if (Array.isArray(value)) return value.join('/');
  return String(value || '');
}

function sanitizePath(input) {
  const normalized = normalizePath(input).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return null;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '..')) return null;
  return normalized;
}

function copyHeader(res, upstream, name) {
  const value = upstream.headers.get(name);
  if (value) res.setHeader(name, value);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const safePath = sanitizePath(req.query && req.query.path);
  if (!safePath) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }

  const target = new URL(safePath, JSCOQ_CDN_BASE);
  if (!target.href.startsWith(JSCOQ_CDN_BASE)) {
    res.status(400).json({ error: 'Invalid target' });
    return;
  }

  try {
    const upstream = await fetch(target.href, { method: req.method });

    res.status(upstream.status);
    copyHeader(res, upstream, 'content-type');
    copyHeader(res, upstream, 'cache-control');
    copyHeader(res, upstream, 'etag');
    copyHeader(res, upstream, 'last-modified');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({
      error: 'Failed to fetch jsCoq asset',
      detail: err && err.message ? err.message : String(err)
    });
  }
}
