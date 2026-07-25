import Stripe from 'stripe';
import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import { getIvucxIdentity } from './ivucx.js';
import { getSupabaseAdmin } from './supabase-admin.js';

const DEFAULT_CURRENCY = 'jpy';
const DEFAULT_YEN_PER_VX = 200;
const MIN_VX = 1;
const MAX_VX = 100000;

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function getStripeSecretKey() {
  return safeString(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY);
}

function getYenPerVx() {
  const value = Number(process.env.IVUCX_YEN_PER_VX || DEFAULT_YEN_PER_VX);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_YEN_PER_VX;
}

function clampVx(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.min(Math.round(amount * 1000000) / 1000000, MAX_VX));
}

function getBaseUrl(req) {
  const configured = safeString(
    process.env.PUBLIC_APP_URL
      || process.env.APP_URL
      || process.env.GOOGLE_PUBLIC_BASE_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  );
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw new Error('PUBLIC_APP_URL must use HTTPS.');
    return parsed.origin;
  }

  if (process.env.NODE_ENV === 'production') {
    const error = new Error('PUBLIC_APP_URL is required for Stripe redirects in production.');
    error.statusCode = 503;
    throw error;
  }

  const proto = safeString(req.headers['x-forwarded-proto'], req.protocol || 'https');
  const host = safeString(req.headers['x-forwarded-host'] || req.headers.host);
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function getStripeClient() {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    const error = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
    error.statusCode = 503;
    throw error;
  }
  return new Stripe(secretKey);
}

function splitConditionalAmount(amountYen) {
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

function normalizeProofState(value) {
  const text = safeString(value).toUpperCase();
  return ['NY', 'YY', 'YN', 'NN'].includes(text) ? text : '';
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
  const error = new Error('Login is required before funding a Conditional bounty.');
  error.statusCode = 401;
  throw error;
}

async function createConditionalCheckout(req, res) {
  const body = req.body || {};
  const amountVx = clampVx(body.amountVx || body.vx || body.conditionalVx);
  if (amountVx < MIN_VX) {
    res.status(400).json({ error: 'Conditional bounty must be at least Vx 1.' });
    return;
  }

  const problemId = safeString(body.problemId || body.originalProblemId);
  if (!problemId) {
    res.status(400).json({ error: 'problemId is required for Conditional checkout.' });
    return;
  }

  const proofState = normalizeProofState(body.proofState || body.proof_state);
  if (proofState !== 'NY') {
    res.status(400).json({ error: 'Conditional checkout is available only for axiom-backed NY proofs.' });
    return;
  }

  const yenPerVx = getYenPerVx();
  const amountYen = Math.max(1, Math.round(amountVx * yenPerVx));
  const split = splitConditionalAmount(amountYen);
  const stripe = getStripeClient();
  const baseUrl = getBaseUrl(req);
  const title = safeString(body.title || body.conditionalTitle, 'Conditional proof').slice(0, 120);
  const problemTitle = safeString(body.problemTitle, 'PROVF problem').slice(0, 120);
  const identityMetadata = await getRequestIdentityMetadata(req);

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: safeString(body.clientReferenceId),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: DEFAULT_CURRENCY,
          unit_amount: amountYen,
          product_data: {
            name: `PROVF Conditional: ${title}`,
            description: `Conditional proof funding for ${problemTitle}.`
          }
        }
      }
    ],
    metadata: {
      type: 'provf_conditional_bounty',
      problemId,
      problemTitle,
      conditionalTitle: title,
      proofState,
      amountVx: String(amountVx),
      amountYen: String(amountYen),
      yenPerVx: String(yenPerVx),
      feeYen: String(split.feeYen),
      problemBountyYen: String(split.problemBountyYen),
      creatorYen: String(split.creatorYen),
      ...identityMetadata
    },
    success_url: `${baseUrl}/post-preview.html?conditional=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/post-preview.html?conditional=cancelled`
  });

  res.status(200).json({
    url: session.url,
    sessionId: session.id,
    amountVx,
    amountYen,
    yenPerVx,
    currency: DEFAULT_CURRENCY,
    split
  });
}

async function readConditionalCheckout(req, res) {
  const sessionId = safeString(req.query && req.query.session_id);
  if (!sessionId) {
    res.status(400).json({ error: 'Missing session_id.' });
    return;
  }
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  const metadata = session.metadata || {};
  const { client } = getSupabaseAdmin();
  const identity = await getIvucxIdentity(req, client);
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
  const amountYen = Math.max(0, Math.round(Number(session.amount_total || metadata.amountYen) || 0));
  const amountVx = clampVx(metadata.amountVx || (amountYen / getYenPerVx()));
  const split = splitConditionalAmount(amountYen);
  res.status(200).json({
    sessionId: session.id,
    status: session.status,
    paymentStatus: session.payment_status,
    paid: session.payment_status === 'paid',
    amountTotal: amountYen,
    amountYen,
    amountVx,
    yenPerVx: getYenPerVx(),
    currency: session.currency || DEFAULT_CURRENCY,
    metadata,
    split
  });
}

export async function sendConditionalCheckoutResponse(req, res) {
  try {
    await assertDistributedRateLimit(req, {
      route: req.method === 'POST' ? 'stripe-conditional-create' : 'stripe-conditional-read',
      limit: req.method === 'POST' ? 10 : 60,
      windowSeconds: 60
    });
    if (req.method === 'POST') {
      await createConditionalCheckout(req, res);
      return;
    }
    if (req.method === 'GET') {
      await readConditionalCheckout(req, res);
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    const status = getHttpErrorStatus(error);
    res.status(status).json({
      error: getPublicErrorMessage(error, 'Conditional checkout failed.', status)
    });
  }
}
