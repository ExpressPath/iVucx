import express from 'express';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { createClient } from '@supabase/supabase-js';

const app = express();

const PORT = Number(process.env.PORT || 3000);
const MAX_CODE_BYTES = Number(process.env.HELPER_MAX_CODE_BYTES || 200000);
const DEFAULT_TIMEOUT_MS = Number(process.env.HELPER_PROCESS_TIMEOUT_MS || 180000);

const LEAN_TIMEOUT_MS = Number(process.env.LEAN_TIMEOUT_MS || 15000);
const COQ_TIMEOUT_MS = Number(process.env.COQ_TIMEOUT_MS || 15000);
const LEAN_CMD = resolveLeanCommand(process.env.LEAN_CMD || 'lean');
const LEAN_ARGS = splitArgs(process.env.LEAN_ARGS || '');
const LEAN_WORKDIR = process.env.LEAN_WORKDIR ? path.resolve(process.env.LEAN_WORKDIR) : '';
const COQ_CMD = resolveCoqCommand(process.env.COQ_CMD || 'coqc');
const COQ_ARGS = splitArgs(process.env.COQ_ARGS || '');
const COQ_WORKDIR = process.env.COQ_WORKDIR ? path.resolve(process.env.COQ_WORKDIR) : '';

const HELPER_API_KEY = String(process.env.HELPER_API_KEY || '').trim();
const HELPER_LEAN_ADAPTER_CMD = String(process.env.HELPER_LEAN_ADAPTER_CMD || '').trim();
const HELPER_LEAN_ADAPTER_ARGS = splitArgs(process.env.HELPER_LEAN_ADAPTER_ARGS || '');
const HELPER_COQ_ADAPTER_CMD = String(process.env.HELPER_COQ_ADAPTER_CMD || '').trim();
const HELPER_COQ_ADAPTER_ARGS = splitArgs(process.env.HELPER_COQ_ADAPTER_ARGS || '');

const JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed'
};

const jobs = new Map();
let supabaseClient = null;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!HELPER_API_KEY) {
    next();
    return;
  }
  const auth = String(req.headers.authorization || '');
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) {
    res.status(401).json({ ok: false, error: 'Missing helper authorization.' });
    return;
  }
  const received = Buffer.from(auth.slice(prefix.length));
  const expected = Buffer.from(HELPER_API_KEY);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    res.status(403).json({ ok: false, error: 'Invalid helper authorization.' });
    return;
  }
  next();
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'ivucx-railway-helper',
    adapters: getAdapterInfo(),
    supabaseConfigured: !!getSupabaseAdmin().client
  });
});

app.get('/api/helper/info', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'ivucx-railway-helper',
    exactAdapters: getAdapterInfo(),
    supabaseConfigured: !!getSupabaseAdmin().client,
    routes: [
      'GET /api/helper/info',
      'POST /api/helper/check',
      'POST /api/helper/submit',
      'POST /api/helper/convert',
      'GET /api/helper/jobs',
      'GET /api/helper/jobs/:id',
      'GET /api/helper/jobs/:id/result',
      'DELETE /api/helper/jobs/:id'
    ]
  });
});

app.post('/api/helper/check', async (req, res) => {
  try {
    const payload = normalizeProofPayload(req.body || {});
    const verification = await verifyProofPayload(payload);
    res.status(200).json({ ok: verification.ok, verification });
  } catch (err) {
    res.status(400).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

app.post('/api/helper/submit', async (req, res) => {
  await handleConvertRequest(req, res);
});

app.post('/api/helper/convert', async (req, res) => {
  await handleConvertRequest(req, res);
});

async function handleConvertRequest(req, res) {
  try {
    const payload = normalizeProofPayload(req.body || {});
    const wantsAsync = req.body && req.body.async !== false;

    if (!wantsAsync) {
      const result = await executeConversion(payload);
      res.status(200).json({ ok: true, result });
      return;
    }

    const job = createJob(payload);
    await persistJob(job);
    res.status(202).json({ ok: true, job: publicJob(job) });

    queueMicrotask(() => {
      executeJob(job.id).catch((err) => {
        console.error('helper job failed', err);
      });
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}

app.get('/api/helper/jobs', (_req, res) => {
  listJobs().then((list) => {
    res.status(200).json({ ok: true, jobs: list.map(publicJob) });
  }).catch((err) => {
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  });
});

app.get('/api/helper/jobs/:id/result', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  if (job.status !== JOB_STATUS.SUCCEEDED) {
    res.status(409).json({ ok: false, error: 'Helper job is not finished yet.', job: publicJob(job) });
    return;
  }
  res.status(200).json({ ok: true, result: job.result });
});

app.get('/api/helper/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  res.status(200).json({ ok: true, job: publicJob(job) });
});

app.delete('/api/helper/jobs/:id', async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: 'Helper job not found.' });
    return;
  }
  jobs.delete(job.id);
  const { client } = getSupabaseAdmin();
  if (client) {
    await client.from('helper_jobs').delete().eq('id', job.id);
  }
  res.status(200).json({ ok: true, removed: true, jobId: job.id });
});

startServer().catch((err) => {
  console.error('Failed to start ivucx railway helper', err);
  process.exit(1);
});

function splitArgs(value) {
  if (!value) return [];
  return String(value).split(' ').map((part) => part.trim()).filter(Boolean);
}

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

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { client: null, error: 'Supabase environment variables are missing.' };
  }
  if (!supabaseClient) {
    supabaseClient = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return { client: supabaseClient, error: null };
}

function getAdapterInfo() {
  return {
    lean: { configured: !!HELPER_LEAN_ADAPTER_CMD, command: HELPER_LEAN_ADAPTER_CMD || null },
    coq: { configured: !!HELPER_COQ_ADAPTER_CMD, command: HELPER_COQ_ADAPTER_CMD || null }
  };
}

function truncateOutput(text, limit = 200000) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `\n...[output truncated ${value.length - limit} chars]`;
}

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[\[{]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    return null;
  }
}

function normalizeProofPayload(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const language = resolveLanguage(body.language);
  if (language !== 'Lean' && language !== 'Coq') {
    throw new Error('Only Lean and Coq are supported by the helper service.');
  }
  const fileName = typeof body.fileName === 'string' && body.fileName.trim() ? body.fileName.trim() : defaultFileName(language);
  const code = typeof body.code === 'string' ? body.code : '';
  const format = typeof body.format === 'string' && body.format.trim() ? body.format.trim() : 'typed-lambda-v1';
  const verify = body.verify !== false;

  if (!code.trim()) {
    throw new Error('Proof code is required.');
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    throw new Error('Proof code exceeds helper size limit.');
  }

  return { title, language, fileName, code, format, verify };
}

function resolveLanguage(value) {
  const input = String(value || '').trim().toLowerCase();
  if (input === 'coq') return 'Coq';
  if (input === 'isabelle') return 'Isabelle';
  if (input === 'agda') return 'Agda';
  return 'Lean';
}

function defaultFileName(language) {
  if (language === 'Coq') return 'Main.v';
  if (language === 'Isabelle') return 'Main.thy';
  if (language === 'Agda') return 'Main.agda';
  return 'Main.lean';
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    title: job.title,
    language: job.language,
    fileName: job.fileName,
    format: job.format,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    result: job.status === JOB_STATUS.SUCCEEDED ? job.result : null,
    error: job.status === JOB_STATUS.FAILED ? job.error : null,
    problemId: job.problemId || null
  };
}

async function getJob(id) {
  const memory = jobs.get(id);
  if (memory) return memory;
  return loadPersistedJob(id);
}

async function listJobs() {
  const { client } = getSupabaseAdmin();
  if (!client) {
    return Array.from(jobs.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  const { data, error } = await client
    .from('helper_jobs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    return Array.from(jobs.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }
  return Array.isArray(data) ? data.map(hydrateJobRow) : [];
}

async function loadPersistedJob(id) {
  const { client } = getSupabaseAdmin();
  if (!client) return null;
  const { data, error } = await client
    .from('helper_jobs')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  const job = hydrateJobRow(data);
  jobs.set(job.id, job);
  return job;
}

function hydrateJobRow(row) {
  return {
    id: row.id,
    status: row.status || JOB_STATUS.FAILED,
    title: row.title || '',
    language: resolveLanguage(row.language || 'Lean'),
    fileName: row.file_name || defaultFileName(resolveLanguage(row.language || 'Lean')),
    format: row.normalized_format || 'typed-lambda-v1',
    code: '',
    verify: true,
    sourceSha256: row.source_sha256 || '',
    createdAt: row.created_at || nowIso(),
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    result: row.result || null,
    error: row.error || null,
    problemId: row.problem_id || null
  };
}

function createJob(payload) {
  const job = {
    id: randomUUID(),
    status: JOB_STATUS.QUEUED,
    title: payload.title,
    language: payload.language,
    fileName: payload.fileName,
    format: payload.format,
    code: payload.code,
    verify: payload.verify,
    sourceSha256: sha256(payload.code),
    createdAt: nowIso(),
    startedAt: null,
    completedAt: null,
    result: null,
    error: null,
    problemId: null
  };
  jobs.set(job.id, job);
  return job;
}

async function executeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== JOB_STATUS.QUEUED) return;

  job.status = JOB_STATUS.RUNNING;
  job.startedAt = nowIso();
  await persistJob(job);

  try {
    const result = await executeConversion({
      title: job.title,
      language: job.language,
      fileName: job.fileName,
      code: job.code,
      format: job.format,
      verify: job.verify
    });
    job.status = JOB_STATUS.SUCCEEDED;
    job.completedAt = nowIso();
    job.result = result;
    job.problemId = result.problemId || null;
    await persistJob(job);
  } catch (err) {
    job.status = JOB_STATUS.FAILED;
    job.completedAt = nowIso();
    job.error = { message: err && err.message ? err.message : String(err) };
    await persistJob(job);
  }
}

async function persistJob(job) {
  const { client } = getSupabaseAdmin();
  if (!client) return;
  await client.from('helper_jobs').upsert({
    id: job.id,
    status: job.status,
    title: job.title || '',
    language: String(job.language || '').toLowerCase(),
    file_name: job.fileName || '',
    normalized_format: job.format || 'typed-lambda-v1',
    proof_state: job.result && job.result.proofState ? job.result.proofState : null,
    verification_status: job.result && job.result.verification ? job.result.verification.status : null,
    source_sha256: job.sourceSha256,
    result: job.result || null,
    error: job.error || null,
    problem_id: job.problemId || null,
    created_at: job.createdAt,
    updated_at: nowIso(),
    started_at: job.startedAt,
    completed_at: job.completedAt
  });
}

async function executeConversion(payload) {
  const verification = payload.verify
    ? await verifyProofPayload(payload)
    : {
        ok: true,
        status: 'skipped',
        proofState: analyzeProofState(payload.language, payload.code).proofState,
        details: {}
      };

  if (!verification.ok) {
    throw new Error(verification.error || 'Proof verification failed.');
  }

  const adapterResult = await runExactAdapter(payload, verification);
  const proofState = resolveStoredProofState(verification, adapterResult);
  const saved = await saveProblemRecord(payload, verification, adapterResult, proofState);

  return {
    problemId: saved.id,
    proofState,
    verification: { status: verification.status, durationMs: verification.durationMs || null },
    normalization: { format: payload.format, adapter: adapterResult.adapter, exact: true },
    savedAt: saved.created_at || nowIso(),
    row: { id: saved.id }
  };
}

async function saveProblemRecord(payload, verification, adapterResult, proofState) {
  const { client, error } = getSupabaseAdmin();
  if (!client) {
    throw new Error(error || 'Supabase is not configured on the helper server.');
  }

  const requestMeta = {
    sourceLanguage: payload.language,
    fileName: payload.fileName,
    sourceBytes: Buffer.byteLength(payload.code, 'utf8')
  };

  const record = {
    title: payload.title || '',
    language: payload.language.toLowerCase(),
    file_name: payload.fileName || '',
    source_code: payload.code,
    source_sha256: sha256(payload.code),
    proof_state: proofState,
    verification_status: verification.status,
    verification_result: verification.details || {},
    normalized_format: adapterResult.format || payload.format,
    normalized_term: adapterResult.term,
    adapter_name: adapterResult.adapter || '',
    adapter_meta: adapterResult.meta || {},
    helper_job_id: adapterResult.jobId || null,
    request_meta: requestMeta
  };

  const { data, error: insertError } = await client.from('problems').insert(record).select('id, created_at').single();
  if (insertError) {
    throw new Error(insertError.message || 'Failed to save problem row.');
  }
  return data || { id: null, created_at: nowIso() };
}

function resolveStoredProofState(verification, adapterResult) {
  const adapterProofState = normalizeProofState(
    adapterResult && typeof adapterResult === 'object' ? adapterResult.proofState : null
  );
  if (adapterProofState) {
    return adapterProofState;
  }
  return normalizeProofState(verification && verification.proofState) || 'NN';
}

function normalizeProofState(value) {
  const proofState = String(value || '').trim().toUpperCase();
  return /^(YY|NY|YN|NN)$/.test(proofState) ? proofState : '';
}

async function runExactAdapter(payload, verification) {
  const adapter = payload.language === 'Coq'
    ? { cmd: HELPER_COQ_ADAPTER_CMD, args: HELPER_COQ_ADAPTER_ARGS, name: 'coq-exact-adapter' }
    : { cmd: HELPER_LEAN_ADAPTER_CMD, args: HELPER_LEAN_ADAPTER_ARGS, name: 'lean-exact-adapter' };

  if (!adapter.cmd) {
    throw new Error(
      payload.language === 'Coq'
        ? 'Exact Coq adapter is not configured. Set HELPER_COQ_ADAPTER_CMD / HELPER_COQ_ADAPTER_ARGS.'
        : 'Exact Lean adapter is not configured. Set HELPER_LEAN_ADAPTER_CMD / HELPER_LEAN_ADAPTER_ARGS.'
    );
  }

  const input = {
    schema: 'ivucx-helper-adapter-request-v1',
    title: payload.title,
    language: payload.language,
    fileName: payload.fileName,
    code: payload.code,
    requestedFormat: payload.format,
    verification: {
      proofState: verification.proofState,
      status: verification.status
    }
  };

  const result = await runJsonAdapter(adapter.cmd, adapter.args, input, DEFAULT_TIMEOUT_MS);
  const term = result && typeof result === 'object' && result.term
    ? result.term
    : (result && result.result && result.result.term ? result.result.term : null);

  if (!term || typeof term !== 'object') {
    throw new Error('Exact adapter did not return a `term` object.');
  }

  return {
    adapter: typeof result.adapter === 'string' && result.adapter.trim() ? result.adapter.trim() : adapter.name,
    format: typeof result.format === 'string' && result.format.trim() ? result.format.trim() : payload.format,
    term,
    meta: result.meta && typeof result.meta === 'object' ? result.meta : {},
    proofState: normalizeProofState(
      result.proofState || (result.result && result.result.proofState ? result.result.proofState : '')
    )
  };
}

async function runJsonAdapter(cmd, args, input, timeoutMs) {
  const result = await runProcess(cmd, args, {
    cwd: process.cwd(),
    timeoutMs,
    stdin: JSON.stringify(input)
  });

  if (result.error) {
    throw new Error(result.error.message || String(result.error));
  }
  if (result.timedOut) {
    throw new Error('Exact adapter timed out.');
  }
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Exact adapter failed.');
  }
  const payload = tryParseJson(result.stdout);
  if (!payload || typeof payload !== 'object') {
    throw new Error('Exact adapter returned invalid JSON.');
  }
  return payload;
}

async function verifyProofPayload(payload) {
  const closure = analyzeProofState(payload.language, payload.code);
  if (closure.proofState === 'NN') {
    return {
      ok: false,
      status: 'failed',
      proofState: 'NN',
      error: closure.reason || 'Proof is empty or incomplete.',
      details: { closure }
    };
  }

  if (payload.language === 'Coq') {
    const result = await runCoqVerification(payload.code);
    if (!result.ok) {
      return {
        ok: false,
        status: 'failed',
        proofState: closure.proofState,
        error: result.error || 'Coq verification failed.',
        durationMs: result.durationMs || null,
        details: result
      };
    }
    return {
      ok: true,
      status: 'verified',
      proofState: closure.proofState,
      durationMs: result.durationMs || null,
      details: result
    };
  }

  if (payload.language === 'Lean') {
    const result = await runLeanVerification(payload.code);
    if (!result.ok) {
      return {
        ok: false,
        status: 'failed',
        proofState: closure.proofState,
        error: result.error || 'Lean verification failed.',
        durationMs: result.durationMs || null,
        details: result
      };
    }
    return {
      ok: true,
      status: 'verified',
      proofState: closure.proofState,
      durationMs: result.durationMs || null,
      details: result
    };
  }

  return {
    ok: false,
    status: 'failed',
    proofState: closure.proofState,
    error: 'Only Coq and Lean are supported by the helper service.',
    details: {}
  };
}

function analyzeProofState(language, code) {
  return language === 'Coq' ? analyzeCoqClosure(code) : analyzeLeanClosure(code);
}

async function prepareLeanFile(code) {
  const baseDir = LEAN_WORKDIR ? LEAN_WORKDIR : await fs.mkdtemp(path.join(os.tmpdir(), 'ivucx-lean-helper-'));
  const tmpDir = LEAN_WORKDIR ? path.join(baseDir, '.ivucx_tmp') : baseDir;
  await fs.mkdir(tmpDir, { recursive: true });
  const fileName = 'Main_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.lean';
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, code, 'utf8');
  return { baseDir, tmpDir, filePath, cleanupBase: !LEAN_WORKDIR };
}

async function prepareCoqFile(code) {
  const baseDir = COQ_WORKDIR ? COQ_WORKDIR : await fs.mkdtemp(path.join(os.tmpdir(), 'ivucx-coq-helper-'));
  const tmpDir = COQ_WORKDIR ? path.join(baseDir, '.ivucx_tmp') : baseDir;
  await fs.mkdir(tmpDir, { recursive: true });
  const fileName = 'Main_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10) + '.v';
  const filePath = path.join(tmpDir, fileName);
  await fs.writeFile(filePath, code, 'utf8');
  return { baseDir, tmpDir, filePath, cleanupBase: !COQ_WORKDIR };
}

async function cleanupLeanFile(info) {
  if (!info) return;
  try { await fs.unlink(info.filePath); } catch (_err) {}
  if (info.cleanupBase) {
    try { await fs.rm(info.baseDir, { recursive: true, force: true }); } catch (_err) {}
  }
}

async function cleanupCoqFile(info) {
  if (!info) return;
  if (!info.cleanupBase && info.tmpDir && info.tmpDir !== info.baseDir) {
    try { await fs.rm(info.tmpDir, { recursive: true, force: true }); return; } catch (_err) {}
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
    try { await fs.unlink(filePath); } catch (_err) {}
  }
  if (info.cleanupBase) {
    try { await fs.rm(info.baseDir, { recursive: true, force: true }); } catch (_err) {}
  }
}

async function runLeanVerification(code) {
  let info = null;
  const startedAt = Date.now();
  try {
    info = await prepareLeanFile(code);
    const result = await runProcess(LEAN_CMD, [...LEAN_ARGS, info.filePath], {
      cwd: LEAN_WORKDIR || info.baseDir,
      timeoutMs: LEAN_TIMEOUT_MS
    });
    await cleanupLeanFile(info);
    if (result.error) {
      const isMissing = result.error && result.error.code === 'ENOENT';
      return {
        ok: false,
        error: isMissing ? 'Lean executable not found on helper server.' : (result.error.message || String(result.error)),
        durationMs: Date.now() - startedAt,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr)
      };
    }
    return {
      ok: !result.timedOut && result.exitCode === 0,
      status: result.timedOut ? 'timeout' : (result.exitCode === 0 ? 'ok' : 'error'),
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr)
    };
  } catch (err) {
    await cleanupLeanFile(info);
    return { ok: false, error: err && err.message ? err.message : String(err), durationMs: Date.now() - startedAt };
  }
}

async function runCoqVerification(code) {
  let info = null;
  const startedAt = Date.now();
  try {
    info = await prepareCoqFile(code);
    const result = await runProcess(COQ_CMD, [...COQ_ARGS, info.filePath], {
      cwd: COQ_WORKDIR || info.baseDir,
      timeoutMs: COQ_TIMEOUT_MS
    });
    await cleanupCoqFile(info);
    if (result.error) {
      const isMissing = result.error && result.error.code === 'ENOENT';
      return {
        ok: false,
        error: isMissing ? 'Coq executable not found on helper server.' : (result.error.message || String(result.error)),
        durationMs: Date.now() - startedAt,
        stdout: truncateOutput(result.stdout),
        stderr: truncateOutput(result.stderr)
      };
    }
    return {
      ok: !result.timedOut && result.exitCode === 0,
      status: result.timedOut ? 'timeout' : (result.exitCode === 0 ? 'ok' : 'error'),
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      stdout: truncateOutput(result.stdout),
      stderr: truncateOutput(result.stderr)
    };
  } catch (err) {
    await cleanupCoqFile(info);
    return { ok: false, error: err && err.message ? err.message : String(err), durationMs: Date.now() - startedAt };
  }
}

function runProcess(cmd, args, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finalize = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env || process.env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);

    if (typeof options.stdin === 'string') {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      finalize({ error, stdout, stderr, timedOut });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finalize({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

function stripLeanCommentsAndStrings(input) {
  let output = '';
  let i = 0;
  let blockCommentDepth = 0;
  let inString = false;
  let inLineComment = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i += 1;
      continue;
    }

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        output += ch;
      }
      i += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (ch === '/' && next === '-') { blockCommentDepth += 1; i += 2; continue; }
      if (ch === '-' && next === '/') { blockCommentDepth -= 1; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '-' && next === '-') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '-') { blockCommentDepth = 1; i += 2; continue; }

    output += ch;
    i += 1;
  }

  return output;
}

function analyzeLeanClosure(code) {
  if (!code || typeof code !== 'string') {
    return { proofState: 'NN', reason: 'Code is empty' };
  }
  const normalized = stripLeanCommentsAndStrings(code).trim();
  if (!normalized) {
    return { proofState: 'NN', reason: 'Code is empty' };
  }
  if (/\b(sorry|admit)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'sorry/admit' };
  }
  if (/(^|\n)\s*(axiom|constant)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'axiom/constant' };
  }
  return { proofState: 'YY', closer: 'Lean checked' };
}

function stripCoqCommentsAndStrings(input) {
  let output = '';
  let i = 0;
  let commentDepth = 0;
  let inString = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') { inString = false; }
      i += 1;
      continue;
    }

    if (commentDepth > 0) {
      if (ch === '(' && next === '*') { commentDepth += 1; i += 2; continue; }
      if (ch === '*' && next === ')') { commentDepth -= 1; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '"') { inString = true; i += 1; continue; }
    if (ch === '(' && next === '*') { commentDepth = 1; i += 2; continue; }

    output += ch;
    i += 1;
  }

  return output;
}

function isConjectureTail(normalized) {
  const matches = Array.from(normalized.matchAll(/\bConjecture\b/g));
  if (matches.length === 0) return false;
  const last = matches[matches.length - 1];
  const idx = typeof last.index === 'number' ? last.index : -1;
  if (idx < 0) return false;
  const tail = normalized.slice(idx).trim();
  if (!tail.endsWith('.')) return false;
  const dotCount = (tail.match(/\./g) || []).length;
  return dotCount === 1;
}

function analyzeCoqClosure(code) {
  if (!code || typeof code !== 'string') {
    return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
  }
  const normalized = stripCoqCommentsAndStrings(code).trim();
  if (!normalized) {
    return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
  }
  if (/\bAdmitted\./.test(normalized)) return { proofState: 'NY', closer: 'Admitted.' };
  if (/\b(Axiom|Axioms|Parameter|Parameters|Hypothesis|Hypotheses|Variable|Variables|Conjecture)\b/.test(normalized)) {
    return { proofState: 'NY', closer: 'Axiom/Parameter/Conjecture' };
  }
  if (isConjectureTail(normalized)) return { proofState: 'NY', closer: 'Conjecture.' };
  if (/Defined\.\s*$/.test(normalized)) return { proofState: 'YY', closer: 'Defined.' };
  if (/Qed\.\s*$/.test(normalized)) return { proofState: 'YY', closer: 'Qed.' };
  return { proofState: 'NN', reason: 'The proof must end with Qed. / Defined. / Admitted. / Conjecture.' };
}

async function recoverStaleJobs() {
  const { client } = getSupabaseAdmin();
  if (!client) return;
  const restartMessage = {
    message: 'Helper server restarted before the job finished.'
  };
  try {
    await client
      .from('helper_jobs')
      .update({
        status: JOB_STATUS.FAILED,
        error: restartMessage,
        updated_at: nowIso(),
        completed_at: nowIso()
      })
      .in('status', [JOB_STATUS.QUEUED, JOB_STATUS.RUNNING]);
  } catch (err) {
    console.warn('Failed to recover stale helper jobs', err);
  }
}

async function startServer() {
  await recoverStaleJobs();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ivucx railway helper listening on ${PORT}`);
  });
}
