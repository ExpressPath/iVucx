import { createHash } from 'crypto';

import { hashSessionToken, readSessionFromRequest } from './blue-auth.js';
import { getGoogleIdentity } from './google-oauth.js';
import { getSupabaseAdmin } from './supabase-admin.js';

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

function getYenPerVx() {
  const value = Number(process.env.IVUCX_YEN_PER_VX || DEFAULT_YEN_PER_VX);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_YEN_PER_VX;
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
    const accountId = safeString(google.accountId || google.email || google.name, 'Google account');
    return {
      authenticated: true,
      accountProvider: 'google',
      accountId,
      accountIdHash: hashIdentifier(`google:${accountId}`),
      email: safeString(google.email),
      name: safeString(google.name)
    };
  }

  const blue = await getBlueSessionIdentity(req, supabase);
  if (blue && blue.authenticated) {
    return {
      ...blue,
      accountIdHash: getIdentityHash(blue)
    };
  }

  return {
    authenticated: false,
    accountProvider: '',
    accountId: '',
    accountIdHash: '',
    email: '',
    name: ''
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
  const { data, error } = await supabase
    .from('ivucx_notifications')
    .select('id,type,title,message,problem_id,solution_problem_id,meta,read_at,created_at')
    .eq('account_provider', identity.accountProvider)
    .eq('account_id_hash', identity.accountIdHash || getIdentityHash(identity))
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(Number(limit) || 6, 12)));
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(normalizeNotification);
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
      rewards: [],
      unavailable: true,
      error
    };
  }

  try {
    const account = await ensureIvucxAccount(supabase, identity);
    const notifications = await listNotifications(supabase, identity);
    return {
      loggedIn: true,
      identity,
      balance: normalizeAccountRow(account),
      notifications,
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
    .select('id,title,language,file_name,source_code,proof_state,request_meta,created_at,updated_at')
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

async function creditSolverBounty({ supabase, identity, originalProblem, solutionProblem, bounty, nowIso }) {
  const amountYen = bountyToYen(bounty);
  const amountVx = yenToVx(amountYen);
  const idempotencyKey = `problem-solution:${originalProblem.id}:${solutionProblem.id}`;
  if (amountYen <= 0 || amountVx <= 0) {
    return {
      credited: false,
      amountYen: 0,
      amountVx: 0,
      idempotencyKey,
      reason: 'no_bounty'
    };
  }

  const existing = await supabase
    .from('ivucx_transactions')
    .select('id,amount_vx,amount_yen')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (isMissingRelationError(existing.error, 'ivucx_transactions')) {
    return {
      credited: true,
      fallback: 'problems-request-meta',
      amountYen,
      amountVx,
      idempotencyKey,
      balance: null
    };
  }
  if (!existing.error && existing.data && existing.data.id) {
    return {
      credited: false,
      duplicate: true,
      amountYen: Number(existing.data.amount_yen) || amountYen,
      amountVx: Number(existing.data.amount_vx) || amountVx,
      idempotencyKey
    };
  }
  if (existing.error) throw existing.error;

  let account;
  try {
    account = await ensureIvucxAccount(supabase, identity);
  } catch (err) {
    if (isMissingRelationError(err, 'ivucx_accounts')) {
      return {
        credited: true,
        fallback: 'problems-request-meta',
        amountYen,
        amountVx,
        idempotencyKey,
        balance: null
      };
    }
    throw err;
  }
  const nextYen = Math.max(0, Math.round(Number(account.balance_yen) || 0)) + amountYen;
  const nextVx = toFixedVx(toFixedVx(Number(account.balance_vx) || 0) + amountVx);

  const transaction = await supabase.from('ivucx_transactions').insert({
    account_provider: identity.accountProvider,
    account_id: identity.accountId,
    account_id_hash: identity.accountIdHash || getIdentityHash(identity),
    direction: 'credit',
    amount_vx: amountVx,
    amount_yen: amountYen,
    currency: 'jpy',
    reason: 'problem_bounty_award',
    idempotency_key: idempotencyKey,
    problem_id: originalProblem.id,
    solution_problem_id: solutionProblem.id,
    bounty: normalizeBounty(bounty),
    meta: {
      problemTitle: originalProblem.title || '',
      theoremTitle: solutionProblem.title || '',
      yenPerVx: getYenPerVx(),
      usdJpyRate: getUsdJpyRate()
    },
    created_at: nowIso
  });
  if (isMissingRelationError(transaction.error, 'ivucx_transactions')) {
    return {
      credited: true,
      fallback: 'problems-request-meta',
      amountYen,
      amountVx,
      idempotencyKey,
      balance: null
    };
  }
  if (transaction.error) throw transaction.error;

  const updated = await supabase
    .from('ivucx_accounts')
    .update({
      balance_vx: nextVx,
      balance_yen: nextYen,
      updated_at: nowIso
    })
    .eq('account_provider', identity.accountProvider)
    .eq('account_id_hash', identity.accountIdHash || getIdentityHash(identity));
  if (updated.error) throw updated.error;

  return {
    credited: true,
    amountYen,
    amountVx,
    idempotencyKey,
    balance: normalizeAccountRow({ balance_vx: nextVx, balance_yen: nextYen })
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

function splitConditionalYen(amountYen) {
  const total = Math.max(0, Math.round(Number(amountYen) || 0));
  const feeYen = Math.round(total * 0.10);
  const problemBountyYen = Math.round(total * 0.45);
  const creatorYen = Math.max(0, total - feeYen - problemBountyYen);
  return {
    feeYen,
    problemBountyYen,
    creatorYen
  };
}

function normalizeConditionalBounty(value) {
  if (!isPlainObject(value)) return null;
  const currency = safeString(value.currency, 'jpy').toLowerCase();
  let amountYen = Math.max(0, Math.round(Number(value.amountYen || value.amountTotal || 0) || 0));
  if (!amountYen && currency === 'jpy') {
    amountYen = Math.max(0, Math.round(Number(value.amountCents || value.amount || 0) || 0));
  }
  if (!amountYen && currency === 'usd') {
    amountYen = Math.max(0, Math.round((Number(value.amountCents || value.amount || 0) / 100) * getUsdJpyRate()));
  }
  const amountVx = toFixedVx(Number(value.amountVx) || yenToVx(amountYen));
  if (amountYen <= 0 || amountVx <= 0) return null;
  const rawSplit = isPlainObject(value.split) ? value.split : {};
  const split = {
    ...splitConditionalYen(amountYen),
    feeYen: Math.max(0, Math.round(Number(rawSplit.feeYen || value.feeYen) || splitConditionalYen(amountYen).feeYen)),
    problemBountyYen: Math.max(0, Math.round(Number(rawSplit.problemBountyYen || value.problemBountyYen) || splitConditionalYen(amountYen).problemBountyYen)),
    creatorYen: Math.max(0, Math.round(Number(rawSplit.creatorYen || value.creatorYen) || splitConditionalYen(amountYen).creatorYen))
  };
  return {
    amountYen,
    amountVx,
    currency: currency === 'jpy' || currency === 'usd' ? currency : 'jpy',
    status: safeString(value.status),
    paymentStatus: safeString(value.paymentStatus || value.payment_status || value.stripePaymentStatus),
    stripeSessionId: safeString(value.stripeSessionId || value.sessionId),
    yenPerVx: getYenPerVx(),
    split,
    updatedAt: safeString(value.updatedAt)
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

  const existing = await supabase
    .from('ivucx_transactions')
    .select('id,amount_vx,amount_yen')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (isMissingRelationError(existing.error, 'ivucx_transactions')) {
    return {
      credited: true,
      fallback: 'problems-request-meta',
      amountYen,
      amountVx,
      idempotencyKey,
      balance: null
    };
  }
  if (!existing.error && existing.data && existing.data.id) {
    return {
      credited: false,
      duplicate: true,
      amountYen: Number(existing.data.amount_yen) || amountYen,
      amountVx: Number(existing.data.amount_vx) || amountVx,
      idempotencyKey
    };
  }
  if (existing.error) throw existing.error;

  let account;
  try {
    account = await ensureIvucxAccount(supabase, creator);
  } catch (err) {
    if (isMissingRelationError(err, 'ivucx_accounts')) {
      return {
        credited: true,
        fallback: 'problems-request-meta',
        amountYen,
        amountVx,
        idempotencyKey,
        balance: null
      };
    }
    throw err;
  }

  const nextYen = Math.max(0, Math.round(Number(account.balance_yen) || 0)) + amountYen;
  const nextVx = toFixedVx(toFixedVx(Number(account.balance_vx) || 0) + amountVx);
  const transaction = await supabase.from('ivucx_transactions').insert({
    account_provider: creator.accountProvider,
    account_id: creator.accountId,
    account_id_hash: creator.accountIdHash,
    direction: 'credit',
    amount_vx: amountVx,
    amount_yen: amountYen,
    currency: 'jpy',
    reason: 'conditional_creator_share',
    idempotency_key: idempotencyKey,
    problem_id: originalProblem.id,
    solution_problem_id: conditionalProblem.id,
    bounty: normalized,
    meta: {
      problemTitle: originalProblem.title || '',
      conditionalTitle: conditionalProblem.title || '',
      split: normalized.split,
      yenPerVx: getYenPerVx()
    },
    created_at: nowIso
  });
  if (isMissingRelationError(transaction.error, 'ivucx_transactions')) {
    return {
      credited: true,
      fallback: 'problems-request-meta',
      amountYen,
      amountVx,
      idempotencyKey,
      balance: null
    };
  }
  if (transaction.error) throw transaction.error;

  const updated = await supabase
    .from('ivucx_accounts')
    .update({
      balance_vx: nextVx,
      balance_yen: nextYen,
      updated_at: nowIso
    })
    .eq('account_provider', creator.accountProvider)
    .eq('account_id_hash', creator.accountIdHash);
  if (updated.error) throw updated.error;

  return {
    credited: true,
    amountYen,
    amountVx,
    idempotencyKey,
    balance: normalizeAccountRow({ balance_vx: nextVx, balance_yen: nextYen })
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
  const selectedTitles = new Set(selected.map((item) => safeString(item.conditionalTitle).toLowerCase()).filter(Boolean));
  const used = [];
  const seen = new Set();
  for (const conditional of stored) {
    const id = safeString(conditional.conditionalProblemId);
    const title = safeString(conditional.conditionalTitle).toLowerCase();
    if (!(id && selectedIds.has(id)) && !(title && selectedTitles.has(title))) continue;
    const key = id || title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    used.push(conditional);
  }
  return used.slice(0, 20);
}

async function creditConditionalUsageShares({ supabase, originalProblem, solutionProblem, usedConditionals, shareYen, nowIso }) {
  const conditionals = Array.isArray(usedConditionals) ? usedConditionals : [];
  const amountYen = Math.max(0, Math.round(Number(shareYen) || 0));
  const amountVx = yenToVx(amountYen);
  const credits = [];
  if (amountYen <= 0 || amountVx <= 0) return credits;

  for (const conditional of conditionals) {
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
      credits.push({ ...baseCredit, credited: false, reason: 'missing_conditional_creator' });
      continue;
    }

    const existing = await supabase
      .from('ivucx_transactions')
      .select('id,amount_vx,amount_yen')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (isMissingRelationError(existing.error, 'ivucx_transactions')) {
      credits.push({ ...baseCredit, credited: true, fallback: 'problems-request-meta' });
      continue;
    }
    if (!existing.error && existing.data && existing.data.id) {
      credits.push({
        ...baseCredit,
        credited: false,
        duplicate: true,
        amountYen: Number(existing.data.amount_yen) || amountYen,
        amountVx: Number(existing.data.amount_vx) || amountVx
      });
      continue;
    }
    if (existing.error) throw existing.error;

    let account;
    try {
      account = await ensureIvucxAccount(supabase, recipient);
    } catch (err) {
      if (isMissingRelationError(err, 'ivucx_accounts')) {
        credits.push({ ...baseCredit, credited: true, fallback: 'problems-request-meta' });
        continue;
      }
      throw err;
    }
    const nextYen = Math.max(0, Math.round(Number(account.balance_yen) || 0)) + amountYen;
    const nextVx = toFixedVx(toFixedVx(Number(account.balance_vx) || 0) + amountVx);
    const transaction = await supabase.from('ivucx_transactions').insert({
      account_provider: recipient.accountProvider,
      account_id: recipient.accountId,
      account_id_hash: recipient.accountIdHash,
      direction: 'credit',
      amount_vx: amountVx,
      amount_yen: amountYen,
      currency: 'jpy',
      reason: 'conditional_usage_award',
      idempotency_key: idempotencyKey,
      problem_id: originalProblem.id,
      solution_problem_id: solutionProblem.id,
      bounty: null,
      meta: {
        problemTitle: originalProblem.title || '',
        theoremTitle: solutionProblem.title || '',
        conditionalTitle: safeString(conditional.conditionalTitle, 'Conditional'),
        conditionalProblemId: safeString(conditional.conditionalProblemId),
        sharePercent: 5,
        yenPerVx: getYenPerVx()
      },
      created_at: nowIso
    });
    if (isMissingRelationError(transaction.error, 'ivucx_transactions')) {
      credits.push({ ...baseCredit, credited: true, fallback: 'problems-request-meta' });
      continue;
    }
    if (transaction.error) throw transaction.error;

    const updated = await supabase
      .from('ivucx_accounts')
      .update({
        balance_vx: nextVx,
        balance_yen: nextYen,
        updated_at: nowIso
      })
      .eq('account_provider', recipient.accountProvider)
      .eq('account_id_hash', recipient.accountIdHash);
    if (updated.error) throw updated.error;

    credits.push({
      ...baseCredit,
      credited: true,
      balance: normalizeAccountRow({ balance_vx: nextVx, balance_yen: nextYen })
    });
  }
  return credits;
}

function compactAttachments(meta) {
  return Array.isArray(meta && meta.attachments) ? meta.attachments : [];
}

export async function resolveProblemSolution(req, body) {
  const input = isPlainObject(body) ? body : {};
  const solveContext = isPlainObject(input.solveContext) ? input.solveContext : {};
  const originalProblemId = safeString(input.originalProblemId || input.problemId || solveContext.problemId);
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

  const originalProblem = await loadProblemRow(supabase, originalProblemId, 'originalProblemId');
  const solutionProblem = await loadProblemRow(supabase, solutionProblemId, 'solutionProblemId');
  const solutionProofState = normalizeProofState(solutionProblem.proof_state);
  if (solutionProofState !== 'YY') {
    const stateError = new Error('Only fully verified theorem rows can resolve a problem.');
    stateError.statusCode = 409;
    throw stateError;
  }

  const originalMeta = isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {};
  const solutionMeta = isPlainObject(solutionProblem.request_meta) ? solutionProblem.request_meta : {};
  const existingSolution = isPlainObject(originalMeta.solution) ? originalMeta.solution : null;
  if (
    existingSolution
    && existingSolution.solutionProblemId
    && existingSolution.solutionProblemId !== solutionProblem.id
  ) {
    const solvedError = new Error('This problem is already resolved by another theorem.');
    solvedError.statusCode = 409;
    throw solvedError;
  }
  const nowIso = new Date().toISOString();
  const titleAliases = Array.from(new Set([
    safeString(originalProblem.title),
    safeString(solutionProblem.title),
    ...(Array.isArray(originalMeta.titleAliases) ? originalMeta.titleAliases.map(safeString) : []),
    ...(Array.isArray(solutionMeta.titleAliases) ? solutionMeta.titleAliases.map(safeString) : [])
  ].filter(Boolean)));

  const originalBounty = normalizeBounty(
    (existingSolution && existingSolution.originalBounty)
      || originalMeta.originalBounty
      || originalMeta.bounty
  );
  const solver = publicIdentity(identity);
  const creator = extractCreatorIdentity(originalMeta);
  const usedConditionals = resolveUsedConditionals(originalMeta, solveContext);
  const originalBountyYen = bountyToYen(originalBounty);
  const conditionalShareYen = usedConditionals.length > 0
    ? Math.round(originalBountyYen * 0.05)
    : 0;
  const totalConditionalYen = Math.min(originalBountyYen, conditionalShareYen * usedConditionals.length);
  const solverBountyYen = Math.max(0, originalBountyYen - totalConditionalYen);
  const solverBounty = originalBounty
    ? {
        ...originalBounty,
        currency: 'jpy',
        amountCents: solverBountyYen,
        conditionalDeductionsYen: totalConditionalYen,
        conditionalDeductionsVx: yenToVx(totalConditionalYen)
      }
    : null;
  const bountyCredit = await creditSolverBounty({
    supabase,
    identity,
    originalProblem,
    solutionProblem,
    bounty: solverBounty,
    nowIso
  });
  const conditionalUsageCredits = await creditConditionalUsageShares({
    supabase,
    originalProblem,
    solutionProblem,
    usedConditionals,
    shareYen: conditionalShareYen,
    nowIso
  });

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
      awardedYen: bountyCredit.amountYen || 0,
      awardedVx: bountyCredit.amountVx || 0,
      originalYen: originalBountyYen,
      solverPercent: Math.max(0, 100 - usedConditionals.length * 5),
      conditionalDeductionPercent: usedConditionals.length * 5,
      conditionalDeductionsYen: totalConditionalYen,
      conditionalDeductionsVx: yenToVx(totalConditionalYen),
      conditionalUsage: conditionalUsageCredits
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

  const originalUpdate = await supabase
    .from('problems')
    .update({
      proof_state: 'YY',
      request_meta: {
        ...originalMeta,
        problemKind: 'theorem',
        postKind: 'theorem',
        solved: true,
        titleAliases,
        originalBounty: originalBounty || originalMeta.originalBounty || null,
        bounty: solutionSnapshot.bounty,
        solution: solutionSnapshot
      }
    })
    .eq('id', originalProblem.id)
    .select('id')
    .single();
  if (originalUpdate.error) throw originalUpdate.error;

  const solutionUpdate = await supabase
    .from('problems')
    .update({
      request_meta: {
        ...solutionMeta,
        problemKind: 'theorem',
        postKind: 'theorem',
        titleAliases,
        solutionOf: {
          problemId: originalProblem.id,
          problemTitle: originalProblem.title || '',
          solvedAt: solutionSnapshot.solvedAt,
          bountyCredit
        },
        solveContext
      }
    })
    .eq('id', solutionProblem.id)
    .select('id')
    .single();
  if (solutionUpdate.error) throw solutionUpdate.error;

  const notification = await notifyProblemCreator({
    supabase,
    creator,
    solver: identity,
    originalProblem,
    solutionProblem,
    bountyCredit,
    nowIso
  });

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

export async function registerProblemConditional(req, body) {
  const input = isPlainObject(body) ? body : {};
  const solveContext = isPlainObject(input.solveContext) ? input.solveContext : {};
  const originalProblemId = safeString(input.originalProblemId || input.problemId || solveContext.problemId);
  const conditionalProblemId = safeString(input.conditionalProblemId || input.savedProblemId || input.solutionProblemId);
  const conditionalBounty = normalizeConditionalBounty(input.conditionalBounty || input.bounty);
  const { client: supabase, error } = getSupabaseAdmin();
  if (!supabase) {
    const unavailable = new Error(error || 'Supabase is not configured on this server.');
    unavailable.statusCode = 503;
    throw unavailable;
  }
  if (!conditionalBounty) {
    const bountyError = new Error('A paid Conditional bounty of at least Vx 1 is required.');
    bountyError.statusCode = 400;
    throw bountyError;
  }
  if (conditionalBounty.amountVx < 1) {
    const minError = new Error('Conditional bounty must be at least Vx 1.');
    minError.statusCode = 400;
    throw minError;
  }

  const identity = await getIvucxIdentity(req, supabase);
  const originalProblem = await loadProblemRow(supabase, originalProblemId, 'originalProblemId');
  const conditionalProblem = await loadProblemRow(supabase, conditionalProblemId, 'conditionalProblemId');
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
  if (compactAttachments(conditionalMeta).length === 0) {
    const attachmentsError = new Error('Conditional attachments are required.');
    attachmentsError.statusCode = 409;
    throw attachmentsError;
  }
  const creator = extractCreatorIdentity(originalMeta);
  const submitter = publicIdentity(identity);
  const nowIso = new Date().toISOString();
  const creatorCredit = await creditConditionalCreatorShare({
    supabase,
    creator,
    originalProblem,
    conditionalProblem,
    conditionalBounty,
    nowIso
  });

  const split = conditionalBounty.split || splitConditionalYen(conditionalBounty.amountYen);
  const existingBounty = normalizeBounty(originalMeta.bounty);
  const existingBountyYen = bountyToYen(existingBounty);
  const updatedBountyYen = Math.max(0, existingBountyYen + split.problemBountyYen);
  const updatedBounty = {
    amountCents: updatedBountyYen,
    currency: 'jpy',
    status: 'funded',
    paymentStatus: 'paid',
    stripeSessionId: safeString(existingBounty && existingBounty.stripeSessionId),
    updatedAt: nowIso,
    conditionalAddedYen: split.problemBountyYen,
    conditionalAddedVx: yenToVx(split.problemBountyYen)
  };
  const existingConditionals = Array.isArray(originalMeta.conditionals)
    ? originalMeta.conditionals.filter((item) => isPlainObject(item))
    : [];
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
    creator,
    titleAliases,
    bounty: {
      ...conditionalBounty,
      status: 'distributed',
      distributedAt: nowIso,
      split,
      creatorCredit,
      problemBountyAfterYen: updatedBountyYen,
      problemBountyAfterVx: yenToVx(updatedBountyYen)
    },
    sourceCode: conditionalProblem.source_code || '',
    fileName: conditionalProblem.file_name || '',
    language: conditionalProblem.language || '',
    attachments: compactAttachments(conditionalMeta)
  };

  const originalUpdate = await supabase
    .from('problems')
    .update({
      request_meta: {
        ...originalMeta,
        problemKind: 'problem',
        postKind: 'problem',
        titleAliases,
        bounty: updatedBounty,
        originalBountyBeforeConditional: originalMeta.originalBountyBeforeConditional || existingBounty || null,
        conditionals: [conditionalSnapshot, ...withoutDuplicate].slice(0, 50)
      }
    })
    .eq('id', originalProblem.id)
    .select('id')
    .single();
  if (originalUpdate.error) throw originalUpdate.error;

  const conditionalUpdate = await supabase
    .from('problems')
    .update({
      request_meta: {
        ...conditionalMeta,
        problemKind: 'conditional',
        postKind: 'conditional',
        titleAliases,
        conditionalOf: {
          problemId: originalProblem.id,
          problemTitle: originalProblem.title || '',
          postedAt: nowIso,
          bounty: conditionalSnapshot.bounty
        },
        solveContext
      }
    })
    .eq('id', conditionalProblem.id)
    .select('id')
    .single();
  if (conditionalUpdate.error) throw conditionalUpdate.error;

  const notification = await notifyConditionalCreator({
    supabase,
    creator,
    originalProblem,
    conditionalProblem,
    creatorCredit,
    nowIso
  });

  return {
    registered: true,
    originalProblemId: originalProblem.id,
    conditionalProblemId: conditionalProblem.id,
    split,
    updatedBounty,
    creatorCredit,
    notification,
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
    const result = await resolveProblemSolution(req, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(error.statusCode || error.status || 500).json({
      ok: false,
      error: error && error.message ? error.message : String(error)
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
    const result = await registerProblemConditional(req, req.body || {});
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    res.status(error.statusCode || error.status || 500).json({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}
