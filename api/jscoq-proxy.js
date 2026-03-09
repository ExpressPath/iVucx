import https from 'https';

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

function copyHeaderFromObject(res, headers, name) {
  const value = headers[name];
  if (value) res.setHeader(name, value);
}

function fetchUpstream(url, method = 'GET', depth = 0) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method }, (upstream) => {
      const statusCode = upstream.statusCode || 502;

      if (
        statusCode >= 300 &&
        statusCode < 400 &&
        upstream.headers.location &&
        depth < 5
      ) {
        const nextUrl = new URL(upstream.headers.location, url).toString();
        upstream.resume();
        fetchUpstream(nextUrl, method, depth + 1).then(resolve).catch(reject);
        return;
      }

      const chunks = [];
      upstream.on('data', (chunk) => chunks.push(chunk));
      upstream.on('end', () => {
        resolve({
          statusCode,
          headers: upstream.headers || {},
          body: Buffer.concat(chunks)
        });
      });
    });

    req.on('error', reject);
    req.end();
  });
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
    const upstream = await fetchUpstream(target.href, req.method);

    res.status(upstream.statusCode);
    copyHeaderFromObject(res, upstream.headers, 'content-type');
    copyHeaderFromObject(res, upstream.headers, 'cache-control');
    copyHeaderFromObject(res, upstream.headers, 'etag');
    copyHeaderFromObject(res, upstream.headers, 'last-modified');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.send(upstream.body);
  } catch (err) {
    res.status(502).json({
      error: 'Failed to fetch jsCoq asset',
      detail: err && err.message ? err.message : String(err)
    });
  }
}
