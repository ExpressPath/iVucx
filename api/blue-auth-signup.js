import { getSupabaseAdmin } from '../lib/supabase-admin.js';
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

  const { error: insertError } = await supabase.from('blue_accounts').insert({
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
    const missingTable = insertError.code === '42P01';
    const isDuplicate =
      insertError.code === '23505' ||
      String(insertError.message || '').toLowerCase().includes('duplicate');
    res.status(isDuplicate ? 409 : 500).json({
      error: missingTable
        ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
        : isDuplicate
        ? 'Account ID already exists. Generate again.'
        : 'Could not create account',
      detail: insertError.message || null
    });
    return;
  }

  const sessionToken = issueSessionToken();
  const tokenHash = hashSessionToken(sessionToken);
  const expiresAt = secondsFromNowIso(SESSION_MAX_AGE_SECONDS);

  const { error: sessionError } = await supabase.from('blue_sessions').insert({
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
  res.status(201).json({
    loggedIn: true,
    accountId: normalizedAccount.display,
    recoveryPassword: normalizedRecovery.display,
    rewards: []
  });
}
