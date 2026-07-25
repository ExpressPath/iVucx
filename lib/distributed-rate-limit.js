import { createHash, createHmac } from 'crypto';

import { getSupabaseAdmin } from './supabase-admin.js';

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function headerValue(value, takeLast = false) {
  const values = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean);
  return takeLast ? values[values.length - 1] || '' : values[0] || '';
}

export function getTrustedClientAddress(req) {
  const headers = req && req.headers ? req.headers : {};
  const direct = safeString(req && req.ip)
    || safeString(req && req.socket && req.socket.remoteAddress);
  if (safeString(process.env.VERCEL)) {
    return headerValue(headers['x-vercel-forwarded-for'], true) || direct || 'unknown';
  }
  if (safeString(process.env.CF_PAGES) || safeString(process.env.CLOUDFLARE_WORKER)) {
    return headerValue(headers['cf-connecting-ip']) || direct || 'unknown';
  }
  if (String(process.env.TRUST_PROXY_HEADERS || '').trim().toLowerCase() === 'true') {
    return headerValue(headers['x-real-ip'])
      || headerValue(headers['x-forwarded-for'], true)
      || direct
      || 'unknown';
  }
  return direct || 'unknown';
}

function bucketDigest(value) {
  const secret = safeString(
    process.env.RATE_LIMIT_HASH_SECRET
    || process.env.EMAIL_VERIFICATION_SECRET
    || process.env.GOOGLE_IDENTITY_COOKIE_SECRET
    || process.env.IVUCX_LEDGER_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  return secret
    ? createHmac('sha256', secret).update(String(value || '')).digest('hex')
    : createHash('sha256').update(String(value || '')).digest('hex');
}

function createUnavailableError(error) {
  const detail = safeString(error && (error.message || error.details || error.hint));
  const unavailable = new Error(
    detail && /api_rate_limit|consume_api_rate_limit/i.test(detail)
      ? 'Distributed request protection is not ready. Apply the latest Supabase migration.'
      : (detail || 'Distributed request protection is unavailable.')
  );
  unavailable.statusCode = 503;
  return unavailable;
}

export async function consumeDistributedRateLimit(req, options = {}) {
  const route = safeString(options.route, 'api');
  const limit = Math.max(1, Math.floor(Number(options.limit) || 60));
  const windowSeconds = Math.max(1, Math.floor(Number(options.windowSeconds) || 60));
  const discriminator = safeString(options.discriminator);
  const address = options.includeClientAddress === false ? '' : getTrustedClientAddress(req);
  const rawKey = `${address}:${discriminator || 'shared'}`;
  const { client, error: configurationError } = getSupabaseAdmin();
  if (!client) throw createUnavailableError(configurationError);

  const { data, error } = await client.rpc('consume_api_rate_limit', {
    p_bucket_key: bucketDigest(rawKey),
    p_route: route,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });
  if (error) throw createUnavailableError(error);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row && row.allowed),
    remaining: Math.max(0, Number(row && row.remaining) || 0),
    retryAfter: Math.max(1, Number(row && row.retry_after_seconds) || windowSeconds)
  };
}

export async function assertDistributedRateLimit(req, options = {}) {
  const state = await consumeDistributedRateLimit(req, options);
  if (state.allowed) return state;
  const error = new Error('Too many requests. Please retry shortly.');
  error.statusCode = 429;
  error.retryAfter = state.retryAfter;
  throw error;
}
