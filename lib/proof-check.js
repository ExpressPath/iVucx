import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import { buildProofProcessEnv } from './proof-process-env.js';
import { isolatedProcessOptions, terminateProcessTree } from './child-process-tree.js';
import { runProofTaskWithLimit } from './proof-task-limit.js';
import { assertProofRequestAllowed } from './request-guard.js';

const LEAN_MAX_CODE_BYTES = Number(process.env.LEAN_MAX_CODE_BYTES || 200000);
const LEAN_MAX_OUTPUT_CHARS = Number(process.env.LEAN_MAX_OUTPUT_CHARS || 200000);
const LEAN_TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS || 15000);
const LEAN_CMD_RAW = process.env.IVUCX_LEAN_CMD || process.env.LEAN_CMD || 'lean';
const LEAN_CMD = resolveLeanCommand(LEAN_CMD_RAW);
const LEAN_ARGS = splitArgs(process.env.LEAN_ARGS || '');
const LEAN_WORKDIR = process.env.LEAN_WORKDIR
  ? path.resolve(process.env.LEAN_WORKDIR)
  : '';

const COQ_MAX_CODE_BYTES = Number(process.env.COQ_MAX_CODE_BYTES || 200000);
const COQ_MAX_OUTPUT_CHARS = Number(process.env.COQ_MAX_OUTPUT_CHARS || 200000);
const COQ_TIMEOUT_MS = Number(process.env.COQ_TIMEOUT_MS || 15000);
const COQ_CMD_RAW = process.env.IVUCX_COQ_CMD || process.env.COQ_CMD || '/home/opam/.opam/ivucx/bin/coqc';
const COQ_CMD = resolveCoqCommand(COQ_CMD_RAW);
const COQ_ARGS = splitArgs(process.env.COQ_ARGS || '');
const COQ_WORKDIR = process.env.COQ_WORKDIR
  ? path.resolve(process.env.COQ_WORKDIR)
  : '';
const PROCESS_CAPTURE_CHARS = Math.max(4096, Number(process.env.PROOF_PROCESS_CAPTURE_CHARS || 48000));

function resolveLeanCommand(cmd) {
  if (!cmd) {
    return '/opt/elan/bin/lean';
  }
  if (path.isAbsolute(cmd) && fsSync.existsSync(cmd)) return cmd;
  const commonLeanCandidates = [
    process.env.IVUCX_LEAN_CMD || '',
    process.env.LEAN_BIN ? path.join(process.env.LEAN_BIN, cmd) : '',
    '/opt/elan/bin/lean',
    '/root/.elan/bin/lean'
  ].filter(Boolean);
  for (const candidate of commonLeanCandidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  const elanHome = process.env.ELAN_HOME;
  if (elanHome) {
    const candidate = path.join(elanHome, 'bin', cmd);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return cmd;
}

function resolveCoqCommand(cmd) {
  if (!cmd) {
    return '/home/opam/.opam/ivucx/bin/coqc';
  }
  if (path.isAbsolute(cmd) && fsSync.existsSync(cmd)) return cmd;
  const commonCoqCandidates = [
    process.env.IVUCX_COQ_CMD || '',
    process.env.COQ_BIN ? path.join(process.env.COQ_BIN, cmd) : '',
    '/home/opam/.opam/ivucx/bin/coqc',
    '/home/opam/.opam/default/bin/coqc',
    '/usr/bin/coqc'
  ].filter(Boolean);
  for (const candidate of commonCoqCandidates) {
    if (fsSync.existsSync(candidate)) return candidate;
  }
  const coqBin = process.env.COQBIN;
  if (coqBin) {
    const candidate = path.join(coqBin, cmd);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  const opamPrefix = process.env.OPAM_SWITCH_PREFIX;
  if (opamPrefix) {
    const candidate = path.join(opamPrefix, 'bin', cmd);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return cmd;
}

function splitArgs(value) {
  if (!value) return [];
  return value
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

function truncateOutput(text, limit) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return (
    value.slice(0, limit) +
    '\n...[output truncated ' +
    (value.length - limit) +
    ' chars]'
  );
}

function createRequestError(statusCode, body) {
  const error = new Error(body && body.error ? body.error : 'Proof check failed.');
  error.statusCode = statusCode;
  error.body = body;
  return error;
}

export function normalizeProofLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }

  throw createRequestError(400, {
    ok: false,
    status: 'invalid',
    error: 'language must be Lean or Coq.'
  });
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

function getLanguageConfig(language) {
  if (language === 'lean') {
    return {
      label: 'Lean',
      extension: '.lean',
      maxCodeBytes: LEAN_MAX_CODE_BYTES,
      maxOutputChars: LEAN_MAX_OUTPUT_CHARS,
      timeoutMs: LEAN_TIMEOUT_MS,
      cmd: LEAN_CMD,
      args: LEAN_ARGS,
      workdir: LEAN_WORKDIR,
      defaultFileName: 'Main.lean',
      missingCommandMessage:
        'Lean executable not found. Install Lean or set LEAN_CMD/ELAN_HOME so the server can find it.'
    };
  }

  return {
    label: 'Coq',
    extension: '.v',
    maxCodeBytes: COQ_MAX_CODE_BYTES,
    maxOutputChars: COQ_MAX_OUTPUT_CHARS,
    timeoutMs: COQ_TIMEOUT_MS,
    cmd: COQ_CMD,
    args: COQ_ARGS,
    workdir: COQ_WORKDIR,
    defaultFileName: 'Main.v',
    missingCommandMessage:
      'Coq executable not found. Install Coq or set COQ_CMD so the server can find it.'
  };
}

async function prepareProofFile(language, code) {
  const config = getLanguageConfig(language);
  const prefix = language === 'lean' ? 'ivucx-lean-' : 'ivucx-coq-';
  const baseDir = config.workdir
    ? config.workdir
    : await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const tmpDir = config.workdir ? path.join(baseDir, '.ivucx_tmp') : baseDir;
  await fs.mkdir(tmpDir, { recursive: true });
  const fileName =
    'Main_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + config.extension;
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, code, 'utf8');
  return {
    baseDir,
    tmpDir,
    filePath,
    cleanupBase: !config.workdir
  };
}

async function cleanupProofFile(language, info) {
  if (!info) return;

  if (language === 'coq') {
    if (!info.cleanupBase && info.tmpDir && info.tmpDir !== info.baseDir) {
      try {
        await fs.rm(info.tmpDir, { recursive: true, force: true });
        return;
      } catch (error) {
        // ignore cleanup failures
      }
    }

    const outputs = [];
    if (info.filePath) {
      outputs.push(info.filePath);
      const stem = info.filePath.replace(/\.v$/i, '');
      if (stem) {
        outputs.push(stem + '.vo', stem + '.glob', stem + '.vos', stem + '.vok', stem + '.aux');
      }
    }
    for (const filePath of outputs) {
      try {
        await fs.unlink(filePath);
      } catch (error) {
        // ignore cleanup failures
      }
    }
  } else {
    try {
      await fs.unlink(info.filePath);
    } catch (error) {
      // ignore cleanup failures
    }
  }

  if (info.cleanupBase) {
    try {
      await fs.rm(info.baseDir, { recursive: true, force: true });
    } catch (error) {
      // ignore cleanup failures
    }
  }
}

function runProcess(cmd, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: buildProofProcessEnv(options.env),
      ...isolatedProcessOptions()
    });

    const captureLimit = Math.max(4096, Number(options.captureLimitChars || PROCESS_CAPTURE_CHARS));
    const stdoutBuffer = createBoundedOutputBuffer(captureLimit);
    const stderrBuffer = createBoundedOutputBuffer(captureLimit);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBuffer.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer.push(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ error, stdout: stdoutBuffer.value(), stderr: stderrBuffer.value(), timedOut });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({
        exitCode,
        signal,
        stdout: stdoutBuffer.value(),
        stderr: stderrBuffer.value(),
        timedOut
      });
    });
  });
}

function toHttpBody(result) {
  const body = {
    ok: Boolean(result.ok),
    status: result.status,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: result.signal || null,
    durationMs: typeof result.durationMs === 'number' ? result.durationMs : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : ''
  };

  if (result.error) {
    body.error = result.error;
  }

  return body;
}

export async function runProofCheckLocally(language, payload = {}) {
  const normalizedLanguage = normalizeProofLanguage(language);
  const config = getLanguageConfig(normalizedLanguage);
  const code = typeof payload.code === 'string' ? payload.code : '';

  if (!code.trim()) {
    throw createRequestError(400, {
      ok: false,
      status: 'invalid',
      error: `${config.label} code is required.`
    });
  }

  const codeBytes = Buffer.byteLength(code, 'utf8');
  if (codeBytes > config.maxCodeBytes) {
    throw createRequestError(413, {
      ok: false,
      status: 'too_large',
      error: `${config.label} code exceeds size limit.`,
      limit: config.maxCodeBytes
    });
  }

  let info = null;
  const startedAt = Date.now();

  try {
    info = await prepareProofFile(normalizedLanguage, code);
    const args = [...config.args, info.filePath];
    const processResult = await runProcess(config.cmd, args, {
      cwd: config.workdir || info.baseDir,
      timeoutMs: config.timeoutMs
    });
    const durationMs = Date.now() - startedAt;

    const baseResult = {
      ok: false,
      status: 'error',
      language: normalizedLanguage,
      fileName: payload.fileName || config.defaultFileName,
      command: config.cmd,
      args,
      exitCode: typeof processResult.exitCode === 'number' ? processResult.exitCode : null,
      signal: processResult.signal || null,
      timedOut: Boolean(processResult.timedOut),
      durationMs,
      codeBytes,
      stdout: truncateOutput(processResult.stdout, config.maxOutputChars),
      stderr: truncateOutput(processResult.stderr, config.maxOutputChars),
      error: '',
      httpStatus: 200
    };

    if (processResult.error) {
      const isMissing = processResult.error && processResult.error.code === 'ENOENT';
      return {
        ...baseResult,
        httpStatus: 500,
        error: isMissing
          ? config.missingCommandMessage
          : (processResult.error.message || String(processResult.error))
      };
    }

    const ok = !processResult.timedOut && processResult.exitCode === 0;
    return {
      ...baseResult,
      ok,
      status: processResult.timedOut ? 'timeout' : ok ? 'ok' : 'error'
    };
  } catch (error) {
    if (error && typeof error.statusCode === 'number') {
      throw error;
    }
    throw createRequestError(500, {
      ok: false,
      status: 'error',
      error: error && error.message ? error.message : String(error)
    });
  } finally {
    await cleanupProofFile(normalizedLanguage, info);
  }
}

export async function sendProofCheckResponse(language, req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    assertProofRequestAllowed(req, `/api/${language}-check`, {
      body: req && req.body ? req.body : {}
    });
    await assertDistributedRateLimit(req, { route: 'proof-check', limit: 20, windowSeconds: 60 });
    const result = await runProofTaskWithLimit(
      () => runProofCheckLocally(language, req && req.body ? req.body : {}),
      { kind: `${language}-proof-check` }
    );
    const status = Number(result.httpStatus) || 200;
    const body = process.env.NODE_ENV === 'production' && status >= 500
      ? { ok: false, status: 'error', error: 'Proof verification failed.' }
      : toHttpBody(result);
    res.status(status).json(body);
  } catch (error) {
    if (error.retryAfter) {
      res.setHeader('Retry-After', String(error.retryAfter));
    }
    const status = getHttpErrorStatus(error);
    const body = process.env.NODE_ENV === 'production' && status >= 500
      ? { ok: false, status: 'error', error: 'Proof verification failed.' }
      : error && error.body && typeof error.body === 'object'
      ? error.body
      : {
          ok: false,
          status: 'error',
          error: getPublicErrorMessage(error, 'Proof verification failed.', status)
        };
    res.status(status).json(body);
  }
}
