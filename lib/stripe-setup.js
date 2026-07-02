import Stripe from 'stripe';
import { getGoogleIdentity } from './google-oauth.js';

const DEFAULT_CURRENCY = 'usd';

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function getStripeSecretKey() {
  return safeString(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY);
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

function getBaseUrl(req) {
  const configured = safeString(
    process.env.PUBLIC_APP_URL
      || process.env.APP_URL
      || process.env.GOOGLE_PUBLIC_BASE_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  );
  if (configured) return configured.replace(/\/+$/, '');

  const proto = safeString(req.headers['x-forwarded-proto'], req.protocol || 'https');
  const host = safeString(req.headers['x-forwarded-host'] || req.headers.host);
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function normalizeCustomerName(identity) {
  return safeString(identity && identity.name)
    || safeString(identity && identity.email)
    || safeString(identity && identity.accountId, 'PROVF user');
}

async function createStripeSetupSession(req, res) {
  const identity = await getGoogleIdentity(req);
  if (!identity.authenticated) {
    res.status(401).json({ error: 'Login is required before registering a Stripe card.' });
    return;
  }

  const stripe = getStripeClient();
  const baseUrl = getBaseUrl(req);
  const accountId = safeString(identity.accountId, 'Google account');
  const email = safeString(identity.email);
  const name = normalizeCustomerName(identity);
  const customer = await stripe.customers.create({
    email: email || undefined,
    name,
    metadata: {
      provider: 'provf_google',
      provfAccountId: accountId
    }
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    payment_method_types: ['card'],
    customer: customer.id,
    client_reference_id: accountId.slice(0, 128),
    metadata: {
      type: 'provf_card_setup',
      provider: 'google',
      accountId,
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

  const identity = await getGoogleIdentity(req);
  if (!identity.authenticated) {
    res.status(401).json({ error: 'Login is required.' });
    return;
  }

  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  res.status(200).json({
    sessionId: session.id,
    status: session.status,
    setupIntent: typeof session.setup_intent === 'string' ? session.setup_intent : '',
    customerId: typeof session.customer === 'string' ? session.customer : ''
  });
}

export async function sendStripeSetupResponse(req, res) {
  try {
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
    res.status(error.statusCode || 500).json({
      error: error.message || 'Stripe setup failed.'
    });
  }
}
