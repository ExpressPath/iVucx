#!/usr/bin/env node
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { finished } = require('node:stream/promises');

const DEFAULT_CAPTURE_LIMIT = Math.max(4096, Number(process.env.IVUCX_EXPORT_CAPTURE_CHARS || 32000));
const ALLOWED_ENV_KEYS = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'
]);
const ALLOWED_ENV_PREFIXES = ['COQ', 'LEAN', 'OPAM', 'OCAML', 'CAML', 'PYTHON', 'XDG_', 'NIX_'];

function buildRestrictedProcessEnv(source) {
  const env = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (
      typeof value === 'string'
      && (ALLOWED_ENV_KEYS.has(key) || ALLOWED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    ) {
      env[key] = value;
    }
  }
  env.IVUCX_PROOF_SANDBOX = 'restricted-env-v1';
  return env;
}

function parseCliArgs(argv) {
  const flags = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current.startsWith('--')) {
      positional.push(current);
      continue;
    }

    const key = current.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positional };
}

async function runProcess(command, args, options = {}) {
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 180000;
  const cwd = options.cwd || process.cwd();
  const env = buildRestrictedProcessEnv(options.env || process.env);
  const captureLimit = Math.max(4096, Number(options.captureLimitChars || DEFAULT_CAPTURE_LIMIT));

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const stdoutBuffer = createBoundedOutputBuffer(captureLimit);
    const stderrBuffer = createBoundedOutputBuffer(captureLimit);
    const stdoutStream = options.stdoutFilePath ? fs.createWriteStream(options.stdoutFilePath) : null;
    const stderrStream = options.stderrFilePath ? fs.createWriteStream(options.stderrFilePath) : null;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const closeStreams = async () => {
      const pending = [];
      if (stdoutStream) {
        stdoutStream.end();
        pending.push(finished(stdoutStream).catch(() => {}));
      }
      if (stderrStream) {
        stderrStream.end();
        pending.push(finished(stderrStream).catch(() => {}));
      }
      await Promise.all(pending);
    };

    const finish = async (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      await closeStreams();
      callback();
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer.push(chunk);
      if (stdoutStream) {
        stdoutStream.write(chunk);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer.push(chunk);
      if (stderrStream) {
        stderrStream.write(chunk);
      }
    });

    child.on('error', (error) => {
      void finish(() => reject(error));
    });

    child.on('close', (exitCode, signal) => {
      void finish(() => resolve({
        exitCode,
        signal,
        timedOut,
        stdout: stdoutBuffer.value(),
        stderr: stderrBuffer.value(),
        stdoutFilePath: options.stdoutFilePath || '',
        stderrFilePath: options.stderrFilePath || ''
      }));
    });
  });
}

async function writeJson(filePath, value) {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await fsPromises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createBoundedOutputBuffer(limit) {
  let text = '';
  let truncatedChars = 0;

  return {
    push(chunk) {
      const value = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      if (!value) {
        return;
      }

      if (text.length < limit) {
        const remaining = limit - text.length;
        const accepted = value.slice(0, remaining);
        text += accepted;
        truncatedChars += Math.max(0, value.length - accepted.length);
        return;
      }

      truncatedChars += value.length;
    },
    value() {
      if (!truncatedChars) {
        return text;
      }
      return `${text}\n...[capture truncated ${truncatedChars} chars]`;
    }
  };
}

function collapseWhitespace(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCommonText(value) {
  return collapseWhitespace(value)
    .replace(/∀/g, 'forall ')
    .replace(/Π/g, 'Pi ')
    .replace(/λ/g, 'fun ')
    .replace(/→/g, ' -> ')
    .replace(/↦/g, ' => ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildError(message, details) {
  const error = new Error(message);
  error.details = details || null;
  return error;
}

module.exports = {
  buildError,
  collapseWhitespace,
  normalizeCommonText,
  parseCliArgs,
  runProcess,
  writeJson
};
