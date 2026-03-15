import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import blueAuthLogin from './api/blue-auth-login.js';
import blueAuthLogout from './api/blue-auth-logout.js';
import blueAuthSignup from './api/blue-auth-signup.js';
import checkLogin from './api/check-login.js';
import jscoqProxy from './api/jscoq-proxy.js';
import suggest from './api/suggest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_CODE_BYTES = Number(process.env.LEAN_MAX_CODE_BYTES || 200000);
const MAX_OUTPUT_CHARS = Number(process.env.LEAN_MAX_OUTPUT_CHARS || 200000);
const LEAN_TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS || 15000);
const LEAN_CMD = process.env.LEAN_CMD || 'lean';
const LEAN_ARGS = splitArgs(process.env.LEAN_ARGS || '');
const LEAN_WORKDIR = process.env.LEAN_WORKDIR
  ? path.resolve(process.env.LEAN_WORKDIR)
  : '';

app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

function splitArgs(value) {
  if (!value) return [];
  return value
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      if (res.headersSent) return;
      res.status(500).json({
        error: 'Server error',
        detail: err && err.message ? err.message : String(err)
      });
    }
  };
}

async function prepareLeanFile(code) {
  const baseDir = LEAN_WORKDIR
    ? LEAN_WORKDIR
    : await fs.mkdtemp(path.join(os.tmpdir(), 'ivucx-lean-'));
  const tmpDir = LEAN_WORKDIR ? path.join(baseDir, '.ivucx_tmp') : baseDir;
  await fs.mkdir(tmpDir, { recursive: true });
  const fileName =
    'Main_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.lean';
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, code, 'utf8');
  return {
    baseDir,
    tmpDir,
    filePath,
    cleanupBase: !LEAN_WORKDIR
  };
}

async function cleanupLeanFile(info) {
  if (!info) return;
  try {
    await fs.unlink(info.filePath);
  } catch (err) {
    // ignore
  }
  if (info.cleanupBase) {
    try {
      await fs.rm(info.baseDir, { recursive: true, force: true });
    } catch (err) {
      // ignore
    }
  }
}

function truncateOutput(text) {
  const value = String(text || '');
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return (
    value.slice(0, MAX_OUTPUT_CHARS) +
    '\n...[output truncated ' +
    (value.length - MAX_OUTPUT_CHARS) +
    ' chars]'
  );
}

function runLeanProcess(cmd, args, options) {
  return new Promise((resolve) => {
    let resolved = false;
    const finalize = (payload) => {
      if (resolved) return;
      resolved = true;
      resolve(payload);
    };

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env || process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = options.timeoutMs || LEAN_TIMEOUT_MS;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      finalize({ error: err, stdout, stderr, timedOut });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finalize({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

app.post('/api/lean-check', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const code = req && req.body && typeof req.body.code === 'string' ? req.body.code : '';
  if (!code || !code.trim()) {
    res.status(400).json({ ok: false, status: 'invalid', error: 'Lean code is required.' });
    return;
  }

  const size = Buffer.byteLength(code, 'utf8');
  if (size > MAX_CODE_BYTES) {
    res.status(413).json({
      ok: false,
      status: 'too_large',
      error: 'Lean code exceeds size limit.',
      limit: MAX_CODE_BYTES
    });
    return;
  }

  let info = null;
  const startedAt = Date.now();

  try {
    info = await prepareLeanFile(code);
    const args = [...LEAN_ARGS, info.filePath];
    const result = await runLeanProcess(LEAN_CMD, args, {
      cwd: LEAN_WORKDIR || info.baseDir,
      timeoutMs: LEAN_TIMEOUT_MS
    });

    const durationMs = Date.now() - startedAt;
    await cleanupLeanFile(info);

    if (result.error) {
      res.status(500).json({
        ok: false,
        status: 'error',
        error: result.error.message || String(result.error),
        durationMs,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr)
      });
      return;
    }

    const ok = !result.timedOut && result.exitCode === 0;
    const status = result.timedOut ? 'timeout' : ok ? 'ok' : 'error';

    res.status(200).json({
      ok,
      status,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      signal: result.signal || null,
      durationMs,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr)
    });
  } catch (err) {
    await cleanupLeanFile(info);
    res.status(500).json({
      ok: false,
      status: 'error',
      error: err && err.message ? err.message : String(err)
    });
  }
});

app.get('/api/jscoq/*', wrap((req, res) => {
  req.query = req.query || {};
  req.query.path = req.params[0];
  return jscoqProxy(req, res);
}));

app.all('/api/blue-auth-signup', wrap(blueAuthSignup));
app.all('/api/blue-auth-login', wrap(blueAuthLogin));
app.all('/api/blue-auth-logout', wrap(blueAuthLogout));
app.all('/api/check-login', wrap(checkLogin));
app.all('/api/suggest', wrap(suggest));

app.use(express.static(__dirname, { dotfiles: 'ignore', extensions: ['html'] }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`[ivucx] server listening on :${PORT}`);
});
