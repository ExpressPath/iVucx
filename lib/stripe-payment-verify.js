import { getStripeClient } from './stripe-server.js';

const DEFAULT_CURRENCY = 'usd';
const DEFAULT_YEN_PER_VX = 200;

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function getYenPerVx() {
  return DEFAULT_YEN_PER_VX;
}

function toFixedVx(value) {
  const numeric = Number(value) || 0;
  return Math.round(numeric * 1000000) / 1000000;
}

function splitConditionalYen(amountYen) {
  const total = Math.max(0, Math.round(Number(amountYen) || 0));
  return {
    feeYen: 0,
    problemBountyYen: total,
    creatorYen: 0,
    fundingModel: 'final-total-fixed-ratio-v1'
  };
}

function assertPaidCheckoutSession(session, expectedType) {
  if (!session || !session.id) {
    const error = new Error('Stripe Checkout Session was not found.');
    error.statusCode = 402;
    throw error;
  }
  const metadata = session.metadata || {};
  if (expectedType && safeString(metadata.type) !== expectedType) {
    const error = new Error('Stripe Checkout Session type does not match this operation.');
    error.statusCode = 409;
    throw error;
  }
  if (session.mode !== 'payment') {
    const error = new Error('Stripe Checkout Session is not a one-time payment.');
    error.statusCode = 409;
    throw error;
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    const error = new Error('Stripe payment is not complete.');
    error.statusCode = 402;
    throw error;
  }
  if (!Number.isFinite(Number(session.amount_total)) || Number(session.amount_total) <= 0) {
    const error = new Error('Stripe payment amount is invalid.');
    error.statusCode = 409;
    throw error;
  }
}

function assertSessionIdentity(metadata, expected = {}) {
  if (expected && expected.skipIdentityCheck) return;
  const accountProvider = safeString(metadata && metadata.accountProvider);
  const accountIdHash = safeString(metadata && metadata.accountIdHash);
  if (!accountProvider || !accountIdHash) {
    const error = new Error('Stripe Checkout Session has no secure account binding. Create a new Checkout Session.');
    error.statusCode = 409;
    throw error;
  }

  const identity = expected && expected.identity && expected.identity.authenticated
    ? expected.identity
    : null;
  if (!identity) {
    const error = new Error('Login is required to use this Stripe Checkout Session.');
    error.statusCode = 401;
    throw error;
  }
  if (safeString(identity.accountProvider) !== accountProvider) {
    const error = new Error('Stripe Checkout Session account does not match the current user.');
    error.statusCode = 409;
    throw error;
  }
  if (safeString(identity.accountIdHash) !== accountIdHash) {
    const error = new Error('Stripe Checkout Session account does not match the current user.');
    error.statusCode = 409;
    throw error;
  }
}

async function retrievePaidCheckoutSession(sessionId, expectedType) {
  const id = safeString(sessionId);
  if (!id) {
    const error = new Error('Stripe session id is required.');
    error.statusCode = 400;
    throw error;
  }
  const stripe = getStripeClient();
  const session = await stripe.checkout.sessions.retrieve(id);
  assertPaidCheckoutSession(session, expectedType);
  return session;
}

export async function verifyBountyCheckoutSession(bounty, expected = {}) {
  const source = bounty && typeof bounty === 'object' ? bounty : {};
  const sessionId = safeString(source.stripeSessionId || source.sessionId);
  const session = await retrievePaidCheckoutSession(sessionId, 'provf_bounty');
  const metadata = session.metadata || {};
  const amountCents = Math.max(0, Math.round(Number(session.amount_total) || 0));
  const currency = safeString(session.currency, DEFAULT_CURRENCY).toLowerCase();
  assertSessionIdentity(metadata, expected);
  if (safeString(metadata.problemKind) !== 'problem' || safeString(metadata.proofState).toUpperCase() !== 'NY') {
    const error = new Error('Stripe bounty metadata does not match an unresolved problem bounty.');
    error.statusCode = 409;
    throw error;
  }
  const metadataAmountCents = Number(metadata.amountCents);
  if (Number.isFinite(metadataAmountCents) && metadataAmountCents > 0 && Math.round(metadataAmountCents) !== amountCents) {
    const error = new Error('Stripe bounty amount metadata does not match the paid amount.');
    error.statusCode = 409;
    throw error;
  }
  return {
    amountCents,
    currency: /^[a-z]{3}$/.test(currency) ? currency : DEFAULT_CURRENCY,
    status: 'funded',
    paymentStatus: 'paid',
    stripeSessionId: session.id,
    stripePaymentIntentId: safeString(session.payment_intent),
    serverVerified: true,
    verifiedAt: new Date().toISOString()
  };
}

export async function verifyConditionalCheckoutSession(conditionalBounty, expected = {}) {
  const source = conditionalBounty && typeof conditionalBounty === 'object' ? conditionalBounty : {};
  const sessionId = safeString(source.stripeSessionId || source.sessionId);
  const session = await retrievePaidCheckoutSession(sessionId, 'provf_conditional_bounty');
  const metadata = session.metadata || {};
  const expectedProblemId = safeString(expected.problemId || expected.originalProblemId);
  assertSessionIdentity(metadata, expected);
  if (expectedProblemId && safeString(metadata.problemId) !== expectedProblemId) {
    const error = new Error('Stripe Conditional payment is not for this problem.');
    error.statusCode = 409;
    throw error;
  }
  if (safeString(metadata.proofState).toUpperCase() !== 'NY') {
    const error = new Error('Stripe Conditional metadata does not match an axiom-backed proof.');
    error.statusCode = 409;
    throw error;
  }
  const amountYen = Math.max(0, Math.round(Number(session.amount_total) || 0));
  const metadataAmountYen = Number(metadata.amountYen);
  if (Number.isFinite(metadataAmountYen) && metadataAmountYen > 0 && Math.round(metadataAmountYen) !== amountYen) {
    const error = new Error('Stripe Conditional amount metadata does not match the paid amount.');
    error.statusCode = 409;
    throw error;
  }
  const metadataAmountVx = Number(metadata.amountVx);
  const amountVx = toFixedVx(Number.isFinite(metadataAmountVx) && metadataAmountVx > 0
    ? metadataAmountVx
    : amountYen / getYenPerVx());
  if (amountVx < 1) {
    const error = new Error('Conditional bounty must be at least Vx 1.');
    error.statusCode = 409;
    throw error;
  }
  if (safeString(metadata.fundingModel) && safeString(metadata.fundingModel) !== 'final-total-fixed-ratio-v1') {
    const error = new Error('Stripe Conditional funding model is not supported.');
    error.statusCode = 409;
    throw error;
  }
  const split = splitConditionalYen(amountYen);
  return {
    amountYen,
    amountVx,
    currency: safeString(session.currency, 'jpy').toLowerCase(),
    status: 'funded',
    paymentStatus: 'paid',
    stripeSessionId: session.id,
    stripePaymentIntentId: safeString(session.payment_intent),
    yenPerVx: getYenPerVx(),
    split,
    fundingModel: 'final-total-fixed-ratio-v1',
    serverVerified: true,
    verifiedAt: new Date().toISOString()
  };
}
