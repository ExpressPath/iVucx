import { createHmac } from 'crypto';
import { secureStringEqual } from './secure-compare.js';

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function capabilitySecret() {
  return safeString(
    process.env.PROBLEM_CAPABILITY_SECRET
    || process.env.EMAIL_VERIFICATION_SECRET
    || process.env.GOOGLE_IDENTITY_COOKIE_SECRET
    || process.env.IVUCX_LEDGER_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function capabilityDigest(problemId, purpose) {
  const secret = capabilitySecret();
  if (!secret) {
    const error = new Error('Problem capability signing secret is missing.');
    error.statusCode = 503;
    throw error;
  }
  return createHmac('sha256', secret)
    .update(`provf:${safeString(purpose)}:${safeString(problemId)}`)
    .digest('base64url');
}

export function issueProblemCapability(problemId, purpose = 'attachments') {
  if (!safeString(problemId)) return '';
  return capabilityDigest(problemId, purpose);
}

export function verifyProblemCapability(problemId, token, purpose = 'attachments') {
  return secureStringEqual(safeString(token), capabilityDigest(problemId, purpose));
}

function identityHashes(identity) {
  const hashes = new Set();
  const add = (candidate) => {
    const hash = safeString(candidate && candidate.accountIdHash);
    if (hash) hashes.add(hash);
  };
  add(identity);
  for (const alias of Array.isArray(identity && identity.accountAliases) ? identity.accountAliases : []) add(alias);
  return hashes;
}

export function identityOwnsProblem(identity, problemMeta) {
  if (!identity || !identity.authenticated || !problemMeta || typeof problemMeta !== 'object') return false;
  const creator = problemMeta.createdByAccount && typeof problemMeta.createdByAccount === 'object'
    ? problemMeta.createdByAccount
    : null;
  if (!creator) return false;
  const creatorHash = safeString(creator.accountIdHash);
  if (creatorHash && identityHashes(identity).has(creatorHash)) return true;

  const creatorEmail = safeString(creator.email).toLowerCase();
  const identityEmail = safeString(identity.email).toLowerCase();
  return Boolean(creatorEmail && identityEmail && creatorEmail === identityEmail);
}
