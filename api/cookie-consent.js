import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import {
  buildClearSessionCookie,
  hashSessionToken,
  readSessionFromRequest
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

function normalizeConsent(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'accepted' || normalized === 'declined') {
    return normalized;
  }
  return 'unknown';
}

function buildMissingSchemaMessage(error) {
  const code = error && error.code ? String(error.code) : '';
  if (code === '42P01' || code === '42703') {
    return 'Cookie consent columns are missing. Run supabase/blue_mode_auth.sql again.';
  }
  return null;
}

async function readAccountWithConsentFallback(supabase, accountId) {
  const preferred = await supabase
    .from('blue_accounts')
    .select('account_id, status, cookie_history_consent, cookie_history_consent_updated_at')
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
    .select('account_id, status')
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

async function readActiveAccount(supabase, req, res) {
  const rawSession = readSessionFromRequest(req);
  if (!rawSession) {
    return {
      ok: false,
      status: 200,
      body: {
        loggedIn: false,
        consent: 'unknown',
        reason: 'no_session'
      }
    };
  }

  const tokenHash = hashSessionToken(rawSession);
  const nowIso = new Date().toISOString();

  const { data: sessionRow, error: sessionError } = await supabase
    .from('blue_sessions')
    .select('session_token_hash, account_id, expires_at, revoked_at')
    .eq('session_token_hash', tokenHash)
    .maybeSingle();

  if (sessionError) {
    return {
      ok: false,
      status: 500,
      body: {
        loggedIn: false,
        consent: 'unknown',
        error:
          sessionError.code === '42P01'
            ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
            : 'Could not read session',
        detail: sessionError.message || null
      }
    };
  }

  const invalidSession =
    !sessionRow ||
    !!sessionRow.revoked_at ||
    !sessionRow.expires_at ||
    new Date(sessionRow.expires_at).getTime() <= Date.now();

  if (invalidSession) {
    res.setHeader('Set-Cookie', buildClearSessionCookie());
    return {
      ok: false,
      status: 200,
      body: {
        loggedIn: false,
        consent: 'unknown',
        reason: 'invalid_session'
      }
    };
  }

  const {
    data: account,
    error: accountError,
    schemaMissing
  } = await readAccountWithConsentFallback(supabase, sessionRow.account_id);

  if (accountError) {
    return {
      ok: false,
      status: 500,
      body: {
        loggedIn: false,
        consent: 'unknown',
        error:
          buildMissingSchemaMessage(accountError)
          || (accountError.code === '42P01'
            ? 'Auth tables are missing. Run supabase/blue_mode_auth.sql first.'
            : 'Could not read account'),
        detail: accountError.message || null
      }
    };
  }

  if (!account || account.status !== 'active') {
    await supabase
      .from('blue_sessions')
      .update({ revoked_at: nowIso })
      .eq('session_token_hash', tokenHash)
      .is('revoked_at', null);

    res.setHeader('Set-Cookie', buildClearSessionCookie());
    return {
      ok: false,
      status: 200,
      body: {
        loggedIn: false,
        consent: 'unknown',
        reason: 'account_missing'
      }
    };
  }

  await supabase
    .from('blue_sessions')
    .update({ last_seen_at: nowIso })
    .eq('session_token_hash', tokenHash)
    .is('revoked_at', null);

  return {
    ok: true,
    account,
    nowIso,
    schemaMissing
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { client: supabase, error: envError } = getSupabaseAdmin();
  if (!supabase) {
    res.status(500).json({
      error: envError || 'Supabase is not configured',
      consent: 'unknown',
      loggedIn: false
    });
    return;
  }

  const active = await readActiveAccount(supabase, req, res);
  if (!active.ok) {
    res.status(active.status).json(active.body);
    return;
  }

  const { account, nowIso, schemaMissing } = active;

  if (req.method === 'GET') {
    res.status(200).json({
      loggedIn: true,
      accountId: account.account_id,
      consent: normalizeConsent(account.cookie_history_consent),
      updatedAt: account.cookie_history_consent_updated_at || null,
      schemaMissing: !!schemaMissing
    });
    return;
  }

  if (schemaMissing) {
    res.status(200).json({
      loggedIn: true,
      accountId: account.account_id,
      consent: 'unknown',
      updatedAt: null,
      schemaMissing: true,
      persisted: false
    });
    return;
  }

  if (req.method === 'DELETE') {
    const { error: updateError } = await supabase
      .from('blue_accounts')
      .update({
        cookie_history_consent: 'unknown',
        cookie_history_consent_updated_at: null,
        updated_at: nowIso
      })
      .eq('account_id', account.account_id);

    if (updateError) {
      res.status(500).json({
        loggedIn: true,
        accountId: account.account_id,
        consent: normalizeConsent(account.cookie_history_consent),
        error: buildMissingSchemaMessage(updateError) || 'Could not clear cookie consent',
        detail: updateError.message || null
      });
      return;
    }

    res.status(200).json({
      loggedIn: true,
      accountId: account.account_id,
      consent: 'unknown',
      updatedAt: null
    });
    return;
  }

  const body = readBody(req);
  const consent = normalizeConsent(body.consent);
  if (consent === 'unknown') {
    res.status(400).json({
      error: 'Consent must be accepted or declined',
      loggedIn: true,
      accountId: account.account_id,
      consent: normalizeConsent(account.cookie_history_consent)
    });
    return;
  }

  const { error: updateError } = await supabase
    .from('blue_accounts')
    .update({
      cookie_history_consent: consent,
      cookie_history_consent_updated_at: nowIso,
      updated_at: nowIso
    })
    .eq('account_id', account.account_id);

  if (updateError) {
    res.status(500).json({
      loggedIn: true,
      accountId: account.account_id,
      consent: normalizeConsent(account.cookie_history_consent),
      error: buildMissingSchemaMessage(updateError) || 'Could not save cookie consent',
      detail: updateError.message || null
    });
    return;
  }

  res.status(200).json({
    loggedIn: true,
    accountId: account.account_id,
    consent,
    updatedAt: nowIso
  });
}
