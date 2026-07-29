import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  CONDITIONAL_FUNDING_MODEL,
  calculateFixedShareReturnYen,
  createConditionalShareSnapshot,
  planConditionalReturns
} from '../lib/conditional-share.js';

function fundedConditional(id, fixedSharePpm) {
  return {
    conditionalProblemId: id,
    conditionalTitle: `Conditional ${id}`,
    bounty: {
      amountYen: 20_000,
      currency: 'jpy',
      fundingModel: CONDITIONAL_FUNDING_MODEL,
      existingBountyYen: 100_000,
      fixedSharePpm,
      paymentStatus: 'paid',
      serverVerified: true,
      stripeSessionId: `cs_${id}`
    }
  };
}

test('Conditional share is fixed from contribution divided by the existing bounty', () => {
  assert.deepEqual(
    createConditionalShareSnapshot({
      contributionYen: 20_000,
      existingBountyYen: 100_000,
      existingConditionals: []
    }),
    {
      fundingModel: CONDITIONAL_FUNDING_MODEL,
      contributionYen: 20_000,
      existingBountyYen: 100_000,
      fixedSharePpm: 200_000,
      sharePercent: 20
    }
  );
});

test('Conditional return uses the final total bounty instead of only later additions', () => {
  assert.equal(calculateFixedShareReturnYen(170_000, 200_000), 34_000);
  const plan = planConditionalReturns(170_000, [fundedConditional('a', 200_000)]);
  assert.equal(plan.totalReturnYen, 34_000);
  assert.equal(plan.solverYen, 136_000);
  assert.equal(plan.totalSharePercent, 20);
});

test('multiple used Conditionals retain their independent fixed ratios', () => {
  const plan = planConditionalReturns(200_000, [
    fundedConditional('a', 200_000),
    fundedConditional('b', 250_000)
  ]);
  assert.deepEqual(plan.payouts.map((payout) => payout.amountYen), [40_000, 50_000]);
  assert.equal(plan.totalReturnYen, 90_000);
  assert.equal(plan.solverYen, 110_000);
});

test('registration rejects aggregate shares above the solver-safe 50% limit', () => {
  assert.throws(
    () => createConditionalShareSnapshot({
      contributionYen: 20_000,
      existingBountyYen: 100_000,
      existingConditionals: [fundedConditional('existing', 400_000)]
    }),
    /below 50%/
  );
});

test('duplicate used Conditional IDs and malformed numeric values fail closed', () => {
  assert.throws(
    () => planConditionalReturns(100_000, [
      fundedConditional('duplicate', 100_000),
      fundedConditional('duplicate', 100_000)
    ]),
    /unique/
  );
  assert.throws(
    () => calculateFixedShareReturnYen(Number.MAX_SAFE_INTEGER, 100_000),
    /out of range/
  );
  assert.throws(
    () => createConditionalShareSnapshot({
      contributionYen: 50_001,
      existingBountyYen: 100_000
    }),
    /below 50%/
  );
});

test('yen rounding is deterministic at half a yen', () => {
  assert.equal(calculateFixedShareReturnYen(3, 500_000), 2);
  assert.equal(calculateFixedShareReturnYen(1, 1), 0);
});

test('post preview exposes optional Conditional funding and submits it with the proof', async () => {
  const html = await readFile(new URL('../post-preview.html', import.meta.url), 'utf8');
  assert.match(html, /id="conditionalAmount"/);
  assert.match(html, /id="conditionalCheckoutBtn"/);
  assert.match(html, /problemBountyYen:total/);
  assert.match(
    html,
    /conditionalBounty:\s*problemKind === 'conditional' \? getDraftConditionalBounty\(draft\) : null/
  );
});
