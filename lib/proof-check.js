import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

const LEAN_MAX_CODE_BYTES = Number(process.env.LEAN_MAX_CODE_BYTES || 200000);
const LEAN_MAX_OUTPUT_CHARS = Number(process.env.LEAN_MAX_OUTPUT_CHARS || 200000);
const LEAN_TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS || 15000);
const LEAN_CMD_RAW = process.env.LEAN_CMD || 'lean';
const LEAN_CMD = resolveLeanCommand(LEAN_CMD_RAW);
const LEAN_ARGS = splitArgs(process.env.LEAN_ARGS || '');
const LEAN_WORKDIR = process.env.LEAN_WORKDIR
  ? path.resolve(process.env.LEAN_WORKDIR)
  : '';

const COQ_MAX_CODE_BYTES = Number(process.env.COQ_MAX_CODE_BYTES || 200000);
const COQ_MAX_OUTPUT_CHARS = Number(process.env.COQ_MAX_OUTPUT_CHARS || 200000);
const COQ_TIMEOUT_MS = Number(process.env.COQ_TIMEOUT_MS || 15000);
const COQ_CMD_RAW = process.env.COQ_CMD || 'coqc';
const COQ_CMD = resolveCoqCommand(COQ_CMD_RAW);
const COQ_ARGS = splitArgs(process.env.COQ_ARGS || '');
const COQ_WORKDIR = process.env.COQ_WORKDIR
  ? path.resolve(process.env.COQ_WORKDIR)
  : '';

function resolveLeanCommand(cmd) {
  if (!cmd) return 'lean';
  if (path.isAbsolute(cmd)) return cmd;
  const elanHome = process.env.ELAN_HOME;
  if (elanHome) {
    const candidate = path.join(elanHome, 'bin', cmd);
    if (fsSync.existsSync(candidate)) return candidate;
  }
  return cmd;
}

function resolveCoqCommand(cmd) {
  if (!cmd) return 'coqc';
  if (path.isAbsolute(cmd)) return cmd;
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
      env: options.env || process.env
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ error, stdout, stderr, timedOut });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({ exitCode, signal, stdout, stderr, timedOut });
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
    const result = await runProofCheckLocally(language, req && req.body ? req.body : {});
    res.status(result.httpStatus || 200).json(toHttpBody(result));
  } catch (error) {
    const body = error && error.body && typeof error.body === 'object'
      ? error.body
      : {
          ok: false,
          status: 'error',
          error: error && error.message ? error.message : String(error)
        };
    res.status(error && error.statusCode ? error.statusCode : 500).json(body);
  }
}
