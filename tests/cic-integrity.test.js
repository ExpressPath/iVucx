import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { buildProblemRecord } from '../lib/problem-store.js';
import {
  assertPortableCicTarget,
  assertProblemProofBinding,
  assertTrustedCicRecord,
  buildCicBindingGuard,
  hashCicTarget
} from '../lib/problem-proof-binding.js';
import {
  allowedConditionalAssumptionNames,
  buildProofAssumptionAudit,
  parseProofAssumptions
} from '../lib/proof-assumptions.js';
import { assertProofRequestAllowed } from '../lib/request-guard.js';

const TRUE_TARGET = Object.freeze({ kind: 'const', name: 'True' });

function trustedResult(code, target = TRUE_TARGET, proofTerm = { kind: 'construct', inductive: 'True', ctorIndex: 0 }) {
  return {
    ok: true,
    language: 'lean',
    proofCheck: { ok: true },
    conversion: {
      ok: true,
      targetFamily: 'cic',
      requestedFormat: 'cic-v1',
      codeHash: createHash('sha256').update(code, 'utf8').digest('hex'),
      lambda: {
        format: 'cic-v1',
        term: proofTerm,
        context: { type: target },
        declarations: null,
        metadata: { sourceLanguage: 'Lean' }
      }
    }
  };
}

function trustedProblem(target = TRUE_TARGET) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    language: 'lean',
    proof_state: 'NY',
    verification_status: 'verified',
    normalized_format: 'cic-v1',
    normalized_term: target,
    adapter_meta: { context: { type: target } },
    request_meta: {
      conditionals: [],
      cicTarget: {
        version: 1,
        source: 'server-recomputed-context.type',
        sha256: hashCicTarget(target)
      }
    }
  };
}

function coqSolution(target = TRUE_TARGET) {
  const solutionTarget = { kind: 'const', name: 'provf_problem_target' };
  return {
    language: 'coq',
    verification_status: 'verified',
    normalized_format: 'cic-v1',
    normalized_term: solutionTarget,
    adapter_meta: { context: { type: solutionTarget } },
    source_code: [
      'Definition provf_problem_target : Prop := True.',
      'Theorem provf_solution : provf_problem_target.',
      'Proof. exact I. Qed.'
    ].join('\n'),
    request_meta: {
      cicTarget: {
        version: 1,
        source: 'server-recomputed-context.type',
        sha256: hashCicTarget(solutionTarget)
      },
      solveContext: {
        problemId: '11111111-1111-4111-8111-111111111111',
        normalizedTerm: target,
        selectedConditionals: []
      }
    }
  };
}

test('cic persistence stores the proposition type and keeps the proof term only as audit metadata', () => {
  const code = 'theorem complete : True := by trivial';
  const proofTerm = { kind: 'construct', inductive: 'True', ctorIndex: 0 };
  const { record } = buildProblemRecord({
    title: 'complete',
    language: 'Lean',
    fileName: 'Main.lean',
    code,
    problemKind: 'theorem',
    proofState: 'NY',
    requestedFormat: 'cic-v1',
    format: 'cic-v1'
  }, trustedResult(code, TRUE_TARGET, proofTerm));

  assert.deepEqual(record.normalized_term, TRUE_TARGET);
  assert.deepEqual(record.adapter_meta.proofTerm, proofTerm);
  assert.equal(record.request_meta.cicTarget.source, 'server-recomputed-context.type');
  assert.equal(record.request_meta.cicTarget.sha256, hashCicTarget(TRUE_TARGET));
  assert.equal(record.proof_state, 'YY');
});

test('cic persistence fails closed when the trusted converter omits context.type', () => {
  const code = 'theorem missing : True := by trivial';
  const result = trustedResult(code);
  result.conversion.lambda.context = {};
  assert.throws(
    () => buildProblemRecord({
      language: 'Lean',
      code,
      problemKind: 'theorem',
      format: 'cic-v1'
    }, result),
    /context\.type/
  );
});

test('problem workflows cannot fall back to an untrusted non-CIC normalization', () => {
  const code = 'axiom unresolved : True';
  const result = trustedResult(code);
  result.conversion.lambda.format = 'typed-lambda-v1';
  result.conversion.requestedFormat = 'typed-lambda-v1';
  assert.throws(
    () => buildProblemRecord({
      language: 'Lean',
      code,
      problemKind: 'problem',
      format: 'typed-lambda-v1'
    }, result),
    /require a trusted cic-v1/
  );
});

test('bound solutions keep their generated target alias while binding uses the original CIC target', () => {
  const code = [
    'def provf_problem_target : Prop := True',
    'theorem provf_solution : provf_problem_target := by trivial'
  ].join('\n');
  const generatedAlias = { kind: 'const', name: 'provf_problem_target' };
  const { record } = buildProblemRecord({
    title: 'solution',
    language: 'Lean',
    code,
    problemKind: 'theorem',
    format: 'cic-v1',
    solveContext: {
      problemId: '11111111-1111-4111-8111-111111111111',
      normalizedTerm: TRUE_TARGET,
      selectedConditionals: []
    }
  }, trustedResult(code, generatedAlias));

  assert.deepEqual(record.normalized_term, generatedAlias);
  assert.deepEqual(record.request_meta.solveContext.normalizedTerm, TRUE_TARGET);
  assert.equal(record.proof_state, 'YY');
});

test('legacy or tampered CIC rows cannot receive a solution', () => {
  const legacy = trustedProblem();
  delete legacy.request_meta.cicTarget;
  assert.throws(
    () => assertProblemProofBinding(legacy, coqSolution()),
    /must be re-verified/
  );

  const tampered = trustedProblem();
  tampered.request_meta.cicTarget.sha256 = '0'.repeat(64);
  assert.throws(
    () => assertProblemProofBinding(tampered, coqSolution()),
    /must be re-verified/
  );
});

test('settlement-grade CIC rows require a persisted kernel assumption audit', () => {
  const row = coqSolution();
  assert.throws(
    () => assertTrustedCicRecord(row, { requireAssumptionAudit: true }),
    /kernel assumption audit/
  );
  row.proof_state = 'YY';
  row.verification_result = {
    sourcePolicy: {
      assumptionAudit: {
        target: 'provf_solution',
        assumptions: [],
        unexpectedAssumptions: []
      }
    }
  };
  assert.doesNotThrow(() => assertTrustedCicRecord(row, { requireAssumptionAudit: true }));
  row.verification_result.sourcePolicy.assumptionAudit.unexpectedAssumptions = ['Classical.choice'];
  assert.throws(
    () => assertTrustedCicRecord(row, { requireAssumptionAudit: true }),
    /unexpected kernel assumptions/
  );
});

test('Rocq 9.1 logical names are portable but lookalike user constants are rejected', () => {
  assert.doesNotThrow(
    () => assertPortableCicTarget({ kind: 'ind', name: 'Corelib.Init.Logic.True,0' })
  );
  assert.throws(
    () => assertPortableCicTarget({ kind: 'ind', name: 'Attacker.True,0' }),
    /non-portable constant/
  );
});

test('CIC equality drops the explicit type argument and binds both translated operands', () => {
  const equalityTarget = {
    kind: 'app',
    fn: { kind: 'const', name: 'Eq' },
    args: [
      { kind: 'sort', level: { kind: 'raw-level', value: { kind: 'unknown-type-level' } } },
      TRUE_TARGET,
      TRUE_TARGET
    ]
  };
  const original = trustedProblem(equalityTarget);
  const solution = coqSolution(equalityTarget);
  solution.source_code = solution.source_code.replace(':= True.', ':= (True = True).');
  assert.doesNotThrow(() => assertProblemProofBinding(original, solution));
  assert.match(buildCicBindingGuard('lean', solution.source_code, equalityTarget), /_root_\.Eq _root_\.True _root_\.True/);
});

test('kernel assumption reports distinguish closed and axiom-dependent proofs', () => {
  assert.deepEqual(
    parseProofAssumptions('lean', "'complete' does not depend on any axioms"),
    { recognized: true, assumptions: [] }
  );
  assert.deepEqual(
    parseProofAssumptions('lean', "'relative' depends on axioms: [provf_conditional_a, Classical.choice]"),
    {
      recognized: true,
      assumptions: ['Classical.choice', 'provf_conditional_a']
    }
  );
  assert.deepEqual(
    parseProofAssumptions('coq', 'Axioms:\nprovf_conditional_a : provf_problem_target\nfunctional_extensionality : forall A, A'),
    {
      recognized: true,
      assumptions: ['functional_extensionality', 'provf_conditional_a']
    }
  );
  assert.equal(parseProofAssumptions('coq', 'unrecognized output').recognized, false);
});

test('kernel assumption parsing ignores user-forged report text outside random audit markers', () => {
  const audit = buildProofAssumptionAudit('lean', 'theorem complete : True := by trivial', 'complete');
  assert.doesNotThrow(() => assertProofRequestAllowed(
    { ip: '198.51.100.201', headers: {} },
    '/api/lean-check',
    { body: { language: 'Lean', code: audit.code } }
  ));
  const output = [
    "'complete' does not depend on any axioms",
    audit.startMarker,
    "'complete' depends on axioms: [Classical.choice]",
    audit.endMarker
  ].join('\n');
  assert.deepEqual(
    parseProofAssumptions('lean', output, audit),
    { recognized: true, assumptions: ['Classical.choice'] }
  );
  assert.equal(
    parseProofAssumptions('lean', "'complete' does not depend on any axioms", audit).recognized,
    false
  );
});

test('only selected Conditional names enter the kernel-assumption allowlist', () => {
  const allowed = allowedConditionalAssumptionNames({
    selectedConditionals: [
      { conditionalProblemId: 'a-b' },
      { conditionalTitle: 'title with spaces' }
    ]
  });
  assert.deepEqual(
    [...allowed].sort(),
    ['provf_conditional_a_b', 'provf_conditional_title_with_spaces']
  );
});
