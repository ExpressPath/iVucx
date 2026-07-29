import { assertDistributedRateLimit } from './distributed-rate-limit.js';
import { getHttpErrorStatus, getPublicErrorMessage } from './http-error.js';
import { getIvucxIdentity } from './ivucx.js';
import { getStripeClient, getStripeRedirectBaseUrl } from './stripe-server.js';
import { getSupabaseAdmin } from './supabase-admin.js';

const DEFAULT_CURRENCY = 'usd';

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function normalizeCustomerName(identity) {
  return safeString(identity && identity.name)
    || safeString(identity && identity.email)
    || safeString(identity && identity.accountId, 'PROVF user');
}

async function createStripeSetupSession(req, res) {
  const { client: supabase } = getSupabaseAdmin();
  const identity = await getIvucxIdentity(req, supabase);
  if (!identity.authenticated) {
    res.status(401).json({ error: 'Login is required before registering a Stripe card.' });
    return;
  }

  const stripe = getStripeClient();
  const baseUrl = getStripeRedirectBaseUrl(req);
  const accountId = safeString(identity.accountId);
  const accountProvider = safeString(identity.accountProvider);
  const accountIdHash = safeString(identity.accountIdHash);
  const email = safeString(identity.email);
  const name = normalizeCustomerName(identity);
  const customer = await stripe.customers.create({
    email: email || undefined,
    name,
    metadata: {
      provider: `provf_${accountProvider}`,
      provfAccountIdHash: accountIdHash
    }
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    payment_method_types: ['card'],
    customer: customer.id,
    client_reference_id: accountIdHash.slice(0, 128),
    metadata: {
      type: 'provf_card_setup',
      accountProvider,
      accountIdHash,
      currency: DEFAULT_CURRENCY
    },
    success_url: `${baseUrl}/Vucks.html?stripeSetup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/Vucks.html?stripeSetup=cancelled`
  });

  res.status(200).json({
    url: session.url,
    sessionId: session.id,
    customerId: customer.id
  });
}

async function readStripeSetupSession(req, res) {
  const sessionId = safeString(req.query && req.query.session_id);
  if (!sessionId) {
    res.status(400).json({ error: 'Missing session_id.' });
    return;
  }

  const { client: supabase } = getSupabaseAdmin();
  const identity = await getIvucxIdentity(req, supabase);
  if (!identity.authenticated) {
    res.status(401).json({ error: 'Login is required.' });
    return;
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (
    safeString(session.metadata && session.metadata.type) !== 'provf_card_setup'
    || safeString(session.metadata && session.metadata.accountProvider) !== safeString(identity.accountProvider)
    || safeString(session.metadata && session.metadata.accountIdHash) !== safeString(identity.accountIdHash)
  ) {
    res.status(403).json({ error: 'Stripe setup session belongs to another account.' });
    return;
  }
  res.status(200).json({
    sessionId: session.id,
    status: session.status,
    setupIntent: typeof session.setup_intent === 'string' ? session.setup_intent : '',
    customerId: typeof session.customer === 'string' ? session.customer : ''
  });
}

export async function sendStripeSetupResponse(req, res) {
  try {
    await assertDistributedRateLimit(req, {
      route: req.method === 'POST' ? 'stripe-setup-create' : 'stripe-setup-read',
      limit: req.method === 'POST' ? 8 : 60,
      windowSeconds: 60
    });
    if (req.method === 'POST') {
      await createStripeSetupSession(req, res);
      return;
    }
    if (req.method === 'GET') {
      await readStripeSetupSession(req, res);
      return;
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    if (error && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    const status = getHttpErrorStatus(error);
    res.status(status).json({
      error: getPublicErrorMessage(error, 'Stripe setup failed.', status)
    });
  }
}
