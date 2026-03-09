import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  LOCKOUT_MINUTES,
  MAX_LOGIN_FAILURES,
  SESSION_MAX_AGE_SECONDS,
  buildSessionCookie,
  hashSessionToken,
  issueSessionToken,
  minutesFromNowIso,
  normalizeAccountId,
  normalizeRecoveryPassword,
  normalizeRewards,
  secondsFromNowIso,
  verifyRecoverySecret
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { client: supabase, error: envError } = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).json({ error: envError || 'Supabase is not configured' });
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

  const { data: account, error: accountError } = await supabase
    .from('blue_accounts')
    .select(
      'account_id, account_id_normalized, recovery_hash, rewards, status, failed_attempts, locked_until'
    )
    .eq('account_id_normalized', normalizedAccount.canonical)
    .maybeSingle();

  if (accountError) {
    res.status(500).json({
      error:
        accountError.code === '42P01'
          ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
          : 'Could not read account',
      detail: accountError.message || null
    });
    return;
  }

  if (!account || account.status !== 'active') {
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
    const failures = Number(account.failed_attempts || 0) + 1;
    const shouldLock = failures >= MAX_LOGIN_FAILURES;
    const lockUntil = shouldLock ? minutesFromNowIso(LOCKOUT_MINUTES) : null;

    await supabase
      .from('blue_accounts')
      .update({
        failed_attempts: shouldLock ? 0 : failures,
        locked_until: lockUntil,
        updated_at: now.toISOString()
      })
      .eq('account_id_normalized', normalizedAccount.canonical);

    res.status(401).json({
      error: 'Account ID or Recovery Password is not correct',
      reason: 'invalid_credentials'
    });
    return;
  }

  const nowIso = now.toISOString();

  await supabase
    .from('blue_accounts')
    .update({
      failed_attempts: 0,
      locked_until: null,
      last_login_at: nowIso,
      updated_at: nowIso
    })
    .eq('account_id_normalized', normalizedAccount.canonical);

  await supabase
    .from('blue_sessions')
    .update({ revoked_at: nowIso })
    .eq('account_id', account.account_id)
    .is('revoked_at', null);

  const sessionToken = issueSessionToken();
  const sessionHash = hashSessionToken(sessionToken);
  const expiresAt = secondsFromNowIso(SESSION_MAX_AGE_SECONDS);

  const { error: sessionError } = await supabase.from('blue_sessions').insert({
    session_token_hash: sessionHash,
    account_id: account.account_id,
    created_at: nowIso,
    expires_at: expiresAt,
    revoked_at: null,
    last_seen_at: nowIso
  });

  if (sessionError) {
    res.status(500).json({
      error:
        sessionError.code === '42P01'
          ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
          : 'Could not create login session',
      detail: sessionError.message || null
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
