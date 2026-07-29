import { createHash, randomUUID } from 'crypto';
import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { normalizeConditionalFunding } from './conditional-share.js';
import { getSupabaseAdmin, getSupabaseAdminDiagnostics } from './supabase-admin.js';
import { getIvucxIdentity } from './ivucx.js';
import { identityOwnsProblem, issueProblemCapability } from './problem-access.js';
import {
  assertPortableCicTarget,
  assertProblemProofBinding,
  buildCicBindingGuard,
  hashCicTarget
} from './problem-proof-binding.js';
import { verifyJobCapability } from './job-access.js';
import { requestProofCheck, requestProofConversion } from './helper-proxy.js';
import {
  allowedConditionalAssumptionNames,
  buildProofAssumptionAudit,
  findProofAuditTarget,
  parseProofAssumptions
} from './proof-assumptions.js';
import { assertProofRequestAllowed } from './request-guard.js';
import {
  verifyBountyCheckoutSession,
  verifyConditionalCheckoutSession
} from './stripe-payment-verify.js';

const MAX_CODE_BYTES = Number(process.env.HELPER_MAX_CODE_BYTES || process.env.PROOF_CONVERT_MAX_CODE_BYTES || 250000);
const PROBLEM_REQUIRED_COLUMNS = Object.freeze([
  'id',
  'title',
  'language',
  'file_name',
  'source_code',
  'source_sha256',
  'proof_state',
  'verification_status',
  'verification_result',
  'normalized_format',
  'normalized_term',
  'adapter_name',
  'adapter_meta',
  'helper_job_id',
  'request_meta',
  'created_at',
  'updated_at'
]);

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

function readJobCapability(req, input) {
  const header = req && req.headers ? req.headers['x-ivucx-job-token'] : '';
  const headerValue = Array.isArray(header) ? header[0] : header;
  return String(headerValue || (input && input.jobToken) || '').trim();
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

function normalizeBounty(value) {
  if (!isPlainObject(value)) return null;
  const amountCents = Math.round(Number(value.amountCents || value.amount_cents || value.amountTotal || 0));
  if (!Number.isFinite(amountCents) || amountCents <= 0) return null;
  const currency = String(value.currency || 'usd').trim().toLowerCase();
  return {
    amountCents,
    currency: /^[a-z]{3}$/.test(currency) ? currency : 'usd',
    status: String(value.status || '').trim(),
    paymentStatus: String(value.paymentStatus || value.payment_status || '').trim(),
    stripeSessionId: String(value.stripeSessionId || value.sessionId || '').trim(),
    stripePaymentIntentId: String(value.stripePaymentIntentId || value.paymentIntentId || '').trim(),
    serverVerified: value.serverVerified === true,
    verifiedAt: String(value.verifiedAt || '').trim(),
    updatedAt: String(value.updatedAt || '').trim()
  };
}

function normalizeProofState(value) {
  const proofState = String(value || '').trim().toUpperCase();
  return /^(YY|NY|YN|NN)$/.test(proofState) ? proofState : '';
}

function normalizeProblemKind(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'problem' || text === 'problems' || text === 'unsolved' || text === 'q') return 'problem';
  if (text === 'theorem' || text === 'theorems' || text === 'proof' || text === 'proofs' || text === 'solved' || text === 'a') return 'theorem';
  if (text === 'conditional' || text === 'conditionals' || text === 'conditioned') return 'conditional';
  return '';
}

function resolveProblemKind(inputKind, proofState) {
  const normalizedKind = normalizeProblemKind(inputKind);
  if (normalizedKind === 'conditional') return 'conditional';
  const normalizedState = normalizeProofState(proofState);
  if (normalizedState === 'YY') return 'theorem';
  if (normalizedState === 'NY') return 'problem';
  return normalizedKind || null;
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
  const proofCheck = result.proofCheck && isPlainObject(result.proofCheck) ? result.proofCheck : null;
  if (proofCheck && proofCheck.ok === true) return 'verified';
  if (result.verifyBeforeConvert === false) return 'skipped';
  return result.ok ? 'verified' : 'failed';
}

function isAllowedConditionalAxiom(language, statement, solveContext) {
  const selected = solveContext && Array.isArray(solveContext.selectedConditionals)
    ? solveContext.selectedConditionals
    : [];
  if (!selected.length) return false;
  const text = String(statement || '').trim();
  const allowedNames = new Set(selected.map((conditional, index) => {
    const key = String(
      conditional.conditionalProblemId
      || conditional.postedAt
      || conditional.conditionalTitle
      || index
    ).trim();
    return `provf_conditional_${key}`
      .replace(/[^A-Za-z0-9_']/g, '_')
      .replace(/^[^A-Za-z_]+/, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }));
  if (language === 'coq') {
    const match = text.match(/^Axiom\s+(provf_conditional_[A-Za-z0-9_']+)\s*:\s*provf_problem_target\s*\.\s*$/i);
    return Boolean(match && allowedNames.has(match[1]));
  }
  const match = text.match(/^axiom\s+(provf_conditional_[A-Za-z0-9_']+)\s*:\s*provf_problem_target\s*$/i);
  return Boolean(match && allowedNames.has(match[1]));
}

function collectUnsafeProofConstructs(language, code, solveContext = null) {
  const normalizedLanguage = normalizeLanguage(language);
  const source = normalizedLanguage === 'coq'
    ? stripCoqCommentsAndStrings(code)
    : stripLeanCommentsAndStrings(code);
  const unsafe = [];
  const add = (kind, match) => {
    const statement = String(match || '').trim();
    if (!statement) return;
    if (isAllowedConditionalAxiom(normalizedLanguage, statement, solveContext)) return;
    unsafe.push({
      kind,
      statement: statement.slice(0, 240)
    });
  };

  if (normalizedLanguage === 'coq') {
    const declarationRegex = /(?:^|[.\n])\s*((Axioms?|Parameters?|Variables?|Hypotheses?|Assumptions?|Context|Conjecture)\b[\s\S]*?\.(?=\s|$))/g;
    for (const match of source.matchAll(declarationRegex)) {
      add(match[2], match[1]);
    }
    const admittedRegex = /(?:^|[.;\n])\s*((Admitted|admit|Abort)\b[\s\S]*?\.(?=\s|$))/g;
    for (const match of source.matchAll(admittedRegex)) {
      add(match[2], match[1]);
    }
    return unsafe;
  }

  const leanRegex = /(?:^|[;\n])\s*((axioms?|constants?|opaque|unsafe|partial)\b[^\n;]*)/gi;
  for (const match of source.matchAll(leanRegex)) {
    add(match[2], match[1]);
  }
  const holeRegex = /\b(sorry|admit)\b/gi;
  for (const match of source.matchAll(holeRegex)) {
    add(match[1], match[0]);
  }
  return unsafe;
}

function collectDangerousExecutionConstructs(language, code) {
  const normalizedLanguage = normalizeLanguage(language);
  const source = normalizedLanguage === 'coq'
    ? stripCoqCommentsAndStrings(code)
    : stripLeanCommentsAndStrings(code);
  const dangerous = [];
  const add = (kind, match) => {
    dangerous.push({
      kind,
      statement: String(match || '').trim().slice(0, 240)
    });
  };

  if (normalizedLanguage === 'coq') {
    const coqDangerous = /(?:^|[.\n])\s*((Declare\s+ML\s+Module|Load|Cd|Add\s+(?:Rec\s+)?LoadPath|Redirect|Extraction|Separate\s+Extraction)\b[\s\S]*?\.(?=\s|$))/g;
    for (const match of source.matchAll(coqDangerous)) {
      add(match[2], match[1]);
    }
    return dangerous;
  }

  const leanDangerous = /(?:^|[;\n])\s*((#eval|run_cmd|elab|macro_rules|initialize|builtin_initialize|#compile|#exit|#print\s+prefix|\@\[extern[^\]]*\]|unsafe|partial)\b[^\n;]*)/gi;
  for (const match of source.matchAll(leanDangerous)) {
    add(match[2], match[1]);
  }
  return dangerous;
}

function requiresStrictAxiomPolicy(record) {
  if (!record || !isPlainObject(record)) return false;
  const meta = isPlainObject(record.request_meta) ? record.request_meta : {};
  const problemKind = normalizeProblemKind(meta.problemKind);
  return normalizeProofState(record.proof_state) === 'YY'
    || problemKind === 'theorem'
    || isPlainObject(meta.solutionOf);
}

function assertProblemSolveShape(record) {
  if (!record || !isPlainObject(record)) return;
  const meta = isPlainObject(record.request_meta) ? record.request_meta : {};
  const solveContext = isPlainObject(meta.solveContext) ? meta.solveContext : null;
  if (!solveContext || !solveContext.problemId || normalizeProofState(record.proof_state) !== 'YY') return;
  const source = String(record.source_code || '');
  const language = normalizeLanguage(record.language);
  const closesTarget = language === 'coq'
    ? /\b(?:Theorem|Lemma)\s+(?:provf_solution|provf_problem_solution)\s*:\s*provf_problem_target\s*\./i.test(stripCoqCommentsAndStrings(source))
    : /\btheorem\s+(?:provf_solution|provf_problem_solution)\s*:\s*provf_problem_target\s*:=/i.test(stripLeanCommentsAndStrings(source));
  if (!/\bprovf_problem_target\b/.test(source) || !closesTarget) {
    throw createRequestError(
      422,
      'Problem solutions must prove the generated provf_solution theorem for provf_problem_target.'
    );
  }
}

async function assertStoredProblemSolveBinding(client, record, identity) {
  const meta = isPlainObject(record && record.request_meta) ? record.request_meta : {};
  const solveContext = isPlainObject(meta.solveContext) ? meta.solveContext : null;
  const problemKind = normalizeProblemKind(meta.problemKind);
  const isBoundSubmission = normalizeProofState(record.proof_state) === 'YY' || problemKind === 'conditional';
  if (!solveContext || !solveContext.problemId || !isBoundSubmission) return;
  if (!identity || !identity.authenticated) throw createRequestError(401, 'Login is required to submit a problem solution.');
  const { data, error } = await client
    .from('problems')
    .select('id,language,proof_state,verification_status,normalized_format,normalized_term,adapter_meta,request_meta')
    .eq('id', solveContext.problemId)
    .maybeSingle();
  if (error) throw createRequestError(502, error.message || 'Failed to load the target problem.');
  if (!data || !data.id) throw createRequestError(404, 'The target problem was not found.');
  const binding = assertProblemProofBinding(data, record);
  const guardCode = buildCicBindingGuard(binding.language, record.source_code, binding.storedTerm);
  const guardCheck = await requestProofCheck({
    language: binding.language,
    code: guardCode,
    fileName: record.file_name || defaultFileName(binding.language)
  });
  if (!guardCheck || guardCheck.ok !== true) {
    throw createRequestError(
      422,
      'The submitted proof target is not definitionally equal to the trusted CIC problem target.',
      { guardCheck }
    );
  }
}

async function verifyProofServerSide(preliminaryRecord) {
  const record = preliminaryRecord && isPlainObject(preliminaryRecord) ? preliminaryRecord : {};
  const code = String(record.source_code || '');
  const language = normalizeLanguage(record.language);
  const dangerous = collectDangerousExecutionConstructs(language, code);
  if (dangerous.length > 0) {
    throw createRequestError(
      422,
      'Proof code contains server-side execution directives that are not allowed for verification.',
      { dangerous }
    );
  }
  const proofCheck = await requestProofCheck({
    language,
    code,
    fileName: record.file_name || defaultFileName(language)
  });

  if (!proofCheck || proofCheck.ok !== true) {
    throw createRequestError(422, 'Server proof check failed. The proof cannot be persisted as verified.', {
      proofCheck
    });
  }

  const meta = isPlainObject(record.request_meta) ? record.request_meta : {};
  const solveContext = isPlainObject(meta.solveContext) ? meta.solveContext : null;
  assertProblemSolveShape(record);
  const unsafe = collectUnsafeProofConstructs(language, code, solveContext);
  const auditTarget = findProofAuditTarget(language, code, solveContext);
  if (!auditTarget) {
    throw createRequestError(422, 'The proof declaration could not be selected for a kernel assumption audit.');
  }
  const audit = buildProofAssumptionAudit(language, code, auditTarget);
  const auditCheck = await requestProofCheck({
    language,
    code: audit.code,
    fileName: record.file_name || defaultFileName(language)
  });
  if (!auditCheck || auditCheck.ok !== true) {
    throw createRequestError(422, 'The proof assumption audit failed.', { auditCheck });
  }
  const assumptionAudit = parseProofAssumptions(
    language,
    `${auditCheck.stdout || ''}\n${auditCheck.stderr || ''}`,
    audit
  );
  if (!assumptionAudit.recognized) {
    throw createRequestError(422, 'The proof kernel did not return a recognizable assumption report.');
  }
  const allowedAssumptions = allowedConditionalAssumptionNames(solveContext);
  const unexpectedAssumptions = assumptionAudit.assumptions.filter((name) => !allowedAssumptions.has(name));
  if (requiresStrictAxiomPolicy(record) && unsafe.length > 0) {
    throw createRequestError(
      422,
      'YY theorem proofs cannot contain unapproved axioms, assumptions, admits, or unsafe declarations.',
      { unsafe }
    );
  }
  if (requiresStrictAxiomPolicy(record) && unexpectedAssumptions.length > 0) {
    throw createRequestError(
      422,
      'YY theorem proofs depend on kernel-reported axioms that are not registered Conditionals.',
      {
        assumptions: assumptionAudit.assumptions,
        unexpectedAssumptions
      }
    );
  }

  return {
    proofCheck: {
      ...proofCheck,
      serverVerified: true,
      serverVerifiedAt: new Date().toISOString()
    },
    sourcePolicy: {
      strict: requiresStrictAxiomPolicy(record),
      unsafe,
      assumptionAudit: {
        target: auditTarget,
        assumptions: assumptionAudit.assumptions,
        unexpectedAssumptions
      },
      allowedConditionalAxioms: solveContext && Array.isArray(solveContext.selectedConditionals)
        ? solveContext.selectedConditionals.length
        : 0
    }
  };
}

function mergeServerProofVerification(result, serverProof) {
  const source = result && isPlainObject(result) ? result : {};
  return {
    ...source,
    ok: Boolean(source.ok),
    verifyBeforeConvert: true,
    proofCheck: serverProof.proofCheck,
    serverProofPolicy: serverProof.sourcePolicy
  };
}

function extractLambda(result) {
  const conversion = result && isPlainObject(result.conversion) ? result.conversion : {};
  return conversion.lambda && isPlainObject(conversion.lambda) ? conversion.lambda : {};
}

function buildLegacyNormalizedTerm(lambda) {
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

function isCicFormat(value) {
  const format = String(value || '').trim().toLowerCase();
  return format === 'cic' || format === 'cic-v1';
}

function buildTrustedNormalization(lambda, completedFormat, options = {}) {
  if (!isCicFormat(completedFormat)) {
    return {
      normalizedTerm: buildLegacyNormalizedTerm(lambda),
      proofTerm: null,
      cicTarget: null
    };
  }

  const context = isPlainObject(lambda.context) ? lambda.context : null;
  const target = context && isPlainObject(context.type) ? context.type : null;
  if (!target) {
    throw createRequestError(
      422,
      'Trusted cic-v1 conversion did not return the theorem proposition in context.type.'
    );
  }
  if (options.requirePortable === true) {
    assertPortableCicTarget(target);
  }
  const targetHash = hashCicTarget(target);
  return {
    normalizedTerm: target,
    proofTerm: isPlainObject(lambda.term) ? lambda.term : null,
    cicTarget: {
      version: 1,
      source: 'server-recomputed-context.type',
      sha256: targetHash,
      format: 'cic-v1'
    }
  };
}

function normalizeSolveContext(value) {
  if (!isPlainObject(value)) return null;
  const normalizedTerm = isPlainObject(value.normalizedTerm)
    ? value.normalizedTerm
    : (typeof value.normalizedTerm === 'string' ? value.normalizedTerm : null);
  const selectedConditionals = Array.isArray(value.selectedConditionals)
    ? value.selectedConditionals.filter(isPlainObject)
    : [];
  return {
    version: Number(value.version) || 1,
    mode: String(value.mode || 'problem-solve').trim(),
    problemId: String(value.problemId || '').trim(),
    citationId: String(value.citationId || '').trim(),
    title: String(value.title || '').trim(),
    quote: String(value.quote || '').trim(),
    sourceCode: String(value.sourceCode || '').trim(),
    language: String(value.language || '').trim(),
    fileName: String(value.fileName || '').trim(),
    proofState: String(value.proofState || '').trim(),
    kind: String(value.kind || '').trim(),
    normalizedFormat: String(value.normalizedFormat || '').trim(),
    normalizedTerm,
    normalizedTermPreview: String(value.normalizedTermPreview || '').trim(),
    selectedConditionals,
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
    createdAt: String(value.createdAt || '').trim()
  };
}

function normalizeConditionalBounty(value) {
  if (!isPlainObject(value)) return null;
  const amountYen = Math.max(0, Math.round(Number(value.amountYen || value.amountTotal || 0) || 0));
  const amountVx = Math.max(0, Number(value.amountVx) || 0);
  if (!amountYen && !amountVx) return null;
  return {
    amountYen,
    amountVx,
    currency: String(value.currency || 'jpy').trim().toLowerCase(),
    status: String(value.status || '').trim(),
    paymentStatus: String(value.paymentStatus || value.payment_status || value.stripePaymentStatus || '').trim(),
    stripeSessionId: String(value.stripeSessionId || value.sessionId || '').trim(),
    stripePaymentIntentId: String(value.stripePaymentIntentId || value.paymentIntentId || '').trim(),
    serverVerified: value.serverVerified === true,
    verifiedAt: String(value.verifiedAt || '').trim(),
    split: isPlainObject(value.split) ? value.split : null,
    updatedAt: String(value.updatedAt || '').trim()
  };
}

function publicIdentity(identity) {
  if (!identity || !identity.authenticated) return null;
  return {
    accountProvider: String(identity.accountProvider || '').trim(),
    accountId: String(identity.accountId || '').trim(),
    accountIdHash: String(identity.accountIdHash || '').trim(),
    email: String(identity.email || '').trim(),
    name: String(identity.name || '').trim()
  };
}

function collectStripeSessionIds(meta) {
  const ids = new Set();
  const add = (value) => {
    const id = typeof value === 'string' ? value.trim() : '';
    if (id) ids.add(id);
  };
  if (!isPlainObject(meta)) return ids;
  if (isPlainObject(meta.bounty)) add(meta.bounty.stripeSessionId || meta.bounty.sessionId);
  if (isPlainObject(meta.originalBounty)) add(meta.originalBounty.stripeSessionId || meta.originalBounty.sessionId);
  if (isPlainObject(meta.conditionalBounty)) add(meta.conditionalBounty.stripeSessionId || meta.conditionalBounty.sessionId);
  if (isPlainObject(meta.conditionalOf) && isPlainObject(meta.conditionalOf.bounty)) {
    add(meta.conditionalOf.bounty.stripeSessionId || meta.conditionalOf.bounty.sessionId);
  }
  if (Array.isArray(meta.conditionals)) {
    for (const conditional of meta.conditionals) {
      if (isPlainObject(conditional) && isPlainObject(conditional.bounty)) {
        add(conditional.bounty.stripeSessionId || conditional.bounty.sessionId);
      }
    }
  }
  return ids;
}

async function reserveStripeSession(client, sessionId, currentJobId = '', purpose = 'problem_bounty') {
  const target = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!target) return;
  const { error } = await client.from('stripe_session_claims').insert({
    session_id: target,
    helper_job_id: currentJobId || null,
    problem_id: null,
    purpose
  });
  if (error) {
    if (error.code === '23505') throw createRequestError(409, 'This Stripe Checkout Session has already been used.');
    if (isMissingSupabaseRelationError(error, 'stripe_session_claims')) {
      throw createRequestError(503, 'Secure Stripe session claims are not ready. Apply the latest Supabase migration.');
    }
    throw createRequestError(502, error.message || 'Failed to reserve the Stripe Checkout Session.');
  }
}

async function reserveStripeSessions(client, sessions, currentJobId = '') {
  const reservedSessionIds = [];
  try {
    for (const session of sessions) {
      await reserveStripeSession(client, session.sessionId, currentJobId, session.purpose);
      reservedSessionIds.push(session.sessionId);
    }
  } catch (error) {
    if (reservedSessionIds.length) {
      await client
        .from('stripe_session_claims')
        .delete()
        .in('session_id', reservedSessionIds);
    }
    throw error;
  }
}

async function linkStripeSessions(client, sessions, problemId) {
  for (const session of sessions) {
    const { data, error } = await client
      .from('stripe_session_claims')
      .update({ problem_id: problemId })
      .eq('session_id', session.sessionId)
      .is('problem_id', null)
      .select('session_id')
      .maybeSingle();
    if (error || !data || data.session_id !== session.sessionId) {
      throw createRequestError(502, 'Failed to bind the Stripe Checkout Session to the saved proof.');
    }
  }
}

async function verifyPersistencePayments(input, preliminaryRecord, identity) {
  const meta = preliminaryRecord && isPlainObject(preliminaryRecord.request_meta)
    ? preliminaryRecord.request_meta
    : {};
  const verified = {};
  const proofState = normalizeProofState(preliminaryRecord && preliminaryRecord.proof_state);
  const problemKind = normalizeProblemKind(meta.problemKind);
  const requiresPayment = problemKind === 'problem' && proofState === 'NY';
  if (requiresPayment && (!identity || !identity.authenticated)) {
    throw createRequestError(401, 'Login is required for paid PROVF submissions.');
  }

  if (problemKind === 'problem' && proofState === 'NY') {
    verified.bounty = await verifyBountyCheckoutSession(input.bounty, { identity });
  }
  if (problemKind === 'conditional' && proofState === 'NY') {
    const solveContext = isPlainObject(meta.solveContext) ? meta.solveContext : null;
    const requestedFunding = normalizeConditionalFunding(input.conditionalBounty);
    if (requestedFunding && requestedFunding.stripeSessionId) {
      if (!identity || !identity.authenticated) {
        throw createRequestError(401, 'Login is required for a funded Conditional proof.');
      }
      if (!solveContext || !String(solveContext.problemId || '').trim()) {
        throw createRequestError(409, 'A funded Conditional proof must be bound to an unresolved problem.');
      }
      verified.conditionalBounty = await verifyConditionalCheckoutSession(input.conditionalBounty, {
        identity,
        problemId: String(solveContext.problemId).trim()
      });
    } else if (input.conditionalBounty !== null && input.conditionalBounty !== undefined) {
      throw createRequestError(409, 'Conditional funding is incomplete or invalid.');
    }
  }

  return verified;
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
        ? "Supabase REST cannot insert into public.problems yet. Run the latest supabase/proof_helper.sql in the connected project so service_role grants and PostgREST schema reload are applied."
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

export function buildProblemRecord(input, result, identity = null, verifiedPayments = {}) {
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
  const recomputedSourceSha256 = sha256(code);
  const conversionSourceSha256 = String(conversion.codeHash || '').trim().toLowerCase();
  if (conversionSourceSha256 && conversionSourceSha256 !== recomputedSourceSha256) {
    throw createRequestError(422, 'Trusted conversion source hash does not match the submitted proof code.');
  }
  const sourceSha256 = recomputedSourceSha256;
  const jobId = String(input.jobId || input.helperJobId || '').trim();
  const inputProblemKind = input.problemKind || input.postKind || input.searchKind || '';
  const solveContext = normalizeSolveContext(input.solveContext);
  let proofState = inferProofState(language, code, result);
  if (solveContext && solveContext.problemId) {
    proofState = 'YY';
  }
  const problemKind = resolveProblemKind(inputProblemKind, proofState);
  if (problemKind === 'conditional') {
    proofState = 'NY';
  }
  if (
    (problemKind === 'problem' || problemKind === 'conditional' || (solveContext && solveContext.problemId))
    && !isCicFormat(completedFormat)
  ) {
    throw createRequestError(
      422,
      'Problems, Conditionals, and problem solutions require a trusted cic-v1 conversion.'
    );
  }
  const trustedNormalization = buildTrustedNormalization(lambda, completedFormat, {
    requirePortable: problemKind === 'problem' && !(solveContext && solveContext.problemId)
  });
  const bounty = problemKind === 'problem' && proofState === 'NY'
    ? normalizeBounty(verifiedPayments.bounty || input.bounty)
    : null;
  const conditionalBounty = problemKind === 'conditional' && proofState === 'NY'
    ? normalizeConditionalFunding(verifiedPayments.conditionalBounty || input.conditionalBounty)
    : null;
  const createdByAccount = publicIdentity(identity);
  const titleAliases = Array.from(new Set([
    typeof input.title === 'string' ? input.title.trim() : '',
    solveContext && solveContext.title ? solveContext.title : ''
  ].filter(Boolean)));

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
        sourcePolicy: result.serverProofPolicy && isPlainObject(result.serverProofPolicy) ? result.serverProofPolicy : null,
        planning: Object.keys(planning).length ? planning : null,
        helperStorage: result.storage && isPlainObject(result.storage) ? result.storage : null
      },
      normalized_format: completedFormat,
      normalized_term: trustedNormalization.normalizedTerm,
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
        proofTerm: trustedNormalization.proofTerm,
        declarations: lambda.declarations || null,
        metadata: lambda.metadata || null,
        serverProofPolicy: result.serverProofPolicy && isPlainObject(result.serverProofPolicy)
          ? result.serverProofPolicy
          : null,
        rawText: typeof lambda.rawText === 'string' ? truncateOutput(lambda.rawText) : ''
      },
      helper_job_id: jobId || null,
      request_meta: {
        createdBy: 'vercel-proxy',
        createdByAccount,
        requestedAt: input.requestedAt || null,
        savedAt: new Date().toISOString(),
        sourceBytes: codeBytes,
        helperJobId: jobId || null,
        requestedFormat,
        completedFormat,
        cicTarget: trustedNormalization.cicTarget,
        problemKind,
        bounty,
        conditionalBounty,
        solveContext,
        titleAliases,
        conditionalOf: solveContext && solveContext.problemId && problemKind === 'conditional'
          ? {
              problemId: solveContext.problemId,
              problemTitle: solveContext.title || '',
              requestedAt: input.requestedAt || null,
              payment: { required: false }
            }
          : null,
        solutionOf: solveContext && solveContext.problemId && proofState === 'YY'
          ? {
              problemId: solveContext.problemId,
              problemTitle: solveContext.title || '',
              requestedAt: input.requestedAt || null
            }
          : null
      }
    },
    jobId
  };
}

export async function persistHelperProblem(body, req = null) {
  const input = parseBody(body);
  const { client, error } = getSupabaseAdmin();

  if (!client) {
    throw createRequestError(503, error || 'Supabase is not configured on this server.');
  }

  const claimedJobId = String(input.jobId || input.helperJobId || '').trim();
  if (claimedJobId && !verifyJobCapability(claimedJobId, readJobCapability(req, input))) {
    throw createRequestError(403, 'Helper job persistence is not authorized.');
  }

  const identity = req ? await getIvucxIdentity(req, client) : null;
  const result = await requestProofConversion({
    language: input.language,
    code: input.code,
    fileName: input.fileName,
    format: input.format || input.completedFormat || input.requestedFormat || 'cic-v1'
  });
  if (!result || !isPlainObject(result) || result.ok !== true) {
    throw createRequestError(
      422,
      'The server could not reproduce a trusted proof conversion.',
      { stage: result && result.stage ? result.stage : null }
    );
  }
  const preliminary = buildProblemRecord(input, result, identity);
  const jobId = preliminary.jobId;

  if (jobId) {
    const existing = await client
      .from('problems')
      .select('id,source_sha256,request_meta')
      .eq('helper_job_id', jobId)
      .maybeSingle();

    if (!existing.error && existing.data && existing.data.id) {
      const existingMeta = isPlainObject(existing.data.request_meta) ? existing.data.request_meta : {};
      const existingCreator = isPlainObject(existingMeta.createdByAccount) ? existingMeta.createdByAccount : null;
      if (existingCreator && !identityOwnsProblem(identity, existingMeta)) {
        throw createRequestError(403, 'This saved proof belongs to another account.');
      }
      return {
        persisted: true,
        duplicate: true,
        problemId: existing.data.id,
        attachmentToken: issueProblemCapability(existing.data.id, 'attachments'),
        record: preliminary.record
      };
    }

    if (existing.error && isMissingSupabaseRelationError(existing.error, 'problems')) {
      throw createSupabaseInsertError(existing.error);
    }
  }

  await assertStoredProblemSolveBinding(client, preliminary.record, identity);
  const serverProof = await verifyProofServerSide(preliminary.record);
  const verifiedResult = mergeServerProofVerification(result, serverProof);
  const verifiedPayments = await verifyPersistencePayments(input, preliminary.record, identity);
  const { record } = buildProblemRecord(input, verifiedResult, identity, verifiedPayments);
  const problemId = randomUUID();
  record.id = problemId;
  const sessionsToReserve = [
    verifiedPayments.bounty && verifiedPayments.bounty.stripeSessionId
      ? { sessionId: verifiedPayments.bounty.stripeSessionId, purpose: 'problem_bounty' }
      : null,
    verifiedPayments.conditionalBounty && verifiedPayments.conditionalBounty.stripeSessionId
      ? { sessionId: verifiedPayments.conditionalBounty.stripeSessionId, purpose: 'conditional_bounty' }
      : null
  ].filter(Boolean);
  await reserveStripeSessions(client, sessionsToReserve, jobId);

  const { data, error: insertError } = await client
    .from('problems')
    .insert(record)
    .select('id')
    .single();

  if (insertError) {
    if (sessionsToReserve.length) {
      await client.from('stripe_session_claims').delete().in(
        'session_id',
        sessionsToReserve.map((session) => session.sessionId)
      );
    }
    throw createSupabaseInsertError(insertError);
  }
  try {
    await linkStripeSessions(client, sessionsToReserve, problemId);
  } catch (linkError) {
    await client.from('problems').delete().eq('id', problemId);
    await client.from('stripe_session_claims').delete().in(
      'session_id',
      sessionsToReserve.map((session) => session.sessionId)
    );
    throw linkError;
  }

  return {
    persisted: true,
    duplicate: false,
    problemId: data && data.id ? data.id : null,
    attachmentToken: issueProblemCapability(data && data.id ? data.id : problemId, 'attachments'),
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

async function checkProblemColumnCache(client) {
  const query = await client
    .from('problems')
    .select(PROBLEM_REQUIRED_COLUMNS.join(','), { count: 'exact', head: true });

  if (query.error) {
    return {
      ok: false,
      error: query.error.message || 'Problem column cache check failed.',
      code: query.error.code || null
    };
  }

  return {
    ok: true,
    error: null,
    code: null
  };
}

export async function checkProblemPersistenceStatus() {
  const { client, error } = getSupabaseAdmin();
  const status = {
    configured: Boolean(client),
    error: client ? null : (error || 'Supabase is not configured on this server.'),
    supabase: getSupabaseAdminDiagnostics(),
    tables: {
      problems: null,
      helper_jobs: null,
      helper_conversion_plans: null
    },
    schemaCache: {
      problemColumns: null
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

  const [
    problemsTable,
    helperJobsTable,
    conversionPlansTable,
    problemColumns
  ] = await Promise.all([
    checkSupabaseTable(client, 'problems'),
    checkSupabaseTable(client, 'helper_jobs'),
    checkSupabaseTable(client, 'helper_conversion_plans'),
    checkProblemColumnCache(client)
  ]);
  status.tables.problems = problemsTable;
  status.tables.helper_jobs = helperJobsTable;
  status.tables.helper_conversion_plans = conversionPlansTable;
  status.schemaCache.problemColumns = problemColumns;

  if (!status.tables.problems.exists) {
    status.cic.error = status.tables.problems.error || 'public.problems is missing.';
    return status;
  }

  const [saved, requested, fallback] = await Promise.all([
    client
      .from('problems')
      .select('id', { count: 'exact', head: true })
      .eq('normalized_format', 'cic-v1'),
    client
      .from('problems')
      .select('id', { count: 'exact', head: true })
      .eq('request_meta->>requestedFormat', 'cic-v1'),
    client
      .from('problems')
      .select('id', { count: 'exact', head: true })
      .eq('request_meta->>requestedFormat', 'cic-v1')
      .neq('normalized_format', 'cic-v1')
  ]);

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
    assertProofRequestAllowed(req, '/api/helper/persist', {
      body: req && req.body ? req.body : {}
    });
    await assertDistributedRateLimit(req, { route: 'problem-persist', limit: 10, windowSeconds: 60 });
    const saved = await persistHelperProblem(req && req.body ? req.body : {}, req);
    const originalResult = req && req.body && isPlainObject(req.body.result) ? req.body.result : {};
    const result = {
      ...originalResult,
      problemId: saved.problemId,
      storage: {
        ...(originalResult.storage && isPlainObject(originalResult.storage) ? originalResult.storage : {}),
        persisted: true,
        source: 'vercel-proxy',
        duplicate: saved.duplicate,
        problemId: saved.problemId,
        attachmentToken: saved.attachmentToken || ''
      }
    };

    res.status(200).json({
      ok: true,
      success: true,
      problemId: saved.problemId,
      attachmentToken: saved.attachmentToken || '',
      duplicate: saved.duplicate,
      storage: result.storage,
      result
    });
  } catch (error) {
    if (error.retryAfter) {
      res.setHeader('Retry-After', String(error.retryAfter));
    }
    const originalResult = req && req.body && isPlainObject(req.body.result) ? req.body.result : {};
    const statusCode = error && error.statusCode ? error.statusCode : 500;
    const message = process.env.NODE_ENV === 'production' && statusCode >= 500
      ? 'Problem persistence is temporarily unavailable.'
      : (error && error.message ? error.message : String(error));

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
        details: process.env.NODE_ENV === 'production'
          ? undefined
          : (error && error.details ? error.details : null),
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
      details: process.env.NODE_ENV === 'production'
        ? undefined
        : (error && error.details ? error.details : null)
    });
  }
}
