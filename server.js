const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = process.cwd();
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_SIZE = 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const json = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(json);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_SIZE) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function clamp(num, min, max) {
  return Math.max(min, Math.min(max, num));
}

function buildSuggestions(query, limit) {
  const q = query || 'your topic';
  const templates = [
    `What is the quickest way to understand "${q}"?`,
    `Create a beginner-to-advanced learning path for "${q}".`,
    `List trusted sources to verify facts about "${q}".`,
    `Compare the top 3 approaches related to "${q}".`,
    `Summarize key risks and caveats for "${q}".`,
    `Give practical examples where "${q}" is used in real projects.`,
    `Suggest search keywords that find deeper results for "${q}".`,
    `Explain "${q}" with one simple analogy and one technical analogy.`,
    `Draft a checklist to evaluate solutions for "${q}".`,
    `Propose next actions I can take today for "${q}".`
  ];

  const out = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(templates[i % templates.length]);
  }
  return out;
}

function resolveStaticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const fallback = decoded === '/' ? '/index.html' : decoded;
  const normalized = path.normalize(fallback).replace(/^(\.\.(\/|\\|$))+/, '');
  return path.join(ROOT_DIR, normalized);
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/check-login' && req.method === 'GET') {
    sendJson(res, 200, {
      loggedIn: false,
      rewards: []
    });
    return true;
  }

  if (pathname === '/api/suggest' && req.method === 'POST') {
    try {
      const body = await readRequestBody(req);
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      const mode = typeof body.mode === 'string' ? body.mode : 'a';
      const limit = clamp(Number(body.limit) || 10, 1, 10);
      const suggestions = buildSuggestions(query, limit);

      sendJson(res, 200, {
        mode,
        query,
        suggestions
      });
    } catch (err) {
      sendJson(res, 400, {
        error: err.message || 'Bad request'
      });
    }
    return true;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(req.url || '/', base);
  const pathname = url.pathname;

  try {
    const handledApi = await handleApi(req, res, pathname);
    if (handledApi) return;

    const filePath = resolveStaticPath(pathname);
    if (!filePath.startsWith(ROOT_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal server error');
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
