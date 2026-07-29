import { createHash } from 'crypto';

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestError(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parseObject(value) {
  if (isPlainObject(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function unwrapTerm(value) {
  let current = parseObject(value) || value;
  for (let index = 0; index < 6; index += 1) {
    if (!isPlainObject(current)) return current;
    const next = ['term', 'value', 'normalized', 'cic', 'expression']
      .map((key) => current[key])
      .find(isPlainObject);
    if (!next) break;
    current = next;
  }
  return current;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashCicTarget(value) {
  return createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function field(term, names) {
  if (!isPlainObject(term)) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(term, name)) return term[name];
  }
  return undefined;
}

function nodeKind(term) {
  return String(field(term, ['kind', 'tag', 'type', 'node', 'constructor']) || '').trim().toLowerCase();
}

function rawName(value) {
  return isPlainObject(value)
    ? String(value.name || value.id || value.ident || value.value || value.text || '').trim()
    : String(value || '').trim();
}

function sanitizeIdentifier(value, fallback = 'x') {
  const base = String(value || fallback)
    .replace(/[^A-Za-z0-9_']/g, '_')
    .replace(/^[^A-Za-z_]+/, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const candidate = base || fallback;
  return new Set([
    'theorem', 'lemma', 'def', 'Definition', 'Theorem', 'Proof', 'Qed', 'fun', 'forall',
    'let', 'in', 'by', 'match', 'with', 'Type', 'Prop', 'True', 'False'
  ]).has(candidate) ? `${candidate}_value` : candidate;
}

function nameLeaf(value) {
  const name = rawName(value);
  const parts = name.split(/[.:/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : name;
}

const PORTABLE_NAMES = Object.freeze({
  True: new Set(['True', 'Coq.Init.Logic.True', 'Corelib.Init.Logic.True,0']),
  False: new Set(['False', 'Coq.Init.Logic.False', 'Corelib.Init.Logic.False,0']),
  Eq: new Set(['Eq', 'eq', 'Coq.Init.Logic.eq', 'Corelib.Init.Logic.eq,0']),
  And: new Set(['And', 'and', 'Coq.Init.Logic.and', 'Corelib.Init.Logic.and,0']),
  Or: new Set(['Or', 'or', 'Coq.Init.Logic.or', 'Corelib.Init.Logic.or,0']),
  Iff: new Set(['Iff', 'iff', 'Coq.Init.Logic.iff', 'Corelib.Init.Logic.iff']),
  Not: new Set(['Not', 'not', 'Coq.Init.Logic.not', 'Corelib.Init.Logic.not'])
});

function portableName(value) {
  const name = rawName(value);
  for (const [key, names] of Object.entries(PORTABLE_NAMES)) {
    if (names.has(name)) return key;
  }
  throw requestError(`Stored CIC target references a non-portable constant: ${name || '(empty)'}.`);
}

function mappedPortableName(value, language, qualified = false) {
  const key = portableName(value);
  if (language === 'coq') {
    const coqName = {
      True: 'True',
      False: 'False',
      Eq: 'eq',
      And: 'and',
      Or: 'or',
      Iff: 'iff',
      Not: 'not'
    }[key];
    return qualified ? `Coq.Init.Logic.${coqName}` : coqName;
  }
  return qualified ? `_root_.${key}` : key;
}

function isName(value, names) {
  return names.includes(nameLeaf(value).toLowerCase());
}

function renderSort(term) {
  const direct = String(field(term, ['name', 'value', 'sort']) || '').trim().toLowerCase();
  const level = field(term, ['level']);
  const rawLevel = isPlainObject(level) && level.kind === 'raw-level' ? level.value : null;
  const rawText = typeof rawLevel === 'string' ? rawLevel.trim().toLowerCase() : '';
  const nestedKind = isPlainObject(rawLevel) ? String(rawLevel.kind || '').trim().toLowerCase() : '';
  if (direct === 'prop' || rawText === 'prop' || rawText === 'sprop' || nestedKind === 'zero') {
    return 'Prop';
  }
  throw requestError('Stored CIC target uses a universe sort outside the portable Prop fragment.');
}

function renderTerm(term, language, environment = [], options = {}) {
  const scope = Array.isArray(environment) ? environment : [];
  if (term === null || term === undefined) throw requestError('Stored CIC target is empty.');
  if (typeof term === 'string') {
    throw requestError('Stored CIC target contains raw text instead of normalized CIC nodes.');
  }
  if (!isPlainObject(term)) throw requestError('Stored CIC target has an unsupported node.');

  const kind = nodeKind(term);
  if (['raw', 'raw-text', 'text', 'evar', 'cast', 'case', 'fix', 'cofix', 'proj', 'literal', 'lit', 'construct'].includes(kind)) {
    throw requestError(`Stored CIC target uses a non-portable node: ${kind}.`);
  }
  if (kind === 'sort') return renderSort(term);
  if (kind === 'var' || kind === 'local') {
    throw requestError('Stored CIC target contains an unbound named variable.');
  }
  if (kind === 'rel' || kind === 'debruijn' || kind === 'db') {
    const index = Number(field(term, ['index', 'idx', 'value']));
    if (Number.isFinite(index) && index >= 0 && index < scope.length) return scope[scope.length - 1 - index];
    throw requestError('Stored CIC target contains an out-of-scope de Bruijn variable.');
  }
  if (['const', 'constant', 'ind', 'inductive'].includes(kind)) {
    return mappedPortableName(
      field(term, ['name', 'id', 'ident', 'value', 'path']),
      language,
      options.qualified === true
    );
  }
  if (kind === 'app' || kind === 'application') {
    const fn = field(term, ['fn', 'func', 'function', 'head', 'callee', 'operator']);
    const rawArgs = field(term, ['args', 'arguments', 'params']);
    if (!fn) throw requestError('Stored CIC application has no function.');
    const argTerms = Array.isArray(rawArgs) ? rawArgs : [];
    const fnName = field(fn, ['name', 'id', 'ident', 'value', 'path']);
    if (isName(fn, ['eq']) && argTerms.length >= 2) {
      portableName(fnName);
      const [left, right] = argTerms.slice(-2)
        .map((arg) => renderTerm(arg, language, scope, options));
      return options.qualified === true
        ? `(${mappedPortableName(fnName, language, true)} ${left} ${right})`
        : `(${left} = ${right})`;
    }
    const args = argTerms.map((arg) => renderTerm(arg, language, scope, options));
    if (isName(fn, ['and', 'or', 'iff']) && args.length === 2) {
      return `(${mappedPortableName(fnName, language, options.qualified === true)} ${args[0]} ${args[1]})`;
    }
    if (isName(fn, ['not']) && args.length === 1) {
      return `(${mappedPortableName(fnName, language, options.qualified === true)} ${args[0]})`;
    }
    throw requestError('Stored CIC target contains an application outside the portable logical fragment.');
  }
  if (kind === 'prod' || kind === 'forall' || kind === 'pi') {
    const name = sanitizeIdentifier(field(term, ['name', 'binder', 'varName']), `x${scope.length}`);
    const type = field(term, ['type', 'domain', 'argType']);
    const body = field(term, ['body', 'codomain', 'result']);
    if (!type || !body) throw requestError('Stored CIC forall is incomplete.');
    const typeCode = renderTerm(type, language, scope, options);
    const bodyCode = renderTerm(body, language, scope.concat(name), options);
    return language === 'coq'
      ? `(forall ${name} : ${typeCode}, ${bodyCode})`
      : `(forall (${name} : ${typeCode}), ${bodyCode})`;
  }
  if (kind === 'lambda' || kind === 'lam') {
    const name = sanitizeIdentifier(field(term, ['name', 'binder', 'varName']), `x${scope.length}`);
    const type = field(term, ['type', 'domain', 'argType']);
    const body = field(term, ['body', 'result']);
    if (!type || !body) throw requestError('Stored CIC lambda is incomplete.');
    const typeCode = renderTerm(type, language, scope, options);
    const bodyCode = renderTerm(body, language, scope.concat(name), options);
    return `(fun ${language === 'coq' ? `${name} : ${typeCode}` : `(${name} : ${typeCode})`} => ${bodyCode})`;
  }
  if (kind === 'let' || kind === 'letin') {
    const name = sanitizeIdentifier(field(term, ['name', 'binder', 'varName']), `x${scope.length}`);
    const type = field(term, ['type', 'annotation']);
    const value = field(term, ['value', 'expr', 'definition']);
    const body = field(term, ['body', 'result']);
    if (!value || !body) throw requestError('Stored CIC let is incomplete.');
    const typePart = type ? ` : ${renderTerm(type, language, scope, options)}` : '';
    const valueCode = renderTerm(value, language, scope, options);
    const bodyCode = renderTerm(body, language, scope.concat(name), options);
    return language === 'coq'
      ? `(let ${name}${typePart} := ${valueCode} in ${bodyCode})`
      : `(let ${name}${typePart} := ${valueCode}; ${bodyCode})`;
  }
  throw requestError(`Stored CIC target uses unsupported node: ${kind || 'unknown'}.`);
}

export function assertPortableCicTarget(term) {
  renderTerm(term, 'lean');
  renderTerm(term, 'coq');
  return term;
}

export function buildCicBindingGuard(language, source, term) {
  const expression = renderTerm(term, language, [], { qualified: true });
  if (language === 'coq') {
    return [
      String(source || '').trimEnd(),
      '',
      `Definition provf_cic_expected_target : Prop := ${expression}.`,
      'Definition provf_cic_binding_guard',
      '  : @Coq.Init.Logic.eq Prop provf_problem_target provf_cic_expected_target',
      '  := @Coq.Init.Logic.eq_refl Prop provf_problem_target.',
      ''
    ].join('\n');
  }
  return [
    String(source || '').trimEnd(),
    '',
    `def provf_cic_expected_target : Prop := ${expression}`,
    'theorem provf_cic_binding_guard',
    '  : _root_.Eq provf_problem_target provf_cic_expected_target := rfl',
    ''
  ].join('\n');
}

export function assertTrustedCicRecord(record, options = {}) {
  if (!isPlainObject(record)) throw requestError('Trusted CIC record is missing.');
  if (String(record.verification_status || '').toLowerCase() !== 'verified') {
    throw requestError('The proof row does not have trusted server verification.');
  }
  if (String(record.normalized_format || '').toLowerCase() !== 'cic-v1') {
    throw requestError('The proof row does not contain a trusted cic-v1 target.');
  }
  const term = unwrapTerm(record.normalized_term);
  if (!isPlainObject(term)) throw requestError('The trusted CIC target is missing.');
  if (options.requirePortable === true) assertPortableCicTarget(term);

  const meta = isPlainObject(record.request_meta) ? record.request_meta : {};
  const cicTarget = isPlainObject(meta.cicTarget) ? meta.cicTarget : null;
  const targetHash = hashCicTarget(term);
  if (
    !cicTarget
    || Number(cicTarget.version) !== 1
    || cicTarget.source !== 'server-recomputed-context.type'
    || cicTarget.sha256 !== targetHash
  ) {
    throw requestError('The CIC row predates trusted target verification and must be re-verified.');
  }

  const adapterMeta = isPlainObject(record.adapter_meta) ? record.adapter_meta : {};
  const adapterContext = isPlainObject(adapterMeta.context) ? adapterMeta.context : {};
  if (!isPlainObject(adapterContext.type) || stableStringify(adapterContext.type) !== stableStringify(term)) {
    throw requestError('The stored CIC target does not match the server conversion context.');
  }

  if (options.requireAssumptionAudit === true) {
    const verification = isPlainObject(record.verification_result) ? record.verification_result : {};
    const sourcePolicy = isPlainObject(verification.sourcePolicy) ? verification.sourcePolicy : null;
    const audit = sourcePolicy && isPlainObject(sourcePolicy.assumptionAudit)
      ? sourcePolicy.assumptionAudit
      : null;
    if (
      !audit
      || !String(audit.target || '').trim()
      || !Array.isArray(audit.assumptions)
      || !Array.isArray(audit.unexpectedAssumptions)
    ) {
      throw requestError('The proof row does not contain a trusted kernel assumption audit.');
    }
    if (String(record.proof_state || '').toUpperCase() === 'YY' && audit.unexpectedAssumptions.length > 0) {
      throw requestError('The proof row contains unexpected kernel assumptions.');
    }
  }

  return { term, targetHash };
}

function stripCommentsAndStrings(language, source) {
  return language === 'coq'
    ? String(source || '').replace(/\(\*[\s\S]*?\*\)/g, ' ').replace(/"([^"\\]|\\.)*"/g, '""')
    : String(source || '').replace(/\/-[\s\S]*?-\//g, ' ').replace(/--.*$/gm, ' ').replace(/"([^"\\]|\\.)*"/g, '""');
}

function compactExpression(value) {
  return String(value || '').replace(/\s+/g, '');
}

function assertSourceTarget(language, source, expectedExpression) {
  const cleaned = stripCommentsAndStrings(language, source);
  const compact = compactExpression(cleaned);
  const expected = compactExpression(expectedExpression).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = language === 'coq'
    ? new RegExp(`Definitionprovf_problem_target:Prop:=${expected}\\.`, 'g')
    : new RegExp(`defprovf_problem_target:Prop:=${expected}(?=theorem|lemma|$)`, 'g');
  if ([...compact.matchAll(declaration)].length !== 1) {
    throw requestError('The submitted proof target does not match the selected problem.');
  }
  const provesTarget = language === 'coq'
    ? /\b(?:Theorem|Lemma)\s+(?:provf_solution|provf_problem_solution)\s*:\s*provf_problem_target\s*\./i.test(cleaned)
    : /\btheorem\s+(?:provf_solution|provf_problem_solution)\s*:\s*provf_problem_target\s*:=/i.test(cleaned);
  if (!provesTarget) throw requestError('The submitted proof must close provf_solution for provf_problem_target.');
}

function assertConditionalSelection(originalMeta, solveContext) {
  const storedIds = new Set((Array.isArray(originalMeta.conditionals) ? originalMeta.conditionals : [])
    .map((item) => String(item && item.conditionalProblemId || '').trim())
    .filter(Boolean));
  for (const selected of Array.isArray(solveContext.selectedConditionals) ? solveContext.selectedConditionals : []) {
    const id = String(selected && selected.conditionalProblemId || '').trim();
    if (!id || !storedIds.has(id)) throw requestError('A selected Conditional is not registered on the target problem.');
  }
}

export function assertProblemProofBinding(originalProblem, solutionRecord) {
  const meta = isPlainObject(solutionRecord && solutionRecord.request_meta) ? solutionRecord.request_meta : {};
  const solveContext = isPlainObject(meta.solveContext) ? meta.solveContext : null;
  if (!solveContext || !solveContext.problemId) return null;
  if (!originalProblem || String(originalProblem.id) !== String(solveContext.problemId)) {
    throw requestError('The submitted proof is bound to a different problem.');
  }
  if (String(originalProblem.proof_state || '').toUpperCase() !== 'NY') {
    throw requestError('Only an unresolved problem can receive a solution.', 409);
  }
  const originalEnvelope = assertTrustedCicRecord(originalProblem, { requirePortable: true });
  assertTrustedCicRecord(solutionRecord);
  const storedTerm = originalEnvelope.term;
  const submittedTerm = unwrapTerm(solveContext.normalizedTerm);
  if (!isPlainObject(storedTerm) || !isPlainObject(submittedTerm) || stableStringify(storedTerm) !== stableStringify(submittedTerm)) {
    throw requestError('The submitted CIC target does not match the stored problem target.');
  }
  const originalMeta = isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {};
  const storedHash = originalEnvelope.targetHash;

  const language = String(solutionRecord.language || '').trim().toLowerCase();
  if (!['coq', 'lean'].includes(language)) throw requestError('Problem solutions require Coq or Lean.');
  assertSourceTarget(language, solutionRecord.source_code, renderTerm(storedTerm, language));
  assertConditionalSelection(originalMeta, solveContext);
  return { language, storedTerm, targetHash: storedHash };
}
