import https from 'https';

const JSCOQ_CDN_BASE = 'https://cdn.jsdelivr.net/npm/jscoq@0.17.1/';
const JSCOQ_CDN_PREFIX = '/npm/jscoq@0.17.1/';
const MAX_UPSTREAM_BYTES = 128 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 30000;

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

function isAllowedUpstreamUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'cdn.jsdelivr.net'
      && parsed.username === ''
      && parsed.password === ''
      && parsed.pathname.startsWith(JSCOQ_CDN_PREFIX);
  } catch (error) {
    return false;
  }
}

function fetchUpstream(url, method = 'GET', depth = 0) {
  return new Promise((resolve, reject) => {
    if (!isAllowedUpstreamUrl(url)) {
      reject(new Error('CDN redirect target is not allowed.'));
      return;
    }
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
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
        if (!isAllowedUpstreamUrl(nextUrl)) {
          finishError(new Error('CDN redirect target is not allowed.'));
          return;
        }
        fetchUpstream(nextUrl, method, depth + 1).then((value) => {
          if (settled) return;
          settled = true;
          resolve(value);
        }).catch(finishError);
        return;
      }

      const chunks = [];
      let totalBytes = 0;
      const contentLength = Number(upstream.headers['content-length'] || 0);
      if (contentLength > MAX_UPSTREAM_BYTES) {
        upstream.destroy();
        finishError(new Error('CDN asset exceeds the proxy size limit.'));
        return;
      }
      upstream.on('data', (chunk) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_UPSTREAM_BYTES) {
          upstream.destroy();
          finishError(new Error('CDN asset exceeds the proxy size limit.'));
          return;
        }
        chunks.push(chunk);
      });
      upstream.on('end', () => {
        if (settled) return;
        settled = true;
        resolve({
          statusCode,
          headers: upstream.headers || {},
          body: Buffer.concat(chunks)
        });
      });
      upstream.on('error', finishError);
    });

    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('CDN request timed out.')));
    req.on('error', finishError);
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
  if (!isAllowedUpstreamUrl(target.href)) {
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
      error: 'Failed to fetch jsCoq asset'
    });
  }
}
