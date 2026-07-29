import Stripe from 'stripe';

let cachedClient = null;
let cachedSecretKey = '';

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

export function getStripeClient() {
  const secretKey = safeString(process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY);
  if (!secretKey) {
    const error = new Error('Stripe is not configured. Set STRIPE_SECRET_KEY.');
    error.statusCode = 503;
    throw error;
  }
  if (!cachedClient || cachedSecretKey !== secretKey) {
    cachedClient = new Stripe(secretKey);
    cachedSecretKey = secretKey;
  }
  return cachedClient;
}

export function getStripeRedirectBaseUrl(req = {}) {
  const configured = safeString(
    process.env.PUBLIC_APP_URL
      || process.env.APP_URL
      || process.env.GOOGLE_PUBLIC_BASE_URL
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
  );
  if (configured) {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
      throw new Error('PUBLIC_APP_URL must use HTTPS.');
    }
    return parsed.origin;
  }

  if (process.env.NODE_ENV === 'production') {
    const error = new Error('PUBLIC_APP_URL is required for Stripe redirects in production.');
    error.statusCode = 503;
    throw error;
  }

  const headers = req && req.headers ? req.headers : {};
  const proto = safeString(headers['x-forwarded-proto'], req.protocol || 'https');
  const host = safeString(headers['x-forwarded-host'] || headers.host);
  return `${proto}://${host}`.replace(/\/+$/, '');
}
