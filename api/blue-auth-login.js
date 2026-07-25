import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { assertDistributedRateLimit } from '../lib/distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from '../lib/http-error.js';
import {
  LOCKOUT_MINUTES,
  MAX_LOGIN_FAILURES,
  SESSION_MAX_AGE_SECONDS,
  buildSessionCookie,
  hashSessionToken,
  hashRecoverySecret,
  issueSessionToken,
  normalizeAccountId,
  normalizeRecoveryPassword,
  normalizeRewards,
  secondsFromNowIso,
  verifyRecoverySecret
} from '../lib/blue-auth.js';

const DUMMY_RECOVERY_HASH = hashRecoverySecret(`RCV${'A'.repeat(48)}`);

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

async function readBlueAccountForLogin(supabase, normalizedAccountId) {
  const preferred = await supabase
    .from('blue_accounts')
    .select(
      'account_id, account_id_normalized, recovery_hash, rewards, status, failed_attempts, locked_until'
    )
    .eq('account_id_normalized', normalizedAccountId)
    .maybeSingle();

  if (!isMissingColumnError(preferred.error)) {
    return preferred;
  }

  const fallback = await supabase
    .from('blue_accounts')
    .select('account_id, account_id_normalized, recovery_hash, rewards')
    .eq('account_id_normalized', normalizedAccountId)
    .maybeSingle();

  return {
    data: fallback.data
      ? {
          ...fallback.data,
          status: 'active',
          failed_attempts: 0,
          locked_until: null
        }
      : null,
    error: fallback.error
  };
}

async function bestEffortUpdateAccount(supabase, normalizedAccountId, preferredUpdate, fallbackUpdate = null) {
  const preferred = await supabase
    .from('blue_accounts')
    .update(preferredUpdate)
    .eq('account_id_normalized', normalizedAccountId);

  if (!isMissingColumnError(preferred.error) || !fallbackUpdate) {
    return preferred;
  }

  return supabase
    .from('blue_accounts')
    .update(fallbackUpdate)
    .eq('account_id_normalized', normalizedAccountId);
}

async function bestEffortRevokeSessions(supabase, accountId, revokedAt) {
  return supabase
    .from('blue_sessions')
    .update({ revoked_at: revokedAt })
    .eq('account_id', accountId)
    .is('revoked_at', null);
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

async function recordLoginFailure(supabase, normalizedAccountId) {
  const { data, error } = await supabase.rpc('record_blue_login_failure', {
    p_account_id_normalized: normalizedAccountId,
    p_max_failures: MAX_LOGIN_FAILURES,
    p_lock_minutes: LOCKOUT_MINUTES
  });
  if (error) {
    const unavailable = new Error(
      /record_blue_login_failure|schema cache|function/i.test(String(error.message || error.details || ''))
        ? 'Secure login attempt tracking is not ready. Apply the latest Supabase migration.'
        : (error.message || 'Could not record the login attempt.')
    );
    unavailable.statusCode = /record_blue_login_failure|schema cache|function/i.test(String(error.message || error.details || '')) ? 503 : 502;
    throw unavailable;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? row : {};
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
      error: getPublicErrorMessage({ message: envError }, 'Login is temporarily unavailable.', 503)
    });
    return;
  }

  const body = readBody(req);
  const accountInput = typeof body.accountId === 'string' ? body.accountId : '';
  const recoveryInput =
    typeof body.recoveryPassword === 'string' ? body.recoveryPassword : '';

  const normalizedAccount = normalizeAccountId(accountInput);
  const normalizedRecovery = normalizeRecoveryPassword(recoveryInput);

  if (
    !normalizedAccount.canonical ||
    !normalizedRecovery.canonical ||
    normalizedAccount.canonical.length < 20 ||
    normalizedRecovery.canonical.length < 20
  ) {
    res.status(400).json({
      error: 'Account ID and Recovery Password are required'
    });
    return;
  }

  try {
    await assertDistributedRateLimit(req, {
      route: 'blue-auth-login-ip',
      limit: 30,
      windowSeconds: LOCKOUT_MINUTES * 60
    });
    await assertDistributedRateLimit(req, {
      route: 'blue-auth-login-account',
      discriminator: normalizedAccount.canonical,
      includeClientAddress: false,
      limit: MAX_LOGIN_FAILURES * 2,
      windowSeconds: LOCKOUT_MINUTES * 60
    });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    res.status(error.statusCode || 429).json({
      error: error.message || 'Too many login attempts. Please retry later.',
      reason: 'rate_limited'
    });
    return;
  }

  const { data: account, error: accountError } = await readBlueAccountForLogin(
    supabase,
    normalizedAccount.canonical
  );

  if (accountError) {
    const internalMessage =
        isMissingTableError(accountError)
          ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
          : isMissingColumnError(accountError)
          ? 'BlueMode auth schema is incomplete. Run supabase/blue_mode_auth.sql again.'
          : 'Could not read account';
    res.status(500).json({
      error: getPublicErrorMessage({ message: internalMessage }, 'Login is temporarily unavailable.', 500)
    });
    return;
  }

  if (!account || account.status !== 'active') {
    verifyRecoverySecret(normalizedRecovery.canonical, DUMMY_RECOVERY_HASH);
    res.status(401).json({
      error: 'Account ID or Recovery Password is not correct'
    });
    return;
  }

  const now = new Date();
  if (account.locked_until && new Date(account.locked_until).getTime() > now.getTime()) {
    res.status(423).json({
      error: 'Too many failed attempts. Please retry later.',
      reason: 'locked'
    });
    return;
  }

  const valid = verifyRecoverySecret(
    normalizedRecovery.canonical,
    account.recovery_hash
  );

  if (!valid) {
    try {
      await recordLoginFailure(supabase, normalizedAccount.canonical);
    } catch (error) {
      const status = getHttpErrorStatus(error, 502);
      res.status(status).json({
        error: getPublicErrorMessage(error, 'Login is temporarily unavailable.', status)
      });
      return;
    }

    res.status(401).json({
      error: 'Account ID or Recovery Password is not correct',
      reason: 'invalid_credentials'
    });
    return;
  }

  const nowIso = now.toISOString();

  await bestEffortUpdateAccount(
    supabase,
    normalizedAccount.canonical,
    {
      failed_attempts: 0,
      locked_until: null,
      last_login_at: nowIso,
      updated_at: nowIso
    },
    {
      rewards: Array.isArray(account.rewards) ? account.rewards : []
    }
  );

  const revoked = await bestEffortRevokeSessions(supabase, account.account_id, nowIso);
  if (revoked.error) {
    res.status(503).json({ error: 'Login is temporarily unavailable.' });
    return;
  }

  const sessionToken = issueSessionToken();
  const sessionHash = hashSessionToken(sessionToken);
  const expiresAt = secondsFromNowIso(SESSION_MAX_AGE_SECONDS);

  const { error: sessionError } = await insertBlueSession(supabase, {
    session_token_hash: sessionHash,
    account_id: account.account_id,
    created_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    last_seen_at: nowIso
  });

  if (sessionError) {
    const internalMessage =
      isMissingTableError(sessionError)
        ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
        : isMissingColumnError(sessionError)
        ? 'BlueMode session schema is incomplete. Run supabase/blue_mode_auth.sql again.'
        : 'Could not create login session';
    res.status(500).json({
      error: getPublicErrorMessage({ message: internalMessage }, 'Login is temporarily unavailable.', 500)
    });
    return;
  }

  res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
  res.status(200).json({
    loggedIn: true,
    accountId: account.account_id,
    rewards: normalizeRewards(account.rewards)
  });
}
