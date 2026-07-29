import { createHmac } from 'node:crypto';
import { secureStringEqual } from './secure-compare.js';

const DEFAULT_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function jobSecret() {
  return safeString(
    process.env.JOB_CAPABILITY_SECRET
    || process.env.PROBLEM_CAPABILITY_SECRET
    || process.env.GOOGLE_IDENTITY_COOKIE_SECRET
    || process.env.IVUCX_LEDGER_SECRET
  );
}

function signature(jobId, expiresAt, secret) {
  return createHmac('sha256', secret)
    .update(`provf:helper-job:${safeString(jobId)}:${expiresAt}`)
    .digest('base64url');
}

export function issueJobCapability(jobId, options = {}) {
  const id = safeString(jobId);
  const secret = jobSecret();
  if (!id || !secret) {
    const error = new Error('Helper job capability signing is not configured.');
    error.statusCode = 503;
    throw error;
  }
  const nowMs = Number(options.nowMs) || Date.now();
  const maxAgeSeconds = Math.max(60, Number(options.maxAgeSeconds) || DEFAULT_MAX_AGE_SECONDS);
  const expiresAt = Math.floor(nowMs / 1000) + Math.floor(maxAgeSeconds);
  return `${expiresAt}.${signature(id, expiresAt, secret)}`;
}

export function verifyJobCapability(jobId, token, options = {}) {
  const id = safeString(jobId);
  const raw = safeString(token);
  const secret = jobSecret();
  if (!id || !raw || !secret) return false;
  const [rawExpiry, provided, extra] = raw.split('.');
  const expiresAt = Number(rawExpiry);
  const nowSeconds = Math.floor((Number(options.nowMs) || Date.now()) / 1000);
  if (extra !== undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= nowSeconds) return false;
  return secureStringEqual(provided || '', signature(id, expiresAt, secret));
}
