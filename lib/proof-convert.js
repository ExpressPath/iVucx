import { createHash } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { runProofCheckLocally } from './proof-check.js';
import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorDetails, getPublicErrorMessage } from './http-error.js';
import { buildProofProcessEnv } from './proof-process-env.js';
import {
  isolatedProcessOptions,
  prepareProofProcessCommand,
  terminateProcessTree
} from './child-process-tree.js';
import { runProofTaskWithLimit } from './proof-task-limit.js';
import { getSupabaseAdmin } from './supabase-admin.js';
import { assertProofRequestAllowed } from './request-guard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const serverToolsDir = path.join(repoRoot, 'server-tools');

const MAX_CODE_BYTES = Number(process.env.PROOF_CONVERT_MAX_CODE_BYTES || 250000);
const MAX_OUTPUT_CHARS = Number(process.env.PROOF_CONVERT_MAX_OUTPUT_CHARS || 12000);
const PROCESS_TIMEOUT_MS = Number(process.env.PROOF_CONVERT_TIMEOUT_MS || 180000);
const PROCESS_CAPTURE_CHARS = Math.max(4096, Number(process.env.PROOF_CONVERT_CAPTURE_CHARS || 48000));
const MAX_OUTPUT_FILE_BYTES = Math.max(65536, Number(process.env.PROOF_CONVERT_OUTPUT_MAX_BYTES || 4 * 1024 * 1024));

function splitArgs(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') {
    return [];
  }

  const args = [];
  let current = '';
  let quote = null;

  for (let index = 0; index < rawValue.length; index += 1) {
    const ch = rawValue[index];

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && index + 1 < rawValue.length) {
        index += 1;
        current += rawValue[index];
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function truncateOutput(value) {
  const text = String(value || '');
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
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

function normalizeLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }
  const error = new Error('language must be Lean or Coq');
  error.statusCode = 400;
  throw error;
}

function normalizeRequestedFormat(format) {
  return String(format || '').trim().toLowerCase();
}

async function resolvePlannedPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !payload.planId) {
    return payload || {};
  }

  const hasInlineSource = typeof payload.code === 'string' && payload.code.trim();
  const hasInlineLanguage = typeof payload.language === 'string' && payload.language.trim();
  const hasInlineFileName = typeof payload.fileName === 'string' && payload.fileName.trim();
  const hasInlineFormat = typeof payload.format === 'string' && payload.format.trim();

  if (hasInlineSource && hasInlineLanguage && hasInlineFileName && hasInlineFormat) {
    return payload;
  }

  const { client, error } = getSupabaseAdmin();
  if (!client) {
    const requestError = new Error(error || 'Supabase is required to load the conversion plan.');
    requestError.statusCode = 503;
    throw requestError;
  }

  const planId = String(payload.planId).trim();
  const { data, error: loadError } = await client
    .from('helper_conversion_plans')
    .select('id, title, language, file_name, requested_format, verify, source_code, source_sha256')
    .eq('id', planId)
    .maybeSingle();

  if (loadError) {
    const requestError = new Error(
      loadError.message
      || 'Failed to load the conversion plan from Supabase. Railway should pass the execution payload directly to Render.'
    );
    requestError.statusCode = 502;
    throw requestError;
  }

  if (!data) {
    const requestError = new Error('Conversion plan was not found in Supabase.');
    requestError.statusCode = 404;
    throw requestError;
  }

  return {
    ...payload,
    title: typeof payload.title === 'string' && payload.title.trim() ? payload.title : (data.title || ''),
    language: typeof payload.language === 'string' && payload.language.trim() ? payload.language : data.language,
    fileName: typeof payload.fileName === 'string' && payload.fileName.trim() ? payload.fileName : data.file_name,
    code: typeof payload.code === 'string' && payload.code.trim() ? payload.code : data.source_code,
    format: typeof payload.format === 'string' && payload.format.trim() ? payload.format : data.requested_format,
    verify: typeof payload.verify === 'boolean' ? payload.verify : data.verify !== false,
    planId,
    sourceSha256: data.source_sha256 || null
  };
}

function readCommand(envValue, fallbackValue) {
  const trimmed = typeof envValue === 'string' ? envValue.trim() : '';
  return trimmed || fallbackValue;
}

function readArgs(envValue, fallbackValue) {
  const trimmed = typeof envValue === 'string' ? envValue.trim() : '';
  return trimmed ? splitArgs(trimmed) : fallbackValue.slice();
}

function normalizeNodeScriptArgs(command, args) {
  const normalizedCommand = path.basename(String(command || '')).toLowerCase();
  const nodeExecutable = path.basename(process.execPath || '').toLowerCase();

  if (normalizedCommand !== 'node' && normalizedCommand !== 'node.exe' && normalizedCommand !== nodeExecutable) {
    return Array.isArray(args) ? args.slice() : [];
  }

  let scriptResolved = false;
  return (Array.isArray(args) ? args : []).map((arg) => {
    const value = String(arg || '');

    if (scriptResolved) {
      return value;
    }

    if (!value || value.startsWith('-')) {
      return value;
    }

    scriptResolved = true;
    if (value.includes('{') || path.isAbsolute(value)) {
      return value;
    }

    return path.resolve(repoRoot, value);
  });
}

function buildConverter(command, args, stdoutFormat, resultFormat, extension, defaultFileName) {
  return {
    command,
    args: normalizeNodeScriptArgs(command, args),
    stdoutFormat,
    resultFormat,
    extension,
    defaultFileName
  };
}

const converters = {
  lean: buildConverter(
    readCommand(process.env.LEAN_LAMBDA_CMD, process.execPath),
    readArgs(process.env.LEAN_LAMBDA_ARGS, [path.join(serverToolsDir, 'convert-lean.cjs'), '--out', '{out}']),
    String(process.env.LEAN_LAMBDA_STDOUT_FORMAT || 'json').toLowerCase(),
    process.env.LEAN_LAMBDA_RESULT_FORMAT || 'typed-lambda-v1',
    '.lean',
    'Main.lean'
  ),
  coq: buildConverter(
    readCommand(process.env.COQ_LAMBDA_CMD, process.execPath),
    readArgs(process.env.COQ_LAMBDA_ARGS, [path.join(serverToolsDir, 'convert-coq.cjs'), '--out', '{out}']),
    String(process.env.COQ_LAMBDA_STDOUT_FORMAT || 'json').toLowerCase(),
    process.env.COQ_LAMBDA_RESULT_FORMAT || 'typed-lambda-v1',
    '.v',
    'Main.v'
  )
};

const cicConverters = {
  lean: buildConverter(
    readCommand(process.env.LEAN_CIC_CMD, process.execPath),
    readArgs(process.env.LEAN_CIC_ARGS, [path.join(serverToolsDir, 'convert-lean-cic.cjs'), '--out', '{out}']),
    String(process.env.LEAN_CIC_STDOUT_FORMAT || 'json').toLowerCase(),
    process.env.LEAN_CIC_RESULT_FORMAT || 'cic-v1',
    '.lean',
    'Main.lean'
  ),
  coq: buildConverter(
    readCommand(process.env.COQ_CIC_CMD, process.execPath),
    readArgs(process.env.COQ_CIC_ARGS, [path.join(serverToolsDir, 'convert-coq-cic.cjs'), '--out', '{out}']),
    String(process.env.COQ_CIC_STDOUT_FORMAT || 'json').toLowerCase(),
    process.env.COQ_CIC_RESULT_FORMAT || 'cic-v1',
    '.v',
    'Main.v'
  )
};

function describeConverterAvailability(converter, family, route) {
  return {
    available: !!(converter && converter.command),
    family,
    route,
    command: converter && converter.command ? converter.command : null,
    resultFormat: converter && converter.resultFormat ? converter.resultFormat : null
  };
}

export function getProofConversionRuntimes() {
  return {
    typedLambda: {
      lean: describeConverterAvailability(converters.lean, 'typed-lambda', '/api/proof-convert'),
      coq: describeConverterAvailability(converters.coq, 'typed-lambda', '/api/proof-convert')
    },
    cic: {
      lean: describeConverterAvailability(cicConverters.lean, 'cic', '/api/proof-convert'),
      coq: describeConverterAvailability(cicConverters.coq, 'cic', '/api/proof-convert')
    }
  };
}

function sanitizeFileName(fileName, fallbackFileName, extension) {
  const trimmed = typeof fileName === 'string' ? fileName.trim() : '';
  const baseName = path.basename(trimmed || fallbackFileName);
  const parsed = path.parse(baseName || fallbackFileName);
  const expectedExtension = extension || parsed.ext;
  return `${parsed.name || 'Main'}${expectedExtension}`;
}

function resolveArgs(args, replacements) {
  const templates = Array.isArray(args) ? args : [];
  const resolved = templates.map((arg) => String(arg)
    .replaceAll('{file}', replacements.filePath)
    .replaceAll('{out}', replacements.outputPath)
    .replaceAll('{name}', replacements.fileName)
    .replaceAll('{dir}', replacements.tempDir));

  if (!templates.some((arg) => String(arg).includes('{file}'))) {
    resolved.push(replacements.filePath);
  }

  return resolved;
}

function safeParseJson(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeLambdaPayload(structured, fallbackText, fallbackFormat) {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const term = structured.term || structured.lambda || structured.expression || structured.normalized || structured.ast || structured;

    return {
      format: structured.format || fallbackFormat || 'typed-lambda-v1',
      term,
      context: structured.context || structured.ctx || null,
      declarations: structured.declarations || null,
      metadata: structured.metadata || null,
      rawText: typeof fallbackText === 'string' ? fallbackText : ''
    };
  }

  return {
    format: fallbackFormat || 'typed-lambda-v1',
    term: typeof fallbackText === 'string' ? fallbackText.trim() : '',
    context: null,
    declarations: null,
    metadata: null,
    rawText: typeof fallbackText === 'string' ? fallbackText : ''
  };
}

async function runCommandForCode(options) {
  const {
    command,
    args,
    code,
    fileName,
    defaultFileName,
    extension,
    timeoutMs,
    tempPrefix
  } = options;

  if (!command || typeof command !== 'string') {
    const error = new Error('Command is not configured');
    error.statusCode = 503;
    throw error;
  }

  const normalizedCode = typeof code === 'string' ? code : '';
  if (!normalizedCode.trim()) {
    const error = new Error('code must be a non-empty string');
    error.statusCode = 400;
    throw error;
  }

  const codeBytes = Buffer.byteLength(normalizedCode, 'utf8');
  if (codeBytes > MAX_CODE_BYTES) {
    const error = new Error(`code is too large; max ${MAX_CODE_BYTES} bytes`);
    error.statusCode = 413;
    throw error;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), tempPrefix || 'ivucx-convert-'));
  const safeFileName = sanitizeFileName(fileName, defaultFileName, extension);
  const filePath = path.join(tempDir, safeFileName);
  const outputPath = path.join(tempDir, 'result.out');
  const startedAt = Date.now();

  await fs.writeFile(filePath, normalizedCode, 'utf8');

  return new Promise((resolve, reject) => {
    const resolvedArgs = resolveArgs(args, {
      filePath,
      outputPath,
      fileName: safeFileName,
      tempDir
    });

    let prepared;
    try {
      prepared = prepareProofProcessCommand(command, resolvedArgs, { cwd: tempDir });
    } catch (error) {
      void fs.rm(tempDir, { recursive: true, force: true }).finally(() => reject(error));
      return;
    }

    const child = spawn(prepared.command, prepared.args, {
      cwd: tempDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildProofProcessEnv({}, { workdir: tempDir }),
      ...isolatedProcessOptions()
    });

    const captureLimit = Math.max(4096, Number(options.captureLimitChars || PROCESS_CAPTURE_CHARS));
    const stdoutBuffer = createBoundedOutputBuffer(captureLimit);
    const stderrBuffer = createBoundedOutputBuffer(captureLimit);
    let timedOut = false;
    let settled = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs || PROCESS_TIMEOUT_MS);

    const cleanup = async () => {
      clearTimeout(timeout);
      await fs.rm(tempDir, { recursive: true, force: true });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer.push(chunk);
    });

    child.on('error', async (error) => {
      if (settled) {
        return;
      }
      settled = true;
      await cleanup();
      const wrapped = new Error(`Failed to start command '${command}': ${error.message}`);
      wrapped.statusCode = 500;
      reject(wrapped);
    });

    child.on('close', async (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;

      let outputText = '';
      try {
        const outputStat = await fs.stat(outputPath);
        if (outputStat.size > MAX_OUTPUT_FILE_BYTES) {
          const error = new Error('Proof conversion output exceeds the server size limit.');
          error.statusCode = 413;
          throw error;
        }
        outputText = await fs.readFile(outputPath, 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') {
          await cleanup();
          reject(error);
          return;
        }
      }

      await cleanup();

      resolve({
        ok: exitCode === 0 && !timedOut,
        command,
        args: resolvedArgs,
        fileName: safeFileName,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        codeBytes,
        stdout: stdoutBuffer.value(),
        stderr: stderrBuffer.value(),
        outputText
      });
    });
  });
}

function resolveConverter(language, requestedFormat) {
  const normalizedFormat = normalizeRequestedFormat(requestedFormat);
  if (normalizedFormat === 'cic' || normalizedFormat === 'cic-v1') {
    const converter = cicConverters[language];
    if (!converter || !converter.command) {
      const error = new Error(`${language} CIC converter is not configured`);
      error.statusCode = 503;
      throw error;
    }
    return {
      family: 'cic',
      converter
    };
  }

  const converter = converters[language];
  if (!converter || !converter.command) {
    const error = new Error(`${language} lambda converter is not configured`);
    error.statusCode = 503;
    throw error;
  }

  return {
    family: 'typed-lambda',
    converter
  };
}

async function runConversionOnly(payload = {}) {
  const normalizedLanguage = normalizeLanguage(payload.language);
  const resolved = resolveConverter(normalizedLanguage, payload.format);
  const converter = resolved.converter;
  const normalizedCode = typeof payload.code === 'string' ? payload.code : '';

  const execution = await runCommandForCode({
    command: converter.command,
    args: converter.args,
    code: normalizedCode,
    fileName: payload.fileName,
    defaultFileName: converter.defaultFileName,
    extension: converter.extension,
    timeoutMs: PROCESS_TIMEOUT_MS,
    tempPrefix: `ivucx-convert-${normalizedLanguage}-`
  });

  const rawOutput = execution.outputText || execution.stdout;
  const structured = converter.stdoutFormat === 'json' ? safeParseJson(rawOutput) : null;

  if (converter.stdoutFormat === 'json' && rawOutput && !structured && execution.ok) {
    const error = new Error(`${normalizedLanguage} converter returned invalid JSON`);
    error.statusCode = 502;
    error.details = {
      stdout: truncateOutput(execution.stdout),
      stderr: truncateOutput(execution.stderr)
    };
    throw error;
  }

  return {
    ok: execution.ok,
    language: normalizedLanguage,
    planId: payload && payload.planId ? payload.planId : null,
    targetFamily: resolved.family,
    requestedFormat: payload && payload.format ? payload.format : null,
    fileName: execution.fileName,
    command: execution.command,
    args: execution.args,
    exitCode: execution.exitCode,
    signal: execution.signal,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    codeBytes: execution.codeBytes,
    codeHash: createHash('sha256').update(normalizedCode, 'utf8').digest('hex'),
    stdout: truncateOutput(execution.stdout),
    stderr: truncateOutput(execution.stderr),
    lambda: normalizeLambdaPayload(structured, rawOutput, payload && payload.format ? payload.format : converter.resultFormat)
  };
}

export async function runProofConversionLocally(payload = {}) {
  const normalizedPayload = await resolvePlannedPayload(payload || {});
  const verifyBeforeConvert = normalizedPayload.verify !== false;

  let proofCheck = null;
  if (verifyBeforeConvert) {
    proofCheck = await runProofCheckLocally(normalizedPayload.language, normalizedPayload);
    if (!proofCheck.ok) {
      return {
      ok: false,
      stage: 'proof-check',
      timedOut: proofCheck.timedOut,
      httpStatus: proofCheck.httpStatus || 422,
      language: normalizeLanguage(normalizedPayload.language),
      planId: normalizedPayload.planId || null,
      verifyBeforeConvert,
      proofCheck,
      conversion: null
    };
    }
  }

  const conversion = await runConversionOnly(normalizedPayload);
  if (!conversion.ok) {
    return {
      ok: false,
      stage: 'conversion',
      timedOut: conversion.timedOut,
      httpStatus: conversion.timedOut ? 504 : 422,
      language: conversion.language,
      planId: normalizedPayload.planId || null,
      verifyBeforeConvert,
      proofCheck,
      conversion
    };
  }

  return {
    ok: true,
    stage: 'completed',
    timedOut: false,
    httpStatus: 200,
    language: conversion.language,
    planId: normalizedPayload.planId || null,
    verifyBeforeConvert,
    proofCheck,
    conversion
  };
}

function statusCodeForResult(result) {
  if (result && typeof result.httpStatus === 'number') {
    return result.httpStatus;
  }
  if (result && result.ok) {
    return 200;
  }
  if (result && result.timedOut) {
    return 504;
  }
  return 422;
}

export async function sendProofConversionResponse(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const requestBody = req && req.body && typeof req.body === 'object'
      ? { ...req.body, verify: true }
      : { verify: true };
    assertProofRequestAllowed(req, '/api/proof-convert', { body: requestBody });
    await assertDistributedRateLimit(req, { route: 'proof-submit', limit: 10, windowSeconds: 60 });
    const result = await runProofTaskWithLimit(
      () => runProofConversionLocally(requestBody),
      { kind: 'proof-convert' }
    );
    const status = statusCodeForResult(result);
    res.status(status).json(process.env.NODE_ENV === 'production' && status >= 500
      ? { success: false, error: 'Proof conversion failed.' }
      : { success: Boolean(result.ok), result });
  } catch (error) {
    if (error.retryAfter) {
      res.setHeader('Retry-After', String(error.retryAfter));
    }
    const status = getHttpErrorStatus(error);
    res.status(status).json({
      success: false,
      error: getPublicErrorMessage(error, 'Proof conversion failed.', status),
      details: getPublicErrorDetails(error && error.details, status)
    });
  }
}
