import { createHash, createHmac } from 'crypto';

import { hashSessionToken, readSessionFromRequest } from './blue-auth.js';
import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getEmailIdentity } from './email-verification.js';
import { getGoogleIdentity } from './google-oauth.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import {
  CONDITIONAL_FUNDING_MODEL,
  createConditionalShareSnapshot,
  normalizeConditionalFunding,
  planConditionalReturns
} from './conditional-share.js';
import { identityOwnsProblem } from './problem-access.js';
import { assertProblemProofBinding, assertTrustedCicRecord } from './problem-proof-binding.js';
import { getSupabaseAdmin } from './supabase-admin.js';
import {
  verifyBountyCheckoutSession,
  verifyConditionalCheckoutSession
} from './stripe-payment-verify.js';

const DEFAULT_YEN_PER_VX = 200;
const DEFAULT_USD_JPY_RATE = 160;

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function hashIdentifier(value) {
  const text = safeString(value);
  return text ? createHash('sha256').update(text).digest('hex') : '';
}

function normalizeEmail(value) {
  const email = safeString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function ledgerDigest(payload) {
  const secret = safeString(
    process.env.IVUCX_LEDGER_SECRET
    || process.env.VX_LEDGER_SECRET
    || process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  if (!secret) {
    const error = new Error('Vx ledger signing secret is missing.');
    error.statusCode = 503;
    throw error;
  }
  const serialized = stableStringify(payload);
  return createHmac('sha256', secret).update(serialized).digest('hex');
}

async function buildVxLedgerSeal(supabase, identity, entry) {
  const accountIdHash = safeString(identity && identity.accountIdHash) || getIdentityHash(identity || {});
  let previousHash = '';
  try {
    const { data, error } = await supabase
      .from('ivucx_transactions')
      .select('meta,created_at,idempotency_key')
      .eq('account_provider', safeString(identity && identity.accountProvider))
      .eq('account_id_hash', accountIdHash)
      .order('created_at', { ascending: false })
      .limit(5);
    if (!error) {
      const rows = Array.isArray(data) ? data : [];
      const previous = rows.find((row) => isPlainObject(row && row.meta) && isPlainObject(row.meta.ledger) && safeString(row.meta.ledger.hash));
      previousHash = safeString(previous && previous.meta && previous.meta.ledger && previous.meta.ledger.hash);
    }
  } catch (error) {
    previousHash = '';
  }
  const payload = {
    scheme: 'provf-vx-account-chain-v1',
    previousHash,
    accountProvider: safeString(identity && identity.accountProvider),
    accountIdHash,
    entry
  };
  const hash = ledgerDigest(payload);
  return {
    scheme: 'provf-vx-account-chain-v1',
    previousHash,
    hash,
    algorithm: 'hmac-sha256',
    sealedAt: new Date().toISOString()
  };
}

async function creditIvucxAccountAtomic({
  supabase,
  identity,
  amountVx,
  amountYen,
  reason,
  idempotencyKey,
  problemId,
  solutionProblemId,
  bounty,
  meta,
  nowIso
}) {
  const accountIdHash = safeString(identity && identity.accountIdHash) || getIdentityHash(identity || {});
  const { data, error } = await supabase.rpc('credit_ivucx_account', {
    p_account_provider: safeString(identity && identity.accountProvider),
    p_account_id: safeString(identity && identity.accountId),
    p_account_id_hash: accountIdHash,
    p_email: normalizeEmail(identity && identity.email),
    p_name: safeString(identity && identity.name),
    p_amount_vx: amountVx,
    p_amount_yen: amountYen,
    p_currency: 'jpy',
    p_reason: reason,
    p_idempotency_key: idempotencyKey,
    p_problem_id: problemId || null,
    p_solution_problem_id: solutionProblemId || null,
    p_bounty: bounty || {},
    p_meta: meta || {},
    p_created_at: nowIso
  });
  if (error) {
    const migrationMissing = /credit_ivucx_account|schema cache|function/i.test(String(error.message || error.details || ''));
    const rpcError = new Error(
      migrationMissing
        ? 'Secure Vx settlement is not ready. Apply the latest Supabase migration.'
        : (error.message || 'Secure Vx settlement failed.')
    );
    rpcError.statusCode = migrationMissing ? 503 : 502;
    throw rpcError;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.transaction_id) {
    const invalid = new Error('Secure Vx settlement returned an invalid result.');
    invalid.statusCode = 502;
    throw invalid;
  }
  return {
    inserted: row.inserted === true,
    transactionId: safeString(row.transaction_id),
    balance: normalizeAccountRow({ balance_vx: row.balance_vx, balance_yen: row.balance_yen })
  };
}

function isMissingRelationError(error, relationName = '') {
  const message = String(error && (error.message || error.details || error.hint) || '').toLowerCase();
  const relation = String(relationName || '').trim().toLowerCase();
  return (
    error?.code === 'PGRST205'
    || error?.code === '42P01'
    || message.includes('schema cache')
    || (relation && message.includes(`public.${relation}`))
    || (relation && message.includes(`"${relation}"`))
    || message.includes('does not exist')
  );
}

function isMissingColumnError(error, columnName = '') {
  const message = String(error && (error.message || error.details || error.hint) || '').toLowerCase();
  const column = String(columnName || '').trim().toLowerCase();
  return !!column && (
    message.includes(`column ${column}`)
    || message.includes(`column "${column}"`)
    || message.includes(`'${column}' column`)
    || message.includes(`could not find the '${column}' column`)
  );
}

async function insertIvucxTransaction(supabase, row) {
  let response = await supabase.from('ivucx_transactions').insert(row);
  if (response.error && isMissingColumnError(response.error, 'email')) {
    const { email, ...legacyRow } = row;
    response = await supabase.from('ivucx_transactions').insert(legacyRow);
  }
  return response;
}

function getYenPerVx() {
  return DEFAULT_YEN_PER_VX;
}

function getUsdJpyRate() {
  const value = Number(process.env.IVUCX_USD_JPY_RATE || DEFAULT_USD_JPY_RATE);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_USD_JPY_RATE;
}

function toFixedVx(value) {
  const numeric = Number(value) || 0;
  return Math.round(numeric * 1000000) / 1000000;
}

function normalizeProofState(value) {
  const text = safeString(value).toUpperCase();
  return /^(YY|NY|YN|NN)$/.test(text) ? text : '';
}

function normalizeBounty(value) {
  if (!isPlainObject(value)) return null;
  const rawAmount = Number(value.amountCents || value.amount_cents || value.amountTotal || value.amount || 0);
  const amountCents = Math.max(0, Math.round(Number.isFinite(rawAmount) ? rawAmount : 0));
  const currency = safeString(value.currency, 'usd').toLowerCase();
  if (!amountCents) return null;
  return {
    amountCents,
    currency: /^[a-z]{3}$/.test(currency) ? currency : 'usd',
    status: safeString(value.status),
    paymentStatus: safeString(value.paymentStatus || value.payment_status || value.stripePaymentStatus),
    stripeSessionId: safeString(value.stripeSessionId || value.sessionId),
    stripePaymentIntentId: safeString(value.stripePaymentIntentId || value.paymentIntentId),
    serverVerified: value.serverVerified === true,
    verifiedAt: safeString(value.verifiedAt),
    updatedAt: safeString(value.updatedAt)
  };
}

function bountyToYen(bounty) {
  const normalized = normalizeBounty(bounty);
  if (!normalized) return 0;
  if (normalized.currency === 'jpy') {
    return Math.max(0, Math.round(normalized.amountCents));
  }
  if (normalized.currency === 'usd') {
    return Math.max(0, Math.round((normalized.amountCents / 100) * getUsdJpyRate()));
  }
  return 0;
}

function yenToVx(yen) {
  return toFixedVx((Math.max(0, Math.round(Number(yen) || 0))) / getYenPerVx());
}

function getIdentityHash(identity) {
  return hashIdentifier(`${safeString(identity && identity.accountProvider)}:${safeString(identity && identity.accountId)}`);
}

function buildIdentityAliases(identity) {
  const aliases = [];
  const seen = new Set();
  const add = (accountProvider, accountId) => {
    const provider = safeString(accountProvider);
    const id = provider === 'email' || provider === 'google'
      ? normalizeEmail(accountId)
      : safeString(accountId);
    if (!provider || !id) return;
    const key = `${provider}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    aliases.push({
      accountProvider: provider,
      accountId: id,
      accountIdHash: hashIdentifier(key)
    });
  };
  add(identity && identity.accountProvider, identity && identity.accountId);
  const email = normalizeEmail(identity && identity.email);
  if (email) {
    add('email', email);
    add('google', email);
  }
  return aliases;
}

async function getBlueSessionIdentity(req, supabase) {
  if (!supabase) return null;
  const rawSession = readSessionFromRequest(req);
  if (!rawSession) return null;
  const sessionHash = hashSessionToken(rawSession);
  const { data, error } = await supabase
    .from('blue_sessions')
    .select('account_id, expires_at, revoked_at')
    .eq('session_token_hash', sessionHash)
    .maybeSingle();
  if (error || !data || !data.account_id) return null;
  if (data.revoked_at) return null;
  if (data.expires_at && new Date(data.expires_at).getTime() <= Date.now()) return null;
  return {
    authenticated: true,
    accountProvider: 'blue',
    accountId: safeString(data.account_id),
    email: '',
    name: ''
  };
}

export async function getIvucxIdentity(req, supabase = null) {
  const google = await getGoogleIdentity(req);
  if (google && google.authenticated) {
    const email = normalizeEmail(google.email);
    const accountId = email || safeString(google.accountId || google.name, 'Google account');
    const accountProvider = email ? 'email' : 'google';
    const identity = {
      authenticated: true,
      accountProvider,
      accountId,
      accountIdHash: hashIdentifier(`${accountProvider}:${accountId}`),
      email,
      name: safeString(google.name)
    };
    return {
      ...identity,
      accountAliases: buildIdentityAliases(identity)
    };
  }

  const email = getEmailIdentity(req);
  if (email && email.authenticated) {
    const accountId = normalizeEmail(email.accountId || email.email);
    const identity = {
      authenticated: true,
      accountProvider: 'email',
      accountId,
      accountIdHash: hashIdentifier(`email:${accountId}`),
      email: normalizeEmail(email.email),
      name: safeString(email.name)
    };
    return {
      ...identity,
      accountAliases: buildIdentityAliases(identity)
    };
  }

  const blue = await getBlueSessionIdentity(req, supabase);
  if (blue && blue.authenticated) {
    const identity = {
      ...blue,
      accountIdHash: getIdentityHash(blue)
    };
    return {
      ...identity,
      accountAliases: buildIdentityAliases(identity)
    };
  }

  return {
    authenticated: false,
    accountProvider: '',
    accountId: '',
    accountIdHash: '',
    email: '',
    name: '',
    accountAliases: []
  };
}

function buildAccountRow(identity) {
  const now = new Date().toISOString();
  return {
    account_provider: identity.accountProvider,
    account_id: identity.accountId,
    account_id_hash: identity.accountIdHash || getIdentityHash(identity),
    email: identity.email || null,
    name: identity.name || null,
    balance_vx: 0,
    balance_yen: 0,
    updated_at: now
  };
}

function normalizeAccountRow(row) {
  const balanceYen = Math.max(0, Math.round(Number(row && row.balance_yen) || 0));
  const balanceVx = toFixedVx(Number(row && row.balance_vx) || yenToVx(balanceYen));
  return {
    balanceVx,
    balanceYen,
    yenPerVx: getYenPerVx(),
    display: `Vx ${balanceVx.toLocaleString('en-US', { maximumFractionDigits: 6 })}(¥ ${balanceYen.toLocaleString('ja-JP')})`
  };
}

async function ensureIvucxAccount(supabase, identity) {
  const accountIdHash = identity.accountIdHash || getIdentityHash(identity);
  const existing = await supabase
    .from('ivucx_accounts')
    .select('balance_vx,balance_yen')
    .eq('account_provider', identity.accountProvider)
    .eq('account_id_hash', accountIdHash)
    .maybeSingle();
  if (!existing.error && existing.data) {
    return existing.data;
  }
  if (existing.error) throw existing.error;

  const inserted = await supabase
    .from('ivucx_accounts')
    .insert(buildAccountRow(identity))
    .select('balance_vx,balance_yen')
    .single();
  if (inserted.error) throw inserted.error;
  return inserted.data || { balance_vx: 0, balance_yen: 0 };
}

async function reconcileIvucxAccountBalance(supabase, identity, nowIso) {
  const accountIdHash = identity.accountIdHash || getIdentityHash(identity);
  const aliasHashes = buildIdentityAliases(identity).map((alias) => alias.accountIdHash).filter(Boolean);
  const data = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const page = await supabase
      .from('ivucx_transactions')
      .select('direction,amount_vx,amount_yen,account_provider,account_id_hash')
      .in('account_id_hash', aliasHashes.length ? aliasHashes : [accountIdHash])
      .range(from, from + pageSize - 1);
    if (page.error) throw page.error;
    const rows = Array.isArray(page.data) ? page.data : [];
    data.push(...rows);
    if (rows.length < pageSize) break;
  }

  let balanceYen = 0;
  let balanceVx = 0;
  const allowedHashes = new Set(aliasHashes.length ? aliasHashes : [accountIdHash]);
  for (const row of data) {
    if (!allowedHashes.has(safeString(row.account_id_hash))) continue;
    const sign = safeString(row.direction) === 'debit' ? -1 : 1;
    balanceYen += sign * Math.max(0, Math.round(Number(row.amount_yen) || 0));
    balanceVx = toFixedVx(balanceVx + sign * Math.max(0, Number(row.amount_vx) || 0));
  }
  balanceYen = Math.max(0, Math.round(balanceYen));
  balanceVx = toFixedVx(Math.max(0, balanceVx));

  const updated = await supabase
    .from('ivucx_accounts')
    .update({
      balance_vx: balanceVx,
      balance_yen: balanceYen,
      updated_at: nowIso
    })
    .eq('account_provider', identity.accountProvider)
    .eq('account_id_hash', accountIdHash)
    .lte('balance_yen', balanceYen)
    .select('balance_vx,balance_yen')
    .maybeSingle();
  if (updated.error) throw updated.error;
  if (updated.data) {
    return normalizeAccountRow(updated.data);
  }

  const latest = await supabase
    .from('ivucx_accounts')
    .select('balance_vx,balance_yen')
    .eq('account_provider', identity.accountProvider)
    .eq('account_id_hash', accountIdHash)
    .maybeSingle();
  if (latest.error) throw latest.error;
  return normalizeAccountRow(latest.data || { balance_vx: balanceVx, balance_yen: balanceYen });
}

function normalizeNotification(row) {
  const meta = isPlainObject(row && row.meta) ? row.meta : {};
  return {
    id: safeString(row && row.id),
    type: safeString(row && row.type),
    title: safeString(row && row.title, 'Notification'),
    message: safeString(row && row.message),
    problemId: safeString(row && row.problem_id),
    solutionProblemId: safeString(row && row.solution_problem_id),
    createdAt: safeString(row && row.created_at),
    readAt: safeString(row && row.read_at),
    meta
  };
}

async function listNotifications(supabase, identity, limit = 6) {
  const aliasHashes = buildIdentityAliases(identity).map((alias) => alias.accountIdHash).filter(Boolean);
  const { data, error } = await supabase
    .from('ivucx_notifications')
    .select('id,type,title,message,problem_id,solution_problem_id,meta,read_at,created_at,account_provider,account_id_hash')
    .in('account_id_hash', aliasHashes.length ? aliasHashes : [identity.accountIdHash || getIdentityHash(identity)])
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 6, 12)));
  if (error) throw error;
  const allowedHashes = new Set(aliasHashes.length ? aliasHashes : [identity.accountIdHash || getIdentityHash(identity)]);
  return (Array.isArray(data) ? data : [])
    .filter((row) => allowedHashes.has(safeString(row && row.account_id_hash)))
    .map(normalizeNotification);
}

function normalizeTransaction(row) {
  const meta = isPlainObject(row && row.meta) ? row.meta : {};
  return {
    id: safeString(row && row.id),
    direction: safeString(row && row.direction, 'credit'),
    amountVx: toFixedVx(Number(row && row.amount_vx) || 0),
    amountYen: Math.max(0, Math.round(Number(row && row.amount_yen) || 0)),
    currency: safeString(row && row.currency, 'jpy').toLowerCase(),
    reason: safeString(row && row.reason, 'account_activity'),
    title: safeString(meta.problemTitle || meta.conditionalTitle || meta.theoremTitle),
    problemId: safeString(row && row.problem_id),
    solutionProblemId: safeString(row && row.solution_problem_id),
    createdAt: safeString(row && row.created_at)
  };
}

async function listTransactions(supabase, identity, limit = 60) {
  const aliasHashes = buildIdentityAliases(identity).map((alias) => alias.accountIdHash).filter(Boolean);
  const allowedHashes = new Set(aliasHashes.length ? aliasHashes : [identity.accountIdHash || getIdentityHash(identity)]);
  const maxRows = Math.max(1, Math.min(Number(limit) || 60, 120));
  const baseQuery = supabase
    .from('ivucx_transactions')
    .select('id,account_provider,account_id_hash,email,direction,amount_vx,amount_yen,currency,reason,problem_id,solution_problem_id,meta,created_at')
    .in('account_id_hash', Array.from(allowedHashes))
    .order('created_at', { ascending: false })
    .limit(maxRows);
  let response = await baseQuery;
  if (response.error && /column .*email|email .*column|schema cache/i.test(String(response.error.message || response.error.details || ''))) {
    response = await supabase
      .from('ivucx_transactions')
      .select('id,account_provider,account_id_hash,direction,amount_vx,amount_yen,currency,reason,problem_id,solution_problem_id,meta,created_at')
      .in('account_id_hash', Array.from(allowedHashes))
      .order('created_at', { ascending: false })
      .limit(maxRows);
  }
  if (response.error) throw response.error;

  const normalizedEmail = normalizeEmail(identity && identity.email);
  return (Array.isArray(response.data) ? response.data : [])
    .filter((row) => {
      if (!allowedHashes.has(safeString(row && row.account_id_hash))) return false;
      const rowEmail = normalizeEmail(row && row.email);
      return !rowEmail || !normalizedEmail || rowEmail === normalizedEmail;
    })
    .map(normalizeTransaction);
}

function samePublicIdentity(left, right) {
  if (!left || !right) return false;
  const leftProvider = safeString(left.accountProvider || left.provider);
  const rightProvider = safeString(right.accountProvider || right.provider);
  const leftHash = safeString(left.accountIdHash) || hashIdentifier(`${leftProvider}:${safeString(left.accountId || left.id)}`);
  const rightHash = safeString(right.accountIdHash) || hashIdentifier(`${rightProvider}:${safeString(right.accountId || right.id)}`);
  return !!(leftProvider && rightProvider && leftProvider === rightProvider && leftHash && leftHash === rightHash);
}

function getSolutionMeta(row) {
  const meta = isPlainObject(row && row.request_meta) ? row.request_meta : {};
  const solution = isPlainObject(meta.solution) ? meta.solution : null;
  return solution && solution.status === 'solved' ? solution : null;
}

async function getFallbackSnapshotFromProblems(supabase, identity) {
  const { data, error } = await supabase
    .from('problems')
    .select('id,title,request_meta,updated_at,created_at')
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const creditedKeys = new Set();
  let balanceYen = 0;
  let balanceVx = 0;
  const notifications = [];

  for (const row of rows) {
    const solution = getSolutionMeta(row);
    if (solution) {
      const bounty = isPlainObject(solution.bounty) ? solution.bounty : {};
      const key = safeString(solution.solutionProblemId || row.id);
      if (samePublicIdentity(solution.solver, identity) && key && !creditedKeys.has(key)) {
        creditedKeys.add(key);
        const awardedYen = Math.max(0, Math.round(Number(bounty.awardedYen) || 0));
        const awardedVx = toFixedVx(Number(bounty.awardedVx) || yenToVx(awardedYen));
        balanceYen += awardedYen;
        balanceVx = toFixedVx(balanceVx + awardedVx);
      }
      if (samePublicIdentity(solution.creator, identity)) {
        const amountText = Number(bounty.awardedVx) > 0
          ? ` Awarded Vx ${Number(bounty.awardedVx).toLocaleString('en-US', { maximumFractionDigits: 6 })}.`
          : '';
        notifications.push({
          id: `solution-${safeString(solution.originalProblemId || row.id)}-${safeString(solution.solutionProblemId || '')}`,
          type: 'problem_solved',
          title: 'Problem solved',
          message: `${safeString(solution.problemTitle || row.title, 'Your problem')} was solved as ${safeString(solution.theoremTitle, 'Solved theorem')}.${amountText}`,
          problemId: safeString(solution.originalProblemId || row.id),
          solutionProblemId: safeString(solution.solutionProblemId),
          createdAt: safeString(solution.solvedAt || row.updated_at || row.created_at),
          readAt: '',
          meta: { solution }
        });
      }
      const conditionalUsage = Array.isArray(bounty.conditionalUsage) ? bounty.conditionalUsage : [];
      for (const usage of conditionalUsage) {
        if (!isPlainObject(usage) || !samePublicIdentity(usage.recipient, identity)) continue;
        const usageKey = safeString(usage.idempotencyKey) || `usage-${safeString(solution.solutionProblemId)}-${safeString(usage.conditionalProblemId)}`;
        const amountYen = Math.max(0, Math.round(Number(usage.amountYen) || 0));
        const amountVx = toFixedVx(Number(usage.amountVx) || yenToVx(amountYen));
        if (usageKey && !creditedKeys.has(usageKey) && amountYen > 0) {
          creditedKeys.add(usageKey);
          balanceYen += amountYen;
          balanceVx = toFixedVx(balanceVx + amountVx);
        }
        notifications.push({
          id: usageKey,
          type: 'conditional_usage_award',
          title: 'Conditional used',
          message: `${safeString(usage.conditionalTitle, 'Your Conditional')} was used to solve ${safeString(solution.problemTitle || row.title, 'a problem')}. Vx ${amountVx.toLocaleString('en-US', { maximumFractionDigits: 6 })} was credited.`,
          problemId: safeString(solution.originalProblemId || row.id),
          solutionProblemId: safeString(solution.solutionProblemId),
          createdAt: safeString(solution.solvedAt || row.updated_at || row.created_at),
          readAt: '',
          meta: { usage, solution }
        });
      }
    }

    const meta = isPlainObject(row.request_meta) ? row.request_meta : {};
    const conditionals = Array.isArray(meta.conditionals) ? meta.conditionals : [];
    for (const conditional of conditionals) {
      if (!isPlainObject(conditional) || !samePublicIdentity(conditional.creator, identity)) continue;
      const bounty = isPlainObject(conditional.bounty) ? conditional.bounty : {};
      const creatorCredit = isPlainObject(bounty.creatorCredit) ? bounty.creatorCredit : {};
      const key = `conditional-${safeString(conditional.originalProblemId || row.id)}-${safeString(conditional.conditionalProblemId)}`;
      const amountYen = Math.max(0, Math.round(Number(creatorCredit.amountYen || (bounty.split && bounty.split.creatorYen)) || 0));
      const amountVx = toFixedVx(Number(creatorCredit.amountVx) || yenToVx(amountYen));
      if (key && !creditedKeys.has(key) && amountYen > 0) {
        creditedKeys.add(key);
        balanceYen += amountYen;
        balanceVx = toFixedVx(balanceVx + amountVx);
      }
      notifications.push({
        id: key,
        type: 'conditional_posted',
        title: 'Conditional posted',
        message: `${safeString(conditional.problemTitle || row.title, 'Your problem')} received ${safeString(conditional.conditionalTitle, 'a Conditional proof')}. Vx ${amountVx.toLocaleString('en-US', { maximumFractionDigits: 6 })} was credited.`,
        problemId: safeString(conditional.originalProblemId || row.id),
        solutionProblemId: safeString(conditional.conditionalProblemId),
        createdAt: safeString(conditional.postedAt || row.updated_at || row.created_at),
        readAt: '',
        meta: { conditional }
      });
    }
  }

  return {
    balance: normalizeAccountRow({ balance_vx: balanceVx, balance_yen: balanceYen }),
    notifications: notifications.slice(0, 6)
  };
}

export async function getIvucxAccountSnapshot(req) {
  const { client: supabase, error } = getSupabaseAdmin();
  const identity = await getIvucxIdentity(req, supabase);
  if (!identity.authenticated) {
    return {
      loggedIn: false,
      identity,
      balance: normalizeAccountRow({ balance_vx: 0, balance_yen: 0 }),
      notifications: [],
      transactions: [],
      rewards: [],
      unavailable: !supabase,
      error: supabase ? '' : error
    };
  }
  if (!supabase) {
    return {
      loggedIn: true,
      identity,
      balance: normalizeAccountRow({ balance_vx: 0, balance_yen: 0 }),
      notifications: [],
      transactions: [],
      rewards: [],
      unavailable: true,
      error
    };
  }

  try {
    const account = await ensureIvucxAccount(supabase, identity);
    const [notifications, transactions] = await Promise.all([
      listNotifications(supabase, identity),
      listTransactions(supabase, identity)
    ]);
    return {
      loggedIn: true,
      identity,
      balance: normalizeAccountRow(account),
      notifications,
      transactions,
      rewards: [],
      unavailable: false,
      error: ''
    };
  } catch (err) {
    try {
      const fallback = await getFallbackSnapshotFromProblems(supabase, identity);
      return {
        loggedIn: true,
        identity,
        balance: fallback.balance,
        notifications: fallback.notifications,
        transactions: [],
        rewards: [],
        unavailable: true,
        fallback: 'problems-request-meta',
        error: err && err.message ? err.message : String(err)
      };
    } catch (fallbackErr) {
      // Fall through to the zero-balance safe response.
    }
    return {
      loggedIn: true,
      identity,
      balance: normalizeAccountRow({ balance_vx: 0, balance_yen: 0 }),
      notifications: [],
      transactions: [],
      rewards: [],
      unavailable: true,
      error: err && err.message ? err.message : String(err)
    };
  }
}

function extractCreatorIdentity(problemMeta) {
  const candidates = [
    problemMeta && problemMeta.createdByAccount,
    problemMeta && problemMeta.creator,
    problemMeta && problemMeta.author,
    problemMeta && problemMeta.account
  ];
  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const accountProvider = safeString(candidate.accountProvider || candidate.provider);
    const accountId = safeString(candidate.accountId || candidate.id);
    if (!accountProvider || !accountId) continue;
    return {
      accountProvider,
      accountId,
      accountIdHash: safeString(candidate.accountIdHash) || hashIdentifier(`${accountProvider}:${accountId}`),
      email: safeString(candidate.email),
      name: safeString(candidate.name)
    };
  }
  return null;
}

function publicIdentity(identity) {
  if (!identity || !identity.authenticated) return null;
  return {
    accountProvider: identity.accountProvider,
    accountId: identity.accountId,
    accountIdHash: identity.accountIdHash || getIdentityHash(identity),
    email: identity.email || '',
    name: identity.name || ''
  };
}

async function loadProblemRow(supabase, id, label) {
  const problemId = safeString(id);
  if (!problemId) {
    const error = new Error(`${label} is required.`);
    error.statusCode = 400;
    throw error;
  }
  const { data, error } = await supabase
    .from('problems')
    .select('id,title,language,file_name,source_code,source_sha256,proof_state,verification_status,verification_result,normalized_format,normalized_term,adapter_meta,request_meta,created_at,updated_at')
    .eq('id', problemId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.id) {
    const notFound = new Error(`${label} was not found.`);
    notFound.statusCode = 404;
    throw notFound;
  }
  return data;
}

async function buildSolverBountyPayout({ supabase, identity, originalProblem, solutionProblem, bounty, nowIso }) {
  const amountYen = bountyToYen(bounty);
  const amountVx = yenToVx(amountYen);
  const idempotencyKey = `problem-solution:${originalProblem.id}:${solutionProblem.id}`;
  if (amountYen <= 0 || amountVx <= 0) {
    return {
      credit: {
        credited: false,
        amountYen: 0,
        amountVx: 0,
        idempotencyKey,
        reason: 'no_bounty'
      },
      payout: null
    };
  }

  const ledger = await buildVxLedgerSeal(supabase, identity, {
    direction: 'credit',
    amountVx,
    amountYen,
    reason: 'problem_bounty_award',
    idempotencyKey,
    problemId: originalProblem.id,
    solutionProblemId: solutionProblem.id,
    createdAt: nowIso
  });

  const meta = {
    problemTitle: originalProblem.title || '',
    theoremTitle: solutionProblem.title || '',
    yenPerVx: getYenPerVx(),
    usdJpyRate: getUsdJpyRate(),
    ledger
  };
  return {
    credit: {
      credited: true,
      amountYen,
      amountVx,
      idempotencyKey
    },
    payout: {
      accountProvider: safeString(identity && identity.accountProvider),
      accountId: safeString(identity && identity.accountId),
      accountIdHash: safeString(identity && identity.accountIdHash) || getIdentityHash(identity || {}),
      email: normalizeEmail(identity && identity.email),
      name: safeString(identity && identity.name),
      amountVx,
      amountYen,
      reason: 'problem_bounty_award',
      idempotencyKey,
      bounty: normalizeBounty(bounty),
      meta
    }
  };
}

async function notifyProblemCreator({ supabase, creator, solver, originalProblem, solutionProblem, bountyCredit, nowIso }) {
  if (!creator || !creator.accountProvider || !creator.accountIdHash) {
    return { notified: false, reason: 'missing_creator' };
  }
  const solverHash = solver.accountIdHash || getIdentityHash(solver);
  if (creator.accountProvider === solver.accountProvider && creator.accountIdHash === solverHash) {
    return { notified: false, reason: 'solver_is_creator' };
  }

  const idempotencyKey = `problem-solved-notification:${originalProblem.id}:${solutionProblem.id}:${creator.accountProvider}:${creator.accountIdHash}`;
  const existing = await supabase
    .from('ivucx_notifications')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (isMissingRelationError(existing.error, 'ivucx_notifications')) {
    return { notified: true, fallback: 'problems-request-meta', idempotencyKey };
  }
  if (!existing.error && existing.data && existing.data.id) {
    return { notified: false, duplicate: true, id: existing.data.id };
  }
  if (existing.error) throw existing.error;

  const title = 'Problem solved';
  const theoremTitle = safeString(solutionProblem.title, 'Solved theorem');
  const amountText = bountyCredit && Number(bountyCredit.amountVx) > 0
    ? ` Awarded Vx ${Number(bountyCredit.amountVx).toLocaleString('en-US', { maximumFractionDigits: 6 })}.`
    : '';
  const message = `${safeString(originalProblem.title, 'Your problem')} was solved as ${theoremTitle}.${amountText}`;
  const inserted = await supabase
    .from('ivucx_notifications')
    .insert({
      account_provider: creator.accountProvider,
      account_id: creator.accountId,
      account_id_hash: creator.accountIdHash,
      type: 'problem_solved',
      title,
      message,
      problem_id: originalProblem.id,
      solution_problem_id: solutionProblem.id,
      idempotency_key: idempotencyKey,
      meta: {
        problemTitle: originalProblem.title || '',
        theoremTitle,
        solver: publicIdentity(solver),
        bountyCredit
      },
      created_at: nowIso
    })
    .select('id')
    .single();
  if (isMissingRelationError(inserted.error, 'ivucx_notifications')) {
    return { notified: true, fallback: 'problems-request-meta', idempotencyKey };
  }
  if (inserted.error) throw inserted.error;
  return { notified: true, id: inserted.data && inserted.data.id ? inserted.data.id : '' };
}

function normalizeConditionalBounty(value) {
  return normalizeConditionalFunding(value);
}

async function verifyStoredProblemBountyForPayout(originalMeta, originalProblemId) {
  const meta = isPlainObject(originalMeta) ? originalMeta : {};
  const baseCandidate = normalizeBounty(
    meta.originalBountyBeforeConditional
      || meta.originalBounty
      || meta.bounty
  );
  let baseBounty = null;
  let baseYen = 0;
  if (baseCandidate && baseCandidate.stripeSessionId) {
    baseBounty = normalizeBounty(await verifyBountyCheckoutSession(baseCandidate, { skipIdentityCheck: true }));
    baseYen = bountyToYen(baseBounty);
  }

  const conditionalContributions = [];
  const conditionals = Array.isArray(meta.conditionals)
    ? meta.conditionals.filter(isPlainObject)
    : [];
  for (const conditional of conditionals) {
    const storedConditionalBounty = normalizeConditionalBounty(conditional.bounty);
    if (!storedConditionalBounty || !storedConditionalBounty.stripeSessionId) continue;
    const verifiedPayment = normalizeConditionalBounty(await verifyConditionalCheckoutSession(storedConditionalBounty, {
      problemId: originalProblemId,
      skipIdentityCheck: true
    }));
    if (!verifiedPayment || verifiedPayment.amountYen !== storedConditionalBounty.amountYen) {
      const paymentError = new Error('Stored Conditional amount does not match Stripe.');
      paymentError.statusCode = 409;
      throw paymentError;
    }
    const problemBountyYen = verifiedPayment.amountYen;
    conditionalContributions.push({
      conditionalProblemId: safeString(conditional.conditionalProblemId),
      conditionalTitle: safeString(conditional.conditionalTitle, 'Conditional'),
      amountYen: problemBountyYen,
      amountVx: yenToVx(problemBountyYen),
      fixedSharePpm: storedConditionalBounty.fixedSharePpm,
      existingBountyYen: storedConditionalBounty.existingBountyYen,
      fundingModel: storedConditionalBounty.fundingModel,
      stripeSessionId: verifiedPayment.stripeSessionId,
      verifiedAt: verifiedPayment.verifiedAt
    });
  }

  const conditionalYen = conditionalContributions.reduce((sum, item) => sum + item.amountYen, 0);
  const totalYen = Math.max(0, baseYen + conditionalYen);
  if (totalYen <= 0) return null;
  return {
    amountCents: totalYen,
    currency: 'jpy',
    status: 'funded',
    paymentStatus: 'paid',
    stripeSessionId: baseBounty ? baseBounty.stripeSessionId : '',
    stripePaymentIntentId: baseBounty ? baseBounty.stripePaymentIntentId : '',
    serverVerified: true,
    verifiedAt: new Date().toISOString(),
    baseBounty,
    conditionalContributions
  };
}

async function creditConditionalCreatorShare({ supabase, creator, originalProblem, conditionalProblem, conditionalBounty, nowIso }) {
  const normalized = normalizeConditionalBounty(conditionalBounty);
  const amountYen = normalized && normalized.split ? normalized.split.creatorYen : 0;
  const amountVx = yenToVx(amountYen);
  const idempotencyKey = `problem-conditional-creator:${originalProblem.id}:${conditionalProblem.id}`;
  if (!creator || !creator.accountProvider || !creator.accountIdHash || amountYen <= 0 || amountVx <= 0) {
    return {
      credited: false,
      amountYen: 0,
      amountVx: 0,
      idempotencyKey,
      reason: creator ? 'no_creator_share' : 'missing_creator'
    };
  }

  const ledger = await buildVxLedgerSeal(supabase, creator, {
    direction: 'credit',
    amountVx,
    amountYen,
    reason: 'conditional_creator_share',
    idempotencyKey,
    problemId: originalProblem.id,
    solutionProblemId: conditionalProblem.id,
    createdAt: nowIso
  });
  const settlement = await creditIvucxAccountAtomic({
    supabase,
    identity: creator,
    amountVx,
    amountYen,
    reason: 'conditional_creator_share',
    idempotencyKey,
    problemId: originalProblem.id,
    solutionProblemId: conditionalProblem.id,
    bounty: normalized,
    meta: {
      problemTitle: originalProblem.title || '',
      conditionalTitle: conditionalProblem.title || '',
      split: normalized.split,
      yenPerVx: getYenPerVx(),
      ledger
    },
    nowIso
  });

  return {
    credited: settlement.inserted,
    duplicate: !settlement.inserted,
    amountYen,
    amountVx,
    idempotencyKey,
    transactionId: settlement.transactionId,
    balance: settlement.balance
  };
}

async function notifyConditionalCreator({ supabase, creator, originalProblem, conditionalProblem, creatorCredit, nowIso }) {
  if (!creator || !creator.accountProvider || !creator.accountIdHash) {
    return { notified: false, reason: 'missing_creator' };
  }
  const idempotencyKey = `problem-conditional-notification:${originalProblem.id}:${conditionalProblem.id}:${creator.accountProvider}:${creator.accountIdHash}`;
  const existing = await supabase
    .from('ivucx_notifications')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (isMissingRelationError(existing.error, 'ivucx_notifications')) {
    return { notified: true, fallback: 'problems-request-meta', idempotencyKey };
  }
  if (!existing.error && existing.data && existing.data.id) {
    return { notified: false, duplicate: true, id: existing.data.id };
  }
  if (existing.error) throw existing.error;

  const amountText = creatorCredit && Number(creatorCredit.amountVx) > 0
    ? ` Vx ${Number(creatorCredit.amountVx).toLocaleString('en-US', { maximumFractionDigits: 6 })} was credited.`
    : '';
  const inserted = await supabase
    .from('ivucx_notifications')
    .insert({
      account_provider: creator.accountProvider,
      account_id: creator.accountId,
      account_id_hash: creator.accountIdHash,
      type: 'conditional_posted',
      title: 'Conditional posted',
      message: `${safeString(originalProblem.title, 'Your problem')} received a Conditional proof: ${safeString(conditionalProblem.title, 'Conditional')}.${amountText}`,
      problem_id: originalProblem.id,
      solution_problem_id: conditionalProblem.id,
      idempotency_key: idempotencyKey,
      meta: {
        problemTitle: originalProblem.title || '',
        conditionalTitle: conditionalProblem.title || '',
        creatorCredit
      },
      created_at: nowIso
    })
    .select('id')
    .single();
  if (isMissingRelationError(inserted.error, 'ivucx_notifications')) {
    return { notified: true, fallback: 'problems-request-meta', idempotencyKey };
  }
  if (inserted.error) throw inserted.error;
  return { notified: true, id: inserted.data && inserted.data.id ? inserted.data.id : '' };
}

function resolveUsedConditionals(originalMeta, solveContext) {
  const stored = Array.isArray(originalMeta && originalMeta.conditionals)
    ? originalMeta.conditionals.filter(isPlainObject)
    : [];
  const selected = Array.isArray(solveContext && solveContext.selectedConditionals)
    ? solveContext.selectedConditionals.filter(isPlainObject)
    : [];
  if (!stored.length || !selected.length) return [];
  const selectedIds = new Set(selected.map((item) => safeString(item.conditionalProblemId)).filter(Boolean));
  const used = [];
  const seen = new Set();
  for (const conditional of stored) {
    const id = safeString(conditional.conditionalProblemId);
    if (!id || !selectedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    used.push(conditional);
  }
  return used.slice(0, 20);
}

async function buildConditionalUsagePayouts({
  supabase,
  originalProblem,
  solutionProblem,
  distribution,
  nowIso
}) {
  const plannedPayouts = distribution && Array.isArray(distribution.payouts)
    ? distribution.payouts
    : [];
  const credits = [];
  const payouts = [];

  for (const planned of plannedPayouts) {
    const conditional = planned.conditional;
    const amountYen = planned.amountYen;
    const amountVx = yenToVx(amountYen);
    if (amountYen <= 0 || amountVx <= 0) continue;
    const recipient = extractCreatorIdentity(conditional.submitter) || extractCreatorIdentity(conditional.createdByAccount);
    const conditionalId = safeString(conditional.conditionalProblemId || conditional.conditionalTitle);
    const idempotencyKey = `problem-solution-conditional:${originalProblem.id}:${solutionProblem.id}:${conditionalId}`;
    const baseCredit = {
      conditionalProblemId: safeString(conditional.conditionalProblemId),
      conditionalTitle: safeString(conditional.conditionalTitle, 'Conditional'),
      recipient,
      amountYen,
      amountVx,
      idempotencyKey
    };
    if (!recipient || !recipient.accountProvider || !recipient.accountIdHash) {
      const identityError = new Error('A selected Conditional proof has no verified payout identity.');
      identityError.statusCode = 409;
      throw identityError;
    }

    const ledger = await buildVxLedgerSeal(supabase, recipient, {
      direction: 'credit',
      amountVx,
      amountYen,
      reason: 'conditional_usage_award',
      idempotencyKey,
      problemId: originalProblem.id,
      solutionProblemId: solutionProblem.id,
      conditionalProblemId: safeString(conditional.conditionalProblemId),
      createdAt: nowIso
    });
    const meta = {
      problemTitle: originalProblem.title || '',
      theoremTitle: solutionProblem.title || '',
      conditionalTitle: safeString(conditional.conditionalTitle, 'Conditional'),
      conditionalProblemId: safeString(conditional.conditionalProblemId),
      fundingModel: CONDITIONAL_FUNDING_MODEL,
      fixedSharePpm: planned.fixedSharePpm,
      sharePercent: planned.sharePercent,
      finalBountyYen: distribution.finalBountyYen,
      yenPerVx: getYenPerVx(),
      usdJpyRate: getUsdJpyRate(),
      ledger
    };
    payouts.push({
      accountProvider: safeString(recipient.accountProvider),
      accountId: safeString(recipient.accountId),
      accountIdHash: safeString(recipient.accountIdHash) || getIdentityHash(recipient),
      email: normalizeEmail(recipient.email),
      name: safeString(recipient.name),
      amountVx,
      amountYen,
      reason: 'conditional_usage_award',
      idempotencyKey,
      bounty: null,
      meta
    });

    credits.push({
      ...baseCredit,
      credited: true
    });
  }
  return { credits, payouts };
}

function mergeSettlementCredit(credit, settlementByKey) {
  if (!credit || credit.reason === 'no_bounty') return credit;
  const settlement = settlementByKey.get(safeString(credit.idempotencyKey));
  if (!settlement) {
    const invalid = new Error('Secure Vx settlement omitted a payout result.');
    invalid.statusCode = 502;
    throw invalid;
  }
  return {
    ...credit,
    credited: settlement.inserted === true,
    duplicate: settlement.inserted !== true,
    transactionId: safeString(settlement.transactionId),
    balance: normalizeAccountRow({
      balance_vx: settlement.balanceVx,
      balance_yen: settlement.balanceYen
    })
  };
}

async function settleProblemSolutionAtomic({
  supabase,
  originalProblem,
  solutionProblem,
  finalOriginalMeta,
  finalSolutionMeta,
  payouts,
  nowIso
}) {
  const { data, error } = await supabase.rpc('settle_problem_solution', {
    p_original_problem_id: originalProblem.id,
    p_solution_problem_id: solutionProblem.id,
    p_expected_original_meta: isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {},
    p_final_original_meta: finalOriginalMeta,
    p_final_solution_meta: finalSolutionMeta,
    p_payouts: Array.isArray(payouts) ? payouts : [],
    p_usd_jpy_rate: getUsdJpyRate(),
    p_settled_at: nowIso
  });
  if (error) {
    const message = String(error.message || error.details || error.hint || '');
    const migrationMissing = /settle_problem_solution|schema cache|function/i.test(message);
    const conflict = /changed while|not unresolved|not fully verified|not bound/i.test(message);
    const settlementError = new Error(
      migrationMissing
        ? 'Secure problem settlement is not ready. Apply the latest Supabase migration.'
        : (conflict ? 'This problem changed before settlement could complete.' : 'Secure problem settlement failed.')
    );
    settlementError.statusCode = migrationMissing ? 503 : (conflict ? 409 : 502);
    throw settlementError;
  }
  const rows = Array.isArray(data) ? data : [];
  return new Map(rows.map((row) => [safeString(row && row.idempotencyKey), row]));
}

function compactAttachments(meta) {
  return Array.isArray(meta && meta.attachments) ? meta.attachments : [];
}

export async function resolveProblemSolution(req, body) {
  const input = isPlainObject(body) ? body : {};
  const requestedSolveContext = isPlainObject(input.solveContext) ? input.solveContext : {};
  const originalProblemId = safeString(input.originalProblemId || input.problemId || requestedSolveContext.problemId);
  const solutionProblemId = safeString(input.solutionProblemId || input.theoremProblemId || input.savedProblemId);
  const { client: supabase, error } = getSupabaseAdmin();
  if (!supabase) {
    const unavailable = new Error(error || 'Supabase is not configured on this server.');
    unavailable.statusCode = 503;
    throw unavailable;
  }

  const identity = await getIvucxIdentity(req, supabase);
  if (!identity.authenticated) {
    const authError = new Error('Login is required to resolve a problem bounty.');
    authError.statusCode = 401;
    throw authError;
  }

  const [originalProblem, solutionProblem] = await Promise.all([
    loadProblemRow(supabase, originalProblemId, 'originalProblemId'),
    loadProblemRow(supabase, solutionProblemId, 'solutionProblemId')
  ]);
  const solutionProofState = normalizeProofState(solutionProblem.proof_state);
  if (solutionProofState !== 'YY' || safeString(solutionProblem.verification_status).toLowerCase() !== 'verified') {
    const stateError = new Error('Only fully verified theorem rows can resolve a problem.');
    stateError.statusCode = 409;
    throw stateError;
  }

  const originalMeta = isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {};
  const solutionMeta = isPlainObject(solutionProblem.request_meta) ? solutionProblem.request_meta : {};
  if (!identityOwnsProblem(identity, solutionMeta)) {
    const ownershipError = new Error('Only the account that submitted this verified solution can claim the bounty.');
    ownershipError.statusCode = 403;
    throw ownershipError;
  }
  const solveContext = isPlainObject(solutionMeta.solveContext) ? solutionMeta.solveContext : null;
  if (!solveContext || safeString(solveContext.problemId) !== originalProblem.id) {
    const bindingError = new Error('The verified solution is not bound to this problem.');
    bindingError.statusCode = 409;
    throw bindingError;
  }
  assertProblemProofBinding(originalProblem, solutionProblem);
  assertTrustedCicRecord(solutionProblem, { requireAssumptionAudit: true });
  const existingSolution = isPlainObject(originalMeta.solution) ? originalMeta.solution : null;
  const originalProofState = normalizeProofState(originalProblem.proof_state);
  if (
    existingSolution
    && existingSolution.solutionProblemId
    && existingSolution.solutionProblemId !== solutionProblem.id
  ) {
    const solvedError = new Error('This problem is already resolved by another theorem.');
    solvedError.statusCode = 409;
    throw solvedError;
  }
  if (
    originalProofState === 'YY'
    && existingSolution
    && existingSolution.solutionProblemId === solutionProblem.id
    && safeString(existingSolution.status).toLowerCase() === 'solved'
  ) {
    return {
      resolved: true,
      duplicate: true,
      originalProblemId: originalProblem.id,
      solutionProblemId: solutionProblem.id,
      titleAliases: Array.isArray(originalMeta.titleAliases) ? originalMeta.titleAliases : [],
      bountyCredit: isPlainObject(existingSolution.bounty) ? existingSolution.bounty : null,
      conditionalUsageCredits: isPlainObject(existingSolution.bounty) && Array.isArray(existingSolution.bounty.conditionalUsage)
        ? existingSolution.bounty.conditionalUsage
        : [],
      notification: null,
      solution: existingSolution
    };
  }
  if (originalProofState === 'YY' && existingSolution && existingSolution.solutionProblemId === solutionProblem.id) {
    const incompleteError = new Error('This problem has an incomplete legacy settlement and requires recovery before retrying.');
    incompleteError.statusCode = 409;
    throw incompleteError;
  }
  if (originalProofState !== 'NY') {
    const stateError = new Error('Only unresolved problem rows can be resolved.');
    stateError.statusCode = 409;
    throw stateError;
  }
  const nowIso = new Date().toISOString();
  const titleAliases = Array.from(new Set([
    safeString(originalProblem.title),
    safeString(solutionProblem.title),
    ...(Array.isArray(originalMeta.titleAliases) ? originalMeta.titleAliases.map(safeString) : []),
    ...(Array.isArray(solutionMeta.titleAliases) ? solutionMeta.titleAliases.map(safeString) : [])
  ].filter(Boolean)));

  const originalBounty = await verifyStoredProblemBountyForPayout(originalMeta, originalProblem.id);
  const solver = publicIdentity(identity);
  const creator = extractCreatorIdentity(originalMeta);
  const usedConditionals = resolveUsedConditionals(originalMeta, solveContext);
  const originalBountyYen = bountyToYen(originalBounty);
  const conditionalDistribution = planConditionalReturns(originalBountyYen, usedConditionals);
  const totalConditionalYen = conditionalDistribution.totalReturnYen;
  const solverBountyYen = conditionalDistribution.solverYen;
  const solverBounty = originalBounty
    ? {
        ...originalBounty,
        currency: 'jpy',
        amountCents: solverBountyYen,
        conditionalDeductionsYen: totalConditionalYen,
        conditionalDeductionsVx: yenToVx(totalConditionalYen)
      }
    : null;

  const solverPlan = await buildSolverBountyPayout({
    supabase,
    identity,
    originalProblem,
    solutionProblem,
    bounty: solverBounty,
    nowIso
  });
  const conditionalPlan = await buildConditionalUsagePayouts({
    supabase,
    originalProblem,
    solutionProblem,
    distribution: conditionalDistribution,
    nowIso
  });
  const payoutList = [solverPlan.payout, ...conditionalPlan.payouts].filter(Boolean);
  const bountyCreditPreview = solverPlan.credit;
  const conditionalCreditsPreview = conditionalPlan.credits;

  const solutionSnapshot = {
    status: 'solved',
    originalProblemId: originalProblem.id,
    solutionProblemId: solutionProblem.id,
    problemTitle: originalProblem.title || safeString(solveContext.title),
    theoremTitle: solutionProblem.title || safeString(input.theoremTitle),
    solvedAt: existingSolution && existingSolution.solvedAt ? existingSolution.solvedAt : nowIso,
    solver,
    creator,
    titleAliases,
    originalBounty,
    bounty: {
      amountCents: 0,
      currency: originalBounty ? originalBounty.currency : 'jpy',
      status: 'awarded',
      awardedAt: nowIso,
      awardedYen: bountyCreditPreview.amountYen || 0,
      awardedVx: bountyCreditPreview.amountVx || 0,
      originalYen: originalBountyYen,
      fundingModel: CONDITIONAL_FUNDING_MODEL,
      solverPercent: Math.max(0, 100 - conditionalDistribution.totalSharePercent),
      conditionalDeductionPercent: conditionalDistribution.totalSharePercent,
      conditionalSharePpm: conditionalDistribution.totalSharePpm,
      conditionalDeductionsYen: totalConditionalYen,
      conditionalDeductionsVx: yenToVx(totalConditionalYen),
      conditionalUsage: conditionalCreditsPreview
    },
    sourceCode: solutionProblem.source_code || '',
    fileName: solutionProblem.file_name || '',
    language: solutionProblem.language || '',
    attachments: compactAttachments(solutionMeta),
    problem: {
      sourceCode: originalProblem.source_code || '',
      fileName: originalProblem.file_name || '',
      language: originalProblem.language || '',
      attachments: compactAttachments(originalMeta)
    }
  };

  const finalOriginalMeta = {
    ...originalMeta,
    problemKind: 'theorem',
    postKind: 'theorem',
    solved: true,
    titleAliases,
    originalBounty: originalBounty || originalMeta.originalBounty || null,
    bounty: solutionSnapshot.bounty,
    solution: solutionSnapshot
  };
  const finalSolutionMeta = {
    ...solutionMeta,
    problemKind: 'theorem',
    postKind: 'theorem',
    titleAliases,
    solutionOf: {
      problemId: originalProblem.id,
      problemTitle: originalProblem.title || '',
      solvedAt: solutionSnapshot.solvedAt,
      bountyCredit: bountyCreditPreview
    },
    solveContext
  };
  const settlementByKey = await settleProblemSolutionAtomic({
    supabase,
    originalProblem,
    solutionProblem,
    finalOriginalMeta,
    finalSolutionMeta,
    payouts: payoutList,
    nowIso
  });
  const bountyCredit = mergeSettlementCredit(bountyCreditPreview, settlementByKey);
  const conditionalUsageCredits = conditionalCreditsPreview.map((credit) => (
    mergeSettlementCredit(credit, settlementByKey)
  ));

  let notification;
  try {
    notification = await notifyProblemCreator({
      supabase,
      creator,
      solver: identity,
      originalProblem,
      solutionProblem,
      bountyCredit,
      nowIso
    });
  } catch (notificationError) {
    console.error('problem resolution notification failed', {
      problemId: originalProblem.id,
      solutionProblemId: solutionProblem.id,
      error: notificationError && notificationError.message
        ? notificationError.message
        : String(notificationError)
    });
    notification = { notified: false, reason: 'notification_failed' };
  }

  return {
    resolved: true,
    originalProblemId: originalProblem.id,
    solutionProblemId: solutionProblem.id,
    titleAliases,
    bountyCredit,
    conditionalUsageCredits,
    notification,
    solution: solutionSnapshot
  };
}

async function registerProblemConditionalAtomic({
  supabase,
  originalProblem,
  conditionalProblem,
  finalOriginalMeta,
  finalConditionalMeta
}) {
  const { data, error } = await supabase.rpc('register_problem_conditional', {
    p_original_problem_id: originalProblem.id,
    p_conditional_problem_id: conditionalProblem.id,
    p_expected_original_meta: isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {},
    p_expected_conditional_meta: isPlainObject(conditionalProblem.request_meta) ? conditionalProblem.request_meta : {},
    p_final_original_meta: finalOriginalMeta,
    p_final_conditional_meta: finalConditionalMeta,
    p_usd_jpy_rate: getUsdJpyRate()
  });
  if (error) {
    const message = String(error.message || error.details || error.hint || '');
    const migrationMissing = /register_problem_conditional|schema cache|function/i.test(message);
    const conflict = /changed while|not unresolved|not funded|invalid|exceed|session claim|bound/i.test(message);
    const registrationError = new Error(
      migrationMissing
        ? 'Secure Conditional registration is not ready. Apply the latest Supabase migration.'
        : (conflict ? message : 'Secure Conditional registration failed.')
    );
    registrationError.statusCode = migrationMissing ? 503 : (conflict ? 409 : 502);
    throw registrationError;
  }
  return isPlainObject(data) ? data : { registered: true };
}

export async function registerProblemConditional(req, body) {
  const input = isPlainObject(body) ? body : {};
  const requestedSolveContext = isPlainObject(input.solveContext) ? input.solveContext : {};
  const originalProblemId = safeString(input.originalProblemId || input.problemId || requestedSolveContext.problemId);
  const conditionalProblemId = safeString(input.conditionalProblemId || input.savedProblemId || input.solutionProblemId);
  const { client: supabase, error } = getSupabaseAdmin();
  if (!supabase) {
    const unavailable = new Error(error || 'Supabase is not configured on this server.');
    unavailable.statusCode = 503;
    throw unavailable;
  }
  const identity = await getIvucxIdentity(req, supabase);
  if (!identity.authenticated) {
    const authError = new Error('Login is required to register a Conditional proof.');
    authError.statusCode = 401;
    throw authError;
  }
  const [originalProblem, conditionalProblem] = await Promise.all([
    loadProblemRow(supabase, originalProblemId, 'originalProblemId'),
    loadProblemRow(supabase, conditionalProblemId, 'conditionalProblemId')
  ]);
  if (normalizeProofState(originalProblem.proof_state) !== 'NY') {
    const stateError = new Error('Conditional proofs can be added only to unresolved problems.');
    stateError.statusCode = 409;
    throw stateError;
  }
  const conditionalProofState = normalizeProofState(conditionalProblem.proof_state);
  if (conditionalProofState !== 'NY') {
    const stateError = new Error('Only axiom-backed NY proof rows can be registered as Conditional.');
    stateError.statusCode = 409;
    throw stateError;
  }
  if (!safeString(conditionalProblem.title)) {
    const titleError = new Error('Conditional title is required.');
    titleError.statusCode = 409;
    throw titleError;
  }
  if (!safeString(conditionalProblem.source_code)) {
    const codeError = new Error('Conditional proof code is required.');
    codeError.statusCode = 409;
    throw codeError;
  }

  const originalMeta = isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {};
  const conditionalMeta = isPlainObject(conditionalProblem.request_meta) ? conditionalProblem.request_meta : {};
  if (!identityOwnsProblem(identity, conditionalMeta)) {
    const ownershipError = new Error('Only the account that submitted this Conditional can register it.');
    ownershipError.statusCode = 403;
    throw ownershipError;
  }
  const solveContext = isPlainObject(conditionalMeta.solveContext) ? conditionalMeta.solveContext : null;
  if (!solveContext || safeString(solveContext.problemId) !== originalProblem.id) {
    const bindingError = new Error('The Conditional is not bound to this problem.');
    bindingError.statusCode = 409;
    throw bindingError;
  }
  assertProblemProofBinding(originalProblem, conditionalProblem);
  assertTrustedCicRecord(conditionalProblem, { requireAssumptionAudit: true });
  const existingConditionals = Array.isArray(originalMeta.conditionals)
    ? originalMeta.conditionals.filter((item) => isPlainObject(item))
    : [];
  const duplicateConditional = existingConditionals.find((item) => safeString(item.conditionalProblemId) === conditionalProblem.id);
  if (duplicateConditional) {
    return {
      registered: true,
      duplicate: true,
      originalProblemId: originalProblem.id,
      conditionalProblemId: conditionalProblem.id,
      split: isPlainObject(duplicateConditional.bounty) && isPlainObject(duplicateConditional.bounty.split)
        ? duplicateConditional.bounty.split
        : null,
      updatedBounty: isPlainObject(originalMeta.bounty) ? originalMeta.bounty : null,
      creatorCredit: isPlainObject(duplicateConditional.bounty) && isPlainObject(duplicateConditional.bounty.creatorCredit)
        ? duplicateConditional.bounty.creatorCredit
        : null,
      notification: null,
      conditional: duplicateConditional
    };
  }
  if (compactAttachments(conditionalMeta).length === 0) {
    const attachmentsError = new Error('Conditional attachments are required.');
    attachmentsError.statusCode = 409;
    throw attachmentsError;
  }
  const submitter = publicIdentity(identity);
  const nowIso = new Date().toISOString();
  const storedConditionalBounty = normalizeConditionalBounty(conditionalMeta.conditionalBounty);
  const hasFunding = Boolean(storedConditionalBounty && storedConditionalBounty.stripeSessionId);
  if (!hasFunding && conditionalMeta.conditionalBounty !== null && conditionalMeta.conditionalBounty !== undefined) {
    const paymentError = new Error('Stored Conditional funding is incomplete or invalid.');
    paymentError.statusCode = 409;
    throw paymentError;
  }
  let verifiedConditionalBounty = null;
  let existingBounty = normalizeBounty(originalMeta.bounty);
  let existingBountyYen = bountyToYen(existingBounty);
  let shareSnapshot = null;
  if (hasFunding) {
    verifiedConditionalBounty = normalizeConditionalBounty(await verifyConditionalCheckoutSession(
      storedConditionalBounty,
      { identity, problemId: originalProblem.id }
    ));
    if (!verifiedConditionalBounty || verifiedConditionalBounty.amountYen !== storedConditionalBounty.amountYen) {
      const paymentError = new Error('Stored Conditional funding does not match Stripe.');
      paymentError.statusCode = 409;
      throw paymentError;
    }
    existingBounty = await verifyStoredProblemBountyForPayout(originalMeta, originalProblem.id);
    existingBountyYen = bountyToYen(existingBounty);
    if (existingBountyYen <= 0) {
      const bountyError = new Error('The unresolved problem has no verified bounty for a fixed return ratio.');
      bountyError.statusCode = 409;
      throw bountyError;
    }
    shareSnapshot = createConditionalShareSnapshot({
      contributionYen: verifiedConditionalBounty.amountYen,
      existingBountyYen,
      existingConditionals
    });
  }
  const withoutDuplicate = existingConditionals.filter((item) => safeString(item.conditionalProblemId) !== conditionalProblem.id);
  const titleAliases = Array.from(new Set([
    safeString(originalProblem.title),
    safeString(conditionalProblem.title),
    ...(Array.isArray(originalMeta.titleAliases) ? originalMeta.titleAliases.map(safeString) : []),
    ...(Array.isArray(conditionalMeta.titleAliases) ? conditionalMeta.titleAliases.map(safeString) : [])
  ].filter(Boolean)));
  const conditionalSnapshot = {
    status: 'conditional',
    originalProblemId: originalProblem.id,
    conditionalProblemId: conditionalProblem.id,
    problemTitle: originalProblem.title || safeString(solveContext.title),
    conditionalTitle: conditionalProblem.title || safeString(input.conditionalTitle),
    postedAt: nowIso,
    submitter,
    titleAliases,
    payment: hasFunding
      ? {
          required: true,
          status: 'paid',
          stripeSessionId: verifiedConditionalBounty.stripeSessionId
        }
      : { required: false },
    ...(hasFunding
      ? {
          bounty: {
            ...verifiedConditionalBounty,
            ...shareSnapshot,
            amountYen: verifiedConditionalBounty.amountYen,
            amountVx: yenToVx(verifiedConditionalBounty.amountYen),
            currency: 'jpy',
            status: 'funded',
            paymentStatus: 'paid',
            serverVerified: true,
            updatedAt: nowIso
          }
        }
      : {}),
    sourceCode: conditionalProblem.source_code || '',
    fileName: conditionalProblem.file_name || '',
    language: conditionalProblem.language || '',
    attachments: compactAttachments(conditionalMeta)
  };

  const finalOriginalMeta = {
    ...originalMeta,
    problemKind: 'problem',
    postKind: 'problem',
    titleAliases,
    conditionals: [conditionalSnapshot, ...withoutDuplicate].slice(0, 50)
  };
  const finalConditionalMeta = {
    ...conditionalMeta,
    problemKind: 'conditional',
    postKind: 'conditional',
    conditionalBounty: hasFunding ? conditionalSnapshot.bounty : null,
    titleAliases,
    conditionalOf: {
      problemId: originalProblem.id,
      problemTitle: originalProblem.title || '',
      postedAt: nowIso,
      payment: conditionalSnapshot.payment,
      ...(hasFunding ? { bounty: conditionalSnapshot.bounty } : {})
    },
    solveContext
  };
  await registerProblemConditionalAtomic({
    supabase,
    originalProblem,
    conditionalProblem,
    finalOriginalMeta,
    finalConditionalMeta
  });
  const updatedBounty = hasFunding
    ? {
        ...existingBounty,
        amountCents: existingBountyYen + verifiedConditionalBounty.amountYen,
        currency: 'jpy',
        conditionalContributions: [
          ...(Array.isArray(existingBounty && existingBounty.conditionalContributions)
            ? existingBounty.conditionalContributions
            : []),
          {
            conditionalProblemId: conditionalProblem.id,
            amountYen: verifiedConditionalBounty.amountYen,
            fixedSharePpm: shareSnapshot.fixedSharePpm
          }
        ]
      }
    : existingBounty;

  return {
    registered: true,
    originalProblemId: originalProblem.id,
    conditionalProblemId: conditionalProblem.id,
    split: hasFunding
      ? {
          feeYen: 0,
          problemBountyYen: verifiedConditionalBounty.amountYen,
          creatorYen: 0,
          fundingModel: CONDITIONAL_FUNDING_MODEL
        }
      : null,
    updatedBounty,
    creatorCredit: null,
    notification: null,
    conditional: conditionalSnapshot
  };
}

export async function sendProblemSolutionResolveResponse(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await assertDistributedRateLimit(req, {
      route: 'problem-solution-settle',
      limit: 10,
      windowSeconds: 60
    });
    const result = await resolveProblemSolution(req, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = getHttpErrorStatus(error);
    res.status(status).json({
      ok: false,
      error: getPublicErrorMessage(error, 'Problem resolution failed.', status)
    });
  }
}

export async function sendProblemConditionalRegisterResponse(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    await assertDistributedRateLimit(req, {
      route: 'problem-conditional-register',
      limit: 10,
      windowSeconds: 60
    });
    const result = await registerProblemConditional(req, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const status = getHttpErrorStatus(error);
    res.status(status).json({
      ok: false,
      error: getPublicErrorMessage(error, 'Conditional proof registration failed.', status)
    });
  }
}
