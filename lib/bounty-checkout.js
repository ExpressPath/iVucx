import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import { getIvucxIdentity } from './ivucx.js';
import { getStripeClient, getStripeRedirectBaseUrl } from './stripe-server.js';
import { getSupabaseAdmin } from './supabase-admin.js';

const DEFAULT_CURRENCY = 'usd';
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 1000000;

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function clampAmountCents(value) {
  const amount = Math.round(Number(value) || 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.min(amount, MAX_AMOUNT_CENTS));
}

function normalizeCurrency(value) {
  const text = safeString(value, DEFAULT_CURRENCY).toLowerCase();
  return /^[a-z]{3}$/.test(text) ? text : DEFAULT_CURRENCY;
}

function normalizeProofState(value) {
  const text = safeString(value).toUpperCase();
  return ['NY', 'YY', 'YN', 'NN'].includes(text) ? text : '';
}

function formatTitle(value) {
  return safeString(value, 'Untitled problem').slice(0, 120);
}

async function getRequestIdentityMetadata(req) {
  const { client } = getSupabaseAdmin();
  const identity = await getIvucxIdentity(req, client);
  if (identity && identity.authenticated && identity.accountProvider && identity.accountIdHash) {
    return {
      accountProvider: identity.accountProvider,
      accountIdHash: identity.accountIdHash
    };
  }
  const error = new Error('Login is required before funding a bounty.');
  error.statusCode = 401;
  throw error;
}

async function createBountyCheckout(req, res) {
  const body = req.body || {};
  const amountCents = clampAmountCents(body.amountCents);
  if (amountCents < MIN_AMOUNT_CENTS) {
    res.status(400).json({ error: 'Bounty amount is too small.' });
    return;
  }

  const baseUrl = getStripeRedirectBaseUrl(req);
  const title = formatTitle(body.title);
  const currency = normalizeCurrency(body.currency);
  const problemKind = safeString(body.problemKind, 'problem');
  const proofState = normalizeProofState(body.proofState || body.proof_state);
  const language = safeString(body.language);
  const fileName = safeString(body.fileName);

  if (problemKind !== 'problem') {
    res.status(400).json({ error: 'Bounties can be added to problem posts only.' });
    return;
  }

  if (proofState !== 'NY') {
    res.status(400).json({ error: 'Bounties can be funded only for unsolved propositions.' });
    return;
  }

  const stripe = getStripeClient();
  const identityMetadata = await getRequestIdentityMetadata(req);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: safeString(body.clientReferenceId),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: `PROVF bounty: ${title}`,
            description: 'Bounty attached to a PROVF problem post.'
          }
        }
      }
    ],
    metadata: {
      type: 'provf_bounty',
      title,
      problemKind,
      proofState,
      language,
      fileName,
      amountCents: String(amountCents),
      ...identityMetadata
    },
    success_url: `${baseUrl}/post-preview.html?bounty=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/post-preview.html?bounty=cancelled`
  });

  res.status(200).json({
    url: session.url,
    sessionId: session.id,
    amountCents,
    currency
  });
}

async function readBountyCheckout(req, res) {
  const sessionId = safeString(req.query && req.query.session_id);
  if (!sessionId) {
    res.status(400).json({ error: 'Missing session_id.' });
    return;
  }
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const { client } = getSupabaseAdmin();
  const identity = await getIvucxIdentity(req, client);
  const metadata = session.metadata || {};
  if (!identity.authenticated) {
    res.status(401).json({ error: 'Login is required.' });
    return;
  }
  if (
    safeString(metadata.accountProvider) !== safeString(identity.accountProvider)
    || safeString(metadata.accountIdHash) !== safeString(identity.accountIdHash)
  ) {
    res.status(403).json({ error: 'Stripe Checkout Session belongs to another account.' });
    return;
  }
  res.status(200).json({
    sessionId: session.id,
    status: session.status,
    paymentStatus: session.payment_status,
    paid: session.payment_status === 'paid',
    amountTotal: session.amount_total || 0,
    currency: session.currency || DEFAULT_CURRENCY,
    metadata
  });
}

export async function sendBountyCheckoutResponse(req, res) {
  try {
    await assertDistributedRateLimit(req, {
      route: req.method === 'POST' ? 'stripe-bounty-create' : 'stripe-bounty-read',
      limit: req.method === 'POST' ? 10 : 60,
      windowSeconds: 60
    });
    if (req.method === 'POST') {
      await createBountyCheckout(req, res);
      return;
    }
    if (req.method === 'GET') {
      await readBountyCheckout(req, res);
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    const status = getHttpErrorStatus(error);
    res.status(status).json({
      error: getPublicErrorMessage(error, 'Bounty checkout failed.', status)
    });
  }
}
