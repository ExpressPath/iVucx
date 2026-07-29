export const CONDITIONAL_SHARE_SCALE_PPM = 1_000_000;
export const MAX_TOTAL_CONDITIONAL_SHARE_PPM = 500_000;
export const MAX_BOUNTY_YEN = 1_000_000_000;
export const CONDITIONAL_FUNDING_MODEL = 'final-total-fixed-ratio-v1';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function integerInRange(value, minimum, maximum, label) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) {
    const error = new RangeError(`${label} is out of range.`);
    error.statusCode = 409;
    throw error;
  }
  return numeric;
}

export function normalizeConditionalFunding(value) {
  if (!isPlainObject(value)) return null;
  const currency = safeString(value.currency, 'jpy').toLowerCase();
  if (currency !== 'jpy') return null;
  const rawAmount = value.amountYen ?? value.amountTotal ?? value.amountCents ?? value.amount;
  const amountYen = Math.round(Number(rawAmount) || 0);
  if (!Number.isSafeInteger(amountYen) || amountYen <= 0 || amountYen > MAX_BOUNTY_YEN) return null;

  const rawShare = value.fixedSharePpm;
  const fixedSharePpm = rawShare === undefined || rawShare === null || rawShare === ''
    ? 0
    : Math.round(Number(rawShare));
  const rawExisting = value.existingBountyYen;
  const existingBountyYen = rawExisting === undefined || rawExisting === null || rawExisting === ''
    ? 0
    : Math.round(Number(rawExisting));

  return {
    amountYen,
    amountVx: Math.round((Number(value.amountVx) || amountYen / 200) * 1_000_000) / 1_000_000,
    currency: 'jpy',
    status: safeString(value.status),
    paymentStatus: safeString(value.paymentStatus || value.payment_status || value.stripePaymentStatus),
    stripeSessionId: safeString(value.stripeSessionId || value.sessionId),
    stripePaymentIntentId: safeString(value.stripePaymentIntentId || value.paymentIntentId),
    serverVerified: value.serverVerified === true,
    verifiedAt: safeString(value.verifiedAt),
    yenPerVx: 200,
    fundingModel: safeString(value.fundingModel),
    existingBountyYen: Number.isSafeInteger(existingBountyYen) && existingBountyYen > 0
      ? existingBountyYen
      : 0,
    fixedSharePpm: Number.isSafeInteger(fixedSharePpm) && fixedSharePpm > 0
      ? fixedSharePpm
      : 0,
    sharePercent: Number.isFinite(Number(value.sharePercent))
      ? Number(value.sharePercent)
      : (fixedSharePpm > 0 ? fixedSharePpm / 10_000 : 0),
    updatedAt: safeString(value.updatedAt)
  };
}

export function getConditionalFixedSharePpm(conditional) {
  const bounty = normalizeConditionalFunding(conditional && conditional.bounty);
  if (!bounty || bounty.fundingModel !== CONDITIONAL_FUNDING_MODEL) return 0;
  if (
    !Number.isSafeInteger(bounty.fixedSharePpm)
    || bounty.fixedSharePpm <= 0
    || bounty.fixedSharePpm > MAX_TOTAL_CONDITIONAL_SHARE_PPM
  ) {
    const error = new RangeError('Conditional fixed share is invalid.');
    error.statusCode = 409;
    throw error;
  }
  return bounty.fixedSharePpm;
}

export function sumConditionalFixedShares(conditionals) {
  const rows = Array.isArray(conditionals) ? conditionals : [];
  const seen = new Set();
  let total = 0;
  for (const conditional of rows) {
    const id = safeString(conditional && conditional.conditionalProblemId);
    if (!id || seen.has(id)) {
      const error = new Error('Conditional funding entries must have unique problem IDs.');
      error.statusCode = 409;
      throw error;
    }
    seen.add(id);
    total += getConditionalFixedSharePpm(conditional);
    if (total > MAX_TOTAL_CONDITIONAL_SHARE_PPM) {
      const error = new RangeError('Conditional return shares exceed the safe 50% limit.');
      error.statusCode = 409;
      throw error;
    }
  }
  return total;
}

export function createConditionalShareSnapshot({
  contributionYen,
  existingBountyYen,
  existingConditionals = []
}) {
  const contribution = integerInRange(contributionYen, 1, MAX_BOUNTY_YEN, 'Conditional contribution');
  const existing = integerInRange(existingBountyYen, 1, MAX_BOUNTY_YEN, 'Existing bounty');
  const fixedSharePpm = Math.round((contribution * CONDITIONAL_SHARE_SCALE_PPM) / existing);
  if (fixedSharePpm <= 0) {
    const error = new RangeError('Conditional contribution is too small to establish a return share.');
    error.statusCode = 409;
    throw error;
  }
  const existingSharePpm = sumConditionalFixedShares(existingConditionals);
  if (fixedSharePpm + existingSharePpm > MAX_TOTAL_CONDITIONAL_SHARE_PPM) {
    const error = new RangeError('This contribution would reduce the solver share below 50%.');
    error.statusCode = 409;
    throw error;
  }
  return {
    fundingModel: CONDITIONAL_FUNDING_MODEL,
    contributionYen: contribution,
    existingBountyYen: existing,
    fixedSharePpm,
    sharePercent: fixedSharePpm / 10_000
  };
}

export function calculateFixedShareReturnYen(finalBountyYen, fixedSharePpm) {
  const total = integerInRange(finalBountyYen, 1, MAX_BOUNTY_YEN, 'Final bounty');
  const share = integerInRange(
    fixedSharePpm,
    1,
    MAX_TOTAL_CONDITIONAL_SHARE_PPM,
    'Conditional fixed share'
  );
  const rounded = (
    (BigInt(total) * BigInt(share))
    + BigInt(CONDITIONAL_SHARE_SCALE_PPM / 2)
  ) / BigInt(CONDITIONAL_SHARE_SCALE_PPM);
  return Number(rounded);
}

export function planConditionalReturns(finalBountyYen, usedConditionals) {
  const total = integerInRange(finalBountyYen, 1, MAX_BOUNTY_YEN, 'Final bounty');
  const conditionals = Array.isArray(usedConditionals) ? usedConditionals : [];
  const seen = new Set();
  const payouts = [];
  let totalSharePpm = 0;
  let totalReturnYen = 0;

  for (const conditional of conditionals) {
    const conditionalProblemId = safeString(conditional && conditional.conditionalProblemId);
    if (!conditionalProblemId || seen.has(conditionalProblemId)) {
      const error = new Error('Used Conditional IDs must be unique.');
      error.statusCode = 409;
      throw error;
    }
    seen.add(conditionalProblemId);
    const fixedSharePpm = getConditionalFixedSharePpm(conditional);
    if (fixedSharePpm <= 0) continue;
    totalSharePpm += fixedSharePpm;
    if (totalSharePpm > MAX_TOTAL_CONDITIONAL_SHARE_PPM) {
      const error = new RangeError('Used Conditional return shares exceed the safe 50% limit.');
      error.statusCode = 409;
      throw error;
    }
    const amountYen = calculateFixedShareReturnYen(total, fixedSharePpm);
    totalReturnYen += amountYen;
    payouts.push({
      conditional,
      conditionalProblemId,
      fixedSharePpm,
      sharePercent: fixedSharePpm / 10_000,
      amountYen
    });
  }

  if (totalReturnYen >= total) {
    const error = new RangeError('Conditional returns leave no bounty for the solver.');
    error.statusCode = 409;
    throw error;
  }
  return {
    fundingModel: CONDITIONAL_FUNDING_MODEL,
    finalBountyYen: total,
    totalSharePpm,
    totalSharePercent: totalSharePpm / 10_000,
    totalReturnYen,
    solverYen: total - totalReturnYen,
    payouts
  };
}
