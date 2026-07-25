import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { assertDistributedRateLimit } from '../lib/distributed-rate-limit.js';
import { getPublicErrorMessage } from '../lib/http-error.js';
import {
  SESSION_MAX_AGE_SECONDS,
  buildSessionCookie,
  generateAccountId,
  generateRecoveryPassword,
  hashRecoverySecret,
  hashSessionToken,
  issueSessionToken,
  normalizeAccountId,
  normalizeRecoveryPassword,
  secondsFromNowIso
} from '../lib/blue-auth.js';

function readBody(req) {
  if (!req || typeof req !== 'object') return {};
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch (err) {
      return {};
    }
  }
  if (typeof req.body === 'object') return req.body;
  return {};
}

function isMissingColumnError(error) {
  return error && error.code === '42703';
}

function isMissingTableError(error) {
  return error && error.code === '42P01';
}

async function insertBlueAccount(supabase, account) {
  const preferred = await supabase.from('blue_accounts').insert(account);
  if (!isMissingColumnError(preferred.error)) {
    return preferred;
  }

  return supabase.from('blue_accounts').insert({
    account_id: account.account_id,
    account_id_normalized: account.account_id_normalized,
    recovery_hash: account.recovery_hash,
    rewards: account.rewards
  });
}

async function insertBlueSession(supabase, session) {
  const preferred = await supabase.from('blue_sessions').insert(session);
  if (!isMissingColumnError(preferred.error)) {
    return preferred;
  }

  return supabase.from('blue_sessions').insert({
    session_token_hash: session.session_token_hash,
    account_id: session.account_id,
    expires_at: session.expires_at,
    revoked_at: session.revoked_at
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { client: supabase, error: envError } = getSupabaseAdmin();
  if (!supabase) {
    res.status(503).json({
      error: getPublicErrorMessage({ message: envError }, 'Account creation is temporarily unavailable.', 503)
    });
    return;
  }

  try {
    await assertDistributedRateLimit(req, {
      route: 'blue-auth-signup',
      limit: 5,
      windowSeconds: 60 * 60
    });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    res.status(error.statusCode || 429).json({ error: error.message || 'Too many signup attempts.' });
    return;
  }

  const body = readBody(req);
  const requestedAccountId =
    typeof body.accountId === 'string' && body.accountId.trim()
      ? body.accountId.trim()
      : generateAccountId();
  const requestedRecovery =
    typeof body.recoveryPassword === 'string' && body.recoveryPassword.trim()
      ? body.recoveryPassword.trim()
      : generateRecoveryPassword();

  const normalizedAccount = normalizeAccountId(requestedAccountId);
  const normalizedRecovery = normalizeRecoveryPassword(requestedRecovery);

  if (normalizedAccount.canonical.length < 20) {
    res.status(400).json({ error: 'Account ID is too short' });
    return;
  }

  if (normalizedRecovery.canonical.length < 20) {
    res.status(400).json({ error: 'Recovery Password is too short' });
    return;
  }

  const recoveryHash = hashRecoverySecret(normalizedRecovery.canonical);
  const now = new Date().toISOString();

  const { error: insertError } = await insertBlueAccount(supabase, {
    account_id: normalizedAccount.display,
    account_id_normalized: normalizedAccount.canonical,
    recovery_hash: recoveryHash,
    rewards: [],
    failed_attempts: 0,
    locked_until: null,
    status: 'active',
    created_at: now,
    updated_at: now
  });

  if (insertError) {
    const missingTable = isMissingTableError(insertError);
    const isDuplicate =
      insertError.code === '23505' ||
      String(insertError.message || '').toLowerCase().includes('duplicate');
    const status = isDuplicate ? 409 : 500;
    const internalMessage = missingTable
        ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
        : isDuplicate
        ? 'Account ID already exists. Generate again.'
        : isMissingColumnError(insertError)
        ? 'BlueMode auth schema is incomplete. Run supabase/blue_mode_auth.sql again.'
        : 'Could not create account';
    res.status(status).json({
      error: getPublicErrorMessage(insertError && !isDuplicate ? insertError : { message: internalMessage }, 'Account creation is temporarily unavailable.', status)
    });
    return;
  }

  const sessionToken = issueSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = secondsFromNowIso(SESSION_MAX_AGE_SECONDS);

  const { error: sessionError } = await insertBlueSession(supabase, {
    session_token_hash: tokenHash,
    account_id: normalizedAccount.display,
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    last_seen_at: now
  });

  if (sessionError) {
    await supabase
      .from('blue_accounts')
      .delete()
      .eq('account_id_normalized', normalizedAccount.canonical);

    const internalMessage =
        isMissingTableError(sessionError)
          ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
          : isMissingColumnError(sessionError)
          ? 'BlueMode session schema is incomplete. Run supabase/blue_mode_auth.sql again.'
          : 'Could not create login session';
    res.status(500).json({
      error: getPublicErrorMessage({ message: internalMessage }, 'Account creation is temporarily unavailable.', 500)
    });
    return;
  }

  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.status(201).json({
    loggedIn: true,
    accountId: normalizedAccount.display,
    recoveryPassword: normalizedRecovery.display,
    rewards: []
  });
}
