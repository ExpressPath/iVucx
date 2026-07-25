import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { readBoundedResponseText } from '../lib/bounded-response.js';
import { getTrustedClientAddress } from '../lib/distributed-rate-limit.js';
import { getPublicErrorMessage } from '../lib/http-error.js';
import { issueProblemCapability, verifyProblemCapability } from '../lib/problem-access.js';
import { issueJobCapability, verifyJobCapability } from '../lib/job-access.js';
import { assertProblemProofBinding } from '../lib/problem-proof-binding.js';
import { buildProofProcessEnv } from '../lib/proof-process-env.js';
import { isolatedProcessOptions } from '../lib/child-process-tree.js';
import { assertProofRequestAllowed } from '../lib/request-guard.js';

test('problem attachment capabilities are purpose- and problem-bound', () => {
  const previous = process.env.PROBLEM_CAPABILITY_SECRET;
  process.env.PROBLEM_CAPABILITY_SECRET = 'security-test-capability-secret';
  try {
    const token = issueProblemCapability('problem-a', 'attachments');
    assert.equal(verifyProblemCapability('problem-a', token, 'attachments'), true);
    assert.equal(verifyProblemCapability('problem-b', token, 'attachments'), false);
    assert.equal(verifyProblemCapability('problem-a', token, 'other-purpose'), false);
  } finally {
    if (previous === undefined) delete process.env.PROBLEM_CAPABILITY_SECRET;
    else process.env.PROBLEM_CAPABILITY_SECRET = previous;
  }
});

test('helper job capabilities are job-bound and expire', () => {
  const previous = process.env.JOB_CAPABILITY_SECRET;
  process.env.JOB_CAPABILITY_SECRET = 'security-test-job-capability-secret';
  try {
    const nowMs = 1700000000000;
    const token = issueJobCapability('job-a', { nowMs, maxAgeSeconds: 120 });
    assert.equal(verifyJobCapability('job-a', token, { nowMs: nowMs + 60000 }), true);
    assert.equal(verifyJobCapability('job-b', token, { nowMs: nowMs + 60000 }), false);
    assert.equal(verifyJobCapability('job-a', token, { nowMs: nowMs + 121000 }), false);
  } finally {
    if (previous === undefined) delete process.env.JOB_CAPABILITY_SECRET;
    else process.env.JOB_CAPABILITY_SECRET = previous;
  }
});

test('problem solutions must prove the exact stored CIC target', () => {
  const original = {
    id: '11111111-1111-4111-8111-111111111111',
    proof_state: 'NY',
    normalized_term: { kind: 'const', name: 'True' },
    request_meta: { conditionals: [] }
  };
  const solution = {
    language: 'coq',
    source_code: [
      'Definition provf_problem_target : Prop := True.',
      'Theorem provf_solution : provf_problem_target.',
      'Proof. exact I. Qed.'
    ].join('\n'),
    request_meta: {
      solveContext: {
        problemId: original.id,
        normalizedTerm: { kind: 'const', name: 'True' },
        selectedConditionals: []
      }
    }
  };

  assert.doesNotThrow(() => assertProblemProofBinding(original, solution));
  assert.throws(
    () => assertProblemProofBinding(original, {
      ...solution,
      source_code: solution.source_code.replace(':= True.', ':= False.')
    }),
    /does not match/
  );
});

test('proof request guard catches same-line execution directives', () => {
  assert.throws(
    () => assertProofRequestAllowed(
      { headers: { 'x-forwarded-for': '192.0.2.10' } },
      '/api/coq-check',
      { body: { language: 'Coq', code: 'Theorem ok : True. Proof. exact I. Qed. Load "unsafe".' } }
    ),
    /execution directives/
  );
  assert.throws(
    () => assertProofRequestAllowed(
      { headers: { 'x-forwarded-for': '192.0.2.11' } },
      '/api/lean-check',
      { body: { language: 'Lean', code: 'theorem ok : True := by trivial; #eval 1' } }
    ),
    /execution directives/
  );
  assert.throws(
    () => assertProofRequestAllowed(
      { ip: '192.0.2.12', headers: {} },
      '/api/lean-check',
      { body: { language: 'Lean', code: 'def leaked := include_str "/etc/passwd"' } }
    ),
    /execution directives/
  );
  assert.throws(
    () => assertProofRequestAllowed(
      { ip: '192.0.2.13', headers: {} },
      '/api/lean-check',
      { body: { language: 'Lean', code: 'example : True := by run_tac pure ()' } }
    ),
    /execution directives/
  );
  assert.doesNotThrow(() => assertProofRequestAllowed(
    { ip: '192.0.2.14', headers: {} },
    '/api/lean-check',
    {
      body: {
        language: 'Lean',
        code: '/- outer /- #eval 1 -/ include_str "ignored" -/\ntheorem ok : True := by trivial\n#print axioms ok'
      }
    }
  ));
});

test('proof child processes do not inherit application secrets', () => {
  const previous = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = 'must-not-reach-proof-process';
  try {
    const env = buildProofProcessEnv({ PATH: process.env.PATH || '' });
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
    assert.equal(env.IVUCX_PROOF_SANDBOX, 'restricted-env-v1');
    assert.equal(typeof env.PATH, 'string');
  } finally {
    if (previous === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previous;
  }
});

test('proof child processes use an isolated process group where supported', () => {
  const options = isolatedProcessOptions();
  if (process.platform === 'win32') {
    assert.equal(options.windowsHide, true);
  } else {
    assert.equal(options.detached, true);
  }
});

test('direct deployments ignore spoofed forwarding headers for proof limits', () => {
  const previousTrust = process.env.TRUST_PROXY_HEADERS;
  const previousVercel = process.env.VERCEL;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.VERCEL;
  try {
    for (let index = 0; index < 10; index += 1) {
      assert.doesNotThrow(() => assertProofRequestAllowed(
        {
          ip: '198.51.100.77',
          headers: { 'x-forwarded-for': `203.0.113.${index + 1}` }
        },
        '/api/coq-check',
        { body: { language: 'Coq', code: 'Theorem ok : True. Proof. exact I. Qed.' } }
      ));
    }
    assert.throws(
      () => assertProofRequestAllowed(
        {
          ip: '198.51.100.77',
          headers: { 'x-forwarded-for': '203.0.113.250' }
        },
        '/api/coq-check',
        { body: { language: 'Coq', code: 'Theorem ok : True. Proof. exact I. Qed.' } }
      ),
      /Too many proof verification requests/
    );
  } finally {
    if (previousTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previousTrust;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test('trusted client address ignores generic forwarding headers by default', () => {
  const previousTrust = process.env.TRUST_PROXY_HEADERS;
  const previousVercel = process.env.VERCEL;
  delete process.env.TRUST_PROXY_HEADERS;
  delete process.env.VERCEL;
  try {
    assert.equal(getTrustedClientAddress({
      ip: '198.51.100.10',
      headers: { 'x-forwarded-for': '203.0.113.99' }
    }), '198.51.100.10');
  } finally {
    if (previousTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previousTrust;
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  }
});

test('upstream response reader rejects oversized bodies', async () => {
  const response = new Response(new Uint8Array(2048), {
    headers: { 'content-length': '2048' }
  });
  await assert.rejects(
    () => readBoundedResponseText(response, 1024),
    (error) => error && error.code === 'UPSTREAM_RESPONSE_TOO_LARGE'
  );
});

test('production errors hide server details while preserving client errors', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(
      getPublicErrorMessage(new Error('database host and path'), 'Service unavailable.', 500),
      'Service unavailable.'
    );
    assert.equal(
      getPublicErrorMessage(new Error('Invalid request.'), 'Request failed.', 400),
      'Invalid request.'
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('editor removes persistent plaintext AI keys after session migration', async () => {
  const source = await readFile(new URL('../editor.html', import.meta.url), 'utf8');
  assert.match(source, /sessionStorage\.setItem\(AI_KEYS_STORAGE_KEY/);
  assert.match(source, /localStorage\.removeItem\(AI_KEYS_STORAGE_KEY\)/);
  assert.doesNotMatch(source, /localStorage\.setItem\(AI_KEYS_STORAGE_KEY/);
});

test('problem attachment quotas are consumed only after authorization', async () => {
  const source = await readFile(new URL('../lib/problem-attachments.js', import.meta.url), 'utf8');
  const signAccess = source.indexOf('await assertAttachmentAccess(req, client, problem, input);');
  const signLimit = source.indexOf("route: 'attachment-sign-problem'");
  const completeAccess = source.indexOf(
    'await assertAttachmentAccess(req, client, problem, input);',
    signLimit + 1
  );
  const completeLimit = source.indexOf("route: 'attachment-complete-problem'");

  assert.ok(signAccess >= 0 && signLimit > signAccess);
  assert.ok(completeAccess > signLimit && completeLimit > completeAccess);
});
