import { createHash } from 'crypto';
import { getSupabaseAdmin } from './supabase-admin.js';

const MAX_CODE_BYTES = Number(process.env.HELPER_MAX_CODE_BYTES || process.env.PROOF_CONVERT_MAX_CODE_BYTES || 250000);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sha256(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function truncateOutput(text, limit = 24000) {
  const value = String(text || '');
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `\n...[output truncated ${value.length - limit} chars]`;
}

function createRequestError(statusCode, message, details = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (details) {
    error.details = details;
  }
  return error;
}

function parseBody(body) {
  if (isPlainObject(body)) return body;
  if (typeof body !== 'string' || !body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function normalizeLanguage(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'lean' || normalized === 'coq') {
    return normalized;
  }
  throw createRequestError(400, 'language must be Lean or Coq.');
}

function defaultFileName(language) {
  return language === 'coq' ? 'Main.v' : 'Main.lean';
}

function normalizeProofState(value) {
  const proofState = String(value || '').trim().toUpperCase();
  return /^(YY|NY|YN|NN)$/.test(proofState) ? proofState : '';
}

function stripCoqCommentsAndStrings(input) {
  return String(input || '')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/"([^"\\]|\\.)*"/g, '""');
}

function stripLeanCommentsAndStrings(input) {
  return String(input || '')
    .replace(/\/-[\s\S]*?-\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/"([^"\\]|\\.)*"/g, '""');
}

function inferProofState(language, code, result) {
  const normalizedLanguage = normalizeLanguage(language);
  const source = normalizedLanguage === 'coq'
    ? stripCoqCommentsAndStrings(code)
    : stripLeanCommentsAndStrings(code);

  if (!String(source || '').trim()) return 'NN';

  if (normalizedLanguage === 'coq') {
    if (/\bAdmitted\s*\.\s*$/i.test(source) || /\bConjecture\b/i.test(source)) return 'NY';
    if (/\b(Qed|Defined)\s*\.\s*$/i.test(source)) return result && result.ok ? 'YY' : 'NN';
    return 'NN';
  }

  if (/\b(sorry|admit|axiom|constant)\b/i.test(source)) return 'NY';
  return result && result.ok ? 'YY' : 'NN';
}

function resolveVerificationStatus(result) {
  if (!result) return 'failed';
  if (result.verifyBeforeConvert === false) return 'skipped';
  return result.ok ? 'verified' : 'failed';
}

function extractLambda(result) {
  const conversion = result && isPlainObject(result.conversion) ? result.conversion : {};
  return conversion.lambda && isPlainObject(conversion.lambda) ? conversion.lambda : {};
}

function buildNormalizedTerm(lambda) {
  if (lambda.term && isPlainObject(lambda.term)) {
    return lambda.term;
  }
  if (Object.prototype.hasOwnProperty.call(lambda, 'term')) {
    return { value: lambda.term };
  }
  if (Object.keys(lambda).length > 0) {
    return lambda;
  }
  return { raw: '' };
}

function isMissingSupabaseRelationError(error, relationName) {
  const message = String(error && (error.message || error.details || error.hint) || '').toLowerCase();
  const relation = String(relationName || '').trim().toLowerCase();
  return (
    error?.code === 'PGRST205'
    || error?.code === '42P01'
    || (relation && message.includes(`could not find the table 'public.${relation}' in the schema cache`))
    || (relation && message.includes(`relation "public.${relation}" does not exist`))
    || (relation && message.includes(`relation "${relation}" does not exist`))
  );
}

function createSupabaseInsertError(error) {
  if (isMissingSupabaseRelationError(error, 'problems')) {
    const supabaseMessage = error && error.message ? error.message : null;
    const lowerMessage = String(supabaseMessage || error?.details || error?.hint || '').toLowerCase();
    const isSchemaCacheMiss = lowerMessage.includes('schema cache');
    return createRequestError(
      503,
      isSchemaCacheMiss
        ? "Supabase REST schema cache does not see public.problems yet. Run supabase/proof_helper.sql again, or run: NOTIFY pgrst, 'reload schema';"
        : 'Supabase table public.problems is missing. Run supabase/proof_helper.sql in the connected Supabase project.',
      { supabaseMessage }
    );
  }

  return createRequestError(
    502,
    error && error.message ? error.message : 'Failed to save the problem to Supabase.',
    { supabaseCode: error && error.code ? error.code : null }
  );
}

function buildProblemRecord(input, result) {
  const language = normalizeLanguage(input.language || result.language);
  const code = typeof input.code === 'string' ? input.code : '';
  if (!code.trim()) {
    throw createRequestError(400, 'Proof code is required.');
  }

  const codeBytes = Buffer.byteLength(code, 'utf8');
  if (codeBytes > MAX_CODE_BYTES) {
    throw createRequestError(413, `Proof code exceeds size limit (${MAX_CODE_BYTES} bytes).`);
  }

  if (!result || !isPlainObject(result)) {
    throw createRequestError(400, 'Helper result is required.');
  }
  if (!result.ok) {
    throw createRequestError(422, 'Only successful helper conversion results can be saved.');
  }

  const conversion = isPlainObject(result.conversion) ? result.conversion : {};
  const lambda = extractLambda(result);
  const planning = result.planning && isPlainObject(result.planning) ? result.planning : {};
  const requestedFormat = String(
    input.requestedFormat
    || input.format
    || conversion.requestedFormat
    || planning.requestedFormat
    || ''
  ).trim() || 'typed-lambda-v1';
  const completedFormat = String(
    lambda.format
    || result.completedFormat
    || conversion.completedFormat
    || planning.completedFormat
    || input.format
    || requestedFormat
  ).trim() || requestedFormat;
  const sourceSha256 = String(input.sourceSha256 || conversion.codeHash || sha256(code)).trim();
  const proofState = normalizeProofState(result.proofState || result.proof_state || input.proofState)
    || inferProofState(language, code, result);
  const jobId = String(input.jobId || input.helperJobId || '').trim();

  return {
    record: {
      title: typeof input.title === 'string' ? input.title.trim() : '',
      language,
      file_name: typeof input.fileName === 'string' && input.fileName.trim()
        ? input.fileName.trim()
        : defaultFileName(language),
      source_code: code,
      source_sha256: sourceSha256,
      proof_state: proofState,
      verification_status: resolveVerificationStatus(result),
      verification_result: {
        proofCheck: result.proofCheck && isPlainObject(result.proofCheck) ? result.proofCheck : null,
        planning: Object.keys(planning).length ? planning : null,
        helperStorage: result.storage && isPlainObject(result.storage) ? result.storage : null
      },
      normalized_format: completedFormat,
      normalized_term: buildNormalizedTerm(lambda),
      adapter_name: String(input.adapterName || conversion.adapter || 'vercel-helper-proof-convert').trim(),
      adapter_meta: {
        planner: planning.planner || 'railway',
        executor: planning.executor || 'github-actions',
        planId: planning.planId || null,
        helperJobId: jobId || null,
        operation: planning.operation || 'submit',
        targetFamily: conversion.targetFamily || null,
        requestedFormat,
        completedFormat,
        fallbackUsed: !!planning.fallbackUsed,
        context: lambda.context || null,
        declarations: lambda.declarations || null,
        metadata: lambda.metadata || null,
        rawText: typeof lambda.rawText === 'string' ? truncateOutput(lambda.rawText) : ''
      },
      helper_job_id: jobId || null,
      request_meta: {
        createdBy: 'vercel-proxy',
        requestedAt: input.requestedAt || null,
        savedAt: new Date().toISOString(),
        sourceBytes: codeBytes,
        helperJobId: jobId || null,
        requestedFormat,
        completedFormat
      }
    },
    jobId
  };
}

export async function persistHelperProblem(body) {
  const input = parseBody(body);
  const result = input.result && isPlainObject(input.result) ? input.result : null;
  const { client, error } = getSupabaseAdmin();

  if (!client) {
    throw createRequestError(503, error || 'Supabase is not configured on this server.');
  }

  const { record, jobId } = buildProblemRecord(input, result);

  if (jobId) {
    const existing = await client
      .from('problems')
      .select('id')
      .eq('helper_job_id', jobId)
      .maybeSingle();

    if (!existing.error && existing.data && existing.data.id) {
      return {
        persisted: true,
        duplicate: true,
        problemId: existing.data.id,
        record
      };
    }

    if (existing.error && isMissingSupabaseRelationError(existing.error, 'problems')) {
      throw createSupabaseInsertError(existing.error);
    }
  }

  const { data, error: insertError } = await client
    .from('problems')
    .insert(record)
    .select('id')
    .single();

  if (insertError) {
    throw createSupabaseInsertError(insertError);
  }

  return {
    persisted: true,
    duplicate: false,
    problemId: data && data.id ? data.id : null,
    record
  };
}

async function checkSupabaseTable(client, tableName) {
  const query = await client
    .from(tableName)
    .select('id', { count: 'exact', head: true });

  if (query.error) {
    return {
      exists: false,
      count: null,
      error: query.error.message || 'Table check failed.',
      code: query.error.code || null
    };
  }

  return {
    exists: true,
    count: Number.isFinite(query.count) ? query.count : 0,
    error: null,
    code: null
  };
}

export async function checkProblemPersistenceStatus() {
  const { client, error } = getSupabaseAdmin();
  const status = {
    configured: Boolean(client),
    error: client ? null : (error || 'Supabase is not configured on this server.'),
    tables: {
      problems: null,
      helper_jobs: null,
      helper_conversion_plans: null
    },
    cic: {
      savedRows: null,
      requestedRows: null,
      fallbackRows: null,
      error: null
    }
  };

  if (!client) {
    return status;
  }

  status.tables.problems = await checkSupabaseTable(client, 'problems');
  status.tables.helper_jobs = await checkSupabaseTable(client, 'helper_jobs');
  status.tables.helper_conversion_plans = await checkSupabaseTable(client, 'helper_conversion_plans');

  if (!status.tables.problems.exists) {
    status.cic.error = status.tables.problems.error || 'public.problems is missing.';
    return status;
  }

  const saved = await client
    .from('problems')
    .select('id', { count: 'exact', head: true })
    .eq('normalized_format', 'cic-v1');
  const requested = await client
    .from('problems')
    .select('id', { count: 'exact', head: true })
    .eq('request_meta->>requestedFormat', 'cic-v1');
  const fallback = await client
    .from('problems')
    .select('id', { count: 'exact', head: true })
    .eq('request_meta->>requestedFormat', 'cic-v1')
    .neq('normalized_format', 'cic-v1');

  const countErrors = [saved.error, requested.error, fallback.error].filter(Boolean);
  if (countErrors.length > 0) {
    status.cic.error = countErrors[0].message || 'CIC row count failed.';
    return status;
  }

  status.cic.savedRows = Number.isFinite(saved.count) ? saved.count : 0;
  status.cic.requestedRows = Number.isFinite(requested.count) ? requested.count : 0;
  status.cic.fallbackRows = Number.isFinite(fallback.count) ? fallback.count : 0;
  return status;
}

export async function sendProblemPersistenceStatusResponse(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');
  try {
    const status = await checkProblemPersistenceStatus();
    const ready = status.configured && !!(status.tables.problems && status.tables.problems.exists);
    res.status(ready ? 200 : 503).json({
      ok: ready,
      status
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}

export async function sendPersistedProblemResponse(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  try {
    const saved = await persistHelperProblem(req && req.body ? req.body : {});
    const originalResult = req && req.body && isPlainObject(req.body.result) ? req.body.result : {};
    const result = {
      ...originalResult,
      problemId: saved.problemId,
      storage: {
        ...(originalResult.storage && isPlainObject(originalResult.storage) ? originalResult.storage : {}),
        persisted: true,
        source: 'vercel-proxy',
        duplicate: saved.duplicate,
        problemId: saved.problemId
      }
    };

    res.status(200).json({
      ok: true,
      success: true,
      problemId: saved.problemId,
      duplicate: saved.duplicate,
      storage: result.storage,
      result
    });
  } catch (error) {
    const originalResult = req && req.body && isPlainObject(req.body.result) ? req.body.result : {};
    const statusCode = error && error.statusCode ? error.statusCode : 500;
    const message = error && error.message ? error.message : String(error);

    if (statusCode === 503 && originalResult && originalResult.ok) {
      const storage = {
        ...(originalResult.storage && isPlainObject(originalResult.storage) ? originalResult.storage : {}),
        persisted: false,
        source: 'vercel-proxy',
        skipped: true,
        reason: 'persist-unavailable',
        error: message
      };

      res.status(statusCode).json({
        ok: false,
        success: false,
        persisted: false,
        storage,
        error: message,
        warning: message,
        details: error && error.details ? error.details : null,
        result: {
          ...originalResult,
          storage,
          persistenceWarning: message
        }
      });
      return;
    }

    res.status(statusCode).json({
      ok: false,
      success: false,
      error: message,
      details: error && error.details ? error.details : null
    });
  }
}
