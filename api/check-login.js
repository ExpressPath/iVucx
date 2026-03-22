import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  buildClearSessionCookie,
  hashSessionToken,
  normalizeRewards,
  readSessionFromRequest
} from '../lib/blue-auth.js';

async function readAccountWithConsentFallback(supabase, accountId) {
  const preferred = await supabase
    .from('blue_accounts')
    .select('account_id, rewards, status, cookie_history_consent, cookie_history_consent_updated_at')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!preferred.error || preferred.error.code !== '42703') {
    return {
      data: preferred.data,
      error: preferred.error,
      schemaMissing: false
    };
  }

  const fallback = await supabase
    .from('blue_accounts')
    .select('account_id, rewards, status')
    .eq('account_id', accountId)
    .maybeSingle();

  return {
    data: fallback.data
      ? {
          ...fallback.data,
          cookie_history_consent: 'unknown',
          cookie_history_consent_updated_at: null
        }
      : null,
    error: fallback.error,
    schemaMissing: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const rawSession = readSessionFromRequest(req);
  if (!rawSession) {
    res.status(200).json({
      loggedIn: false,
      rewards: [],
      reason: 'no_session'
    });
    return;
  }

  const { client: supabase, error: envError } = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).json({
      error: envError || 'Supabase is not configured',
      loggedIn: false,
      rewards: []
    });
    return;
  }

  const tokenHash = hashSessionToken(rawSession);
  const nowIso = new Date().toISOString();

  const { data: sessionRow, error: sessionError } = await supabase
    .from('blue_sessions')
    .select('session_token_hash, account_id, expires_at, revoked_at')
    .eq('session_token_hash', tokenHash)
    .maybeSingle();

  if (sessionError) {
    res.status(500).json({
      loggedIn: false,
      rewards: [],
      error:
        sessionError.code === '42P01'
          ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
          : 'Could not read session',
      detail: sessionError.message || null
    });
    return;
  }

  const invalidSession =
    !sessionRow ||
    !!sessionRow.revoked_at ||
    !sessionRow.expires_at ||
    new Date(sessionRow.expires_at).getTime() <= Date.now();

  if (invalidSession) {
    res.setHeader('Set-Cookie', buildClearSessionCookie());
    res.status(200).json({
      loggedIn: false,
      rewards: [],
      reason: 'invalid_session'
    });
    return;
  }

  const {
    data: account,
    error: accountError,
    schemaMissing: cookieConsentSchemaMissing
  } = await readAccountWithConsentFallback(supabase, sessionRow.account_id);

  if (accountError) {
    res.status(500).json({
      loggedIn: false,
      rewards: [],
      error:
        accountError.code === '42P01'
          ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
          : 'Could not read account',
      detail: accountError.message || null
    });
    return;
  }

  if (!account || account.status !== 'active') {
    await supabase
      .from('blue_sessions')
      .update({ revoked_at: nowIso })
      .eq('session_token_hash', tokenHash)
      .is('revoked_at', null);

    res.setHeader('Set-Cookie', buildClearSessionCookie());
    res.status(200).json({
      loggedIn: false,
      rewards: [],
      reason: 'account_missing'
    });
    return;
  }

  await supabase
    .from('blue_sessions')
    .update({ last_seen_at: nowIso })
    .eq('session_token_hash', tokenHash)
    .is('revoked_at', null);

  res.status(200).json({
    loggedIn: true,
    accountId: account.account_id,
    rewards: normalizeRewards(account.rewards),
    cookieConsent:
      typeof account.cookie_history_consent === 'string'
        ? account.cookie_history_consent
        : 'unknown',
    cookieConsentUpdatedAt: account.cookie_history_consent_updated_at || null,
    cookieConsentSchemaMissing: !!cookieConsentSchemaMissing,
    reason: 'ok'
  });
}
