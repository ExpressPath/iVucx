import Stripe from 'stripe';

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

function getStripeSecretKey() {
  return safeString(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY);
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

function getStripeClient() {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    const error = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
    error.statusCode = 503;
    throw error;
  }
  return new Stripe(secretKey);
}

function normalizeCurrency(value) {
  const text = safeString(value, DEFAULT_CURRENCY).toLowerCase();
  return /^[a-z]{3}$/.test(text) ? text : DEFAULT_CURRENCY;
}

function formatTitle(value) {
  return safeString(value, 'Untitled problem').slice(0, 120);
}

async function createBountyCheckout(req, res) {
  const body = req.body || {};
  const amountCents = clampAmountCents(body.amountCents);
  if (amountCents < MIN_AMOUNT_CENTS) {
    res.status(400).json({ error: 'Bounty amount is too small.' });
    return;
  }

  const stripe = getStripeClient();
  const baseUrl = getBaseUrl(req);
  const title = formatTitle(body.title);
  const currency = normalizeCurrency(body.currency);
  const problemKind = safeString(body.problemKind, 'problem');
  const language = safeString(body.language);
  const fileName = safeString(body.fileName);

  if (problemKind !== 'problem') {
    res.status(400).json({ error: 'Bounties can be added to problem posts only.' });
    return;
  }

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
      language,
      fileName,
      amountCents: String(amountCents)
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
  res.status(200).json({
    sessionId: session.id,
    status: session.status,
    paymentStatus: session.payment_status,
    paid: session.payment_status === 'paid',
    amountTotal: session.amount_total || 0,
    currency: session.currency || DEFAULT_CURRENCY,
    metadata: session.metadata || {}
  });
}

export async function sendBountyCheckoutResponse(req, res) {
  try {
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
    res.status(error.statusCode || 500).json({
      error: error.message || 'Bounty checkout failed.'
    });
  }
}
