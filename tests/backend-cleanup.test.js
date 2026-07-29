import assert from 'node:assert/strict';
import test from 'node:test';

import { createAsyncLimiter, mapWithConcurrency } from '../lib/async-utils.js';
import { secureStringEqual } from '../lib/secure-compare.js';
import { getStripeClient, getStripeRedirectBaseUrl } from '../lib/stripe-server.js';

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('bounded async mapping preserves order and caps active work', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, (5 - value) * 2));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(result, [0, 2, 4, 6, 8, 10]);
  assert.equal(maxActive, 3);
});

test('shared async limiter caps nested callers', async () => {
  const limitTask = createAsyncLimiter(2);
  let active = 0;
  let maxActive = 0;
  const result = await Promise.all(Array.from({ length: 8 }, (_, value) => limitTask(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return value;
  })));

  assert.deepEqual(result, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(maxActive, 2);
});

test('secure string comparison accepts exact values only', () => {
  assert.equal(secureStringEqual('same-value', 'same-value'), true);
  assert.equal(secureStringEqual('same-value', 'same-valuE'), false);
  assert.equal(secureStringEqual('short', 'shorter'), false);
  assert.equal(secureStringEqual('', ''), true);
});

test('Stripe server client is reused and refreshed when its key rotates', () => {
  const previousSecret = process.env.STRIPE_SECRET_KEY;
  const previousApiKey = process.env.STRIPE_API_KEY;
  try {
    delete process.env.STRIPE_API_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_backend_cleanup_one';
    const first = getStripeClient();
    assert.equal(getStripeClient(), first);

    process.env.STRIPE_SECRET_KEY = 'sk_test_backend_cleanup_two';
    assert.notEqual(getStripeClient(), first);
  } finally {
    restoreEnv('STRIPE_SECRET_KEY', previousSecret);
    restoreEnv('STRIPE_API_KEY', previousApiKey);
  }
});

test('Stripe redirect origin keeps production HTTPS requirements', () => {
  const names = [
    'NODE_ENV',
    'PUBLIC_APP_URL',
    'APP_URL',
    'GOOGLE_PUBLIC_BASE_URL',
    'VERCEL_URL'
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.NODE_ENV = 'production';
    process.env.PUBLIC_APP_URL = 'https://example.test/payment/path';
    delete process.env.APP_URL;
    delete process.env.GOOGLE_PUBLIC_BASE_URL;
    delete process.env.VERCEL_URL;
    assert.equal(getStripeRedirectBaseUrl({}), 'https://example.test');

    process.env.PUBLIC_APP_URL = 'http://example.test';
    assert.throws(
      () => getStripeRedirectBaseUrl({}),
      /PUBLIC_APP_URL must use HTTPS/
    );

    delete process.env.PUBLIC_APP_URL;
    assert.throws(
      () => getStripeRedirectBaseUrl({}),
      (error) => error && error.statusCode === 503
    );
  } finally {
    for (const name of names) restoreEnv(name, previous[name]);
  }
});
