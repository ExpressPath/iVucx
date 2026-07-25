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
  } catch (error) {
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

function mapName(value, language) {
  const leaf = nameLeaf(value);
  const key = leaf.toLowerCase();
  if (key === 'true') return 'True';
  if (key === 'false') return 'False';
  if (key === 'prop') return 'Prop';
  if (key === 'type') return 'Type';
  if (key === 'eq') return language === 'coq' ? 'eq' : 'Eq';
  if (key === 'and') return language === 'coq' ? 'and' : 'And';
  if (key === 'or') return language === 'coq' ? 'or' : 'Or';
  if (key === 'iff') return language === 'coq' ? 'iff' : 'Iff';
  if (key === 'not') return language === 'coq' ? 'not' : 'Not';
  return sanitizeIdentifier(leaf || rawName(value), 'cic_const');
}

function isName(value, names) {
  return names.includes(nameLeaf(value).toLowerCase());
}

function renderTerm(term, language, environment = []) {
  const scope = Array.isArray(environment) ? environment : [];
  if (term === null || term === undefined) throw requestError('Stored CIC target is empty.');
  if (typeof term === 'string') {
    const raw = term.trim();
    if (!raw || /\b(Theorem|Lemma|Definition|Fixpoint|Axiom|Parameter|Variable|Inductive|Qed|Admitted|admit|sorry)\b/i.test(raw)) {
      throw requestError('Stored CIC target is not a safe expression.');
    }
    return raw;
  }
  if (typeof term === 'number' || typeof term === 'boolean') return String(term);
  if (!isPlainObject(term)) throw requestError('Stored CIC target has an unsupported node.');

  const kind = nodeKind(term);
  if (['raw', 'raw-text', 'text'].includes(kind)) return renderTerm(field(term, ['value', 'text', 'raw']), language, scope);
  if (kind === 'sort') return /type/i.test(String(field(term, ['name', 'value', 'sort']) || 'Prop')) ? 'Type' : 'Prop';
  if (kind === 'var' || kind === 'local') return sanitizeIdentifier(field(term, ['name', 'id', 'ident', 'value']), 'x');
  if (kind === 'rel' || kind === 'debruijn' || kind === 'db') {
    const index = Number(field(term, ['index', 'idx', 'value']));
    if (Number.isFinite(index) && index >= 0 && index < scope.length) return scope[scope.length - 1 - index];
    return sanitizeIdentifier(field(term, ['name', 'value']), `x${Number.isFinite(index) ? index : ''}`);
  }
  if (['const', 'constant', 'ind', 'inductive'].includes(kind)) return mapName(field(term, ['name', 'id', 'ident', 'value', 'path']), language);
  if (kind === 'lit' || kind === 'literal') return renderTerm(field(term, ['value', 'text']), language, scope);
  if (kind === 'app' || kind === 'application') {
    const fn = field(term, ['fn', 'func', 'function', 'head', 'callee', 'operator']);
    const rawArgs = field(term, ['args', 'arguments', 'params']);
    const args = (Array.isArray(rawArgs) ? rawArgs : []).map((arg) => renderTerm(arg, language, scope));
    if (!fn) throw requestError('Stored CIC application has no function.');
    if (isName(fn, ['eq']) && args.length >= 2) return `(${args[0]} = ${args[1]})`;
    if (isName(fn, ['and']) && args.length >= 2) return `(${language === 'coq' ? 'and' : 'And'} ${args[0]} ${args[1]})`;
    if (isName(fn, ['or']) && args.length >= 2) return `(${language === 'coq' ? 'or' : 'Or'} ${args[0]} ${args[1]})`;
    if (isName(fn, ['iff']) && args.length >= 2) return `(${language === 'coq' ? 'iff' : 'Iff'} ${args[0]} ${args[1]})`;
    if (isName(fn, ['not']) && args.length >= 1) return `(${language === 'coq' ? 'not' : 'Not'} ${args[0]})`;
    return `(${[renderTerm(fn, language, scope), ...args].join(' ')})`;
  }
  if (kind === 'prod' || kind === 'forall' || kind === 'pi') {
    const name = sanitizeIdentifier(field(term, ['name', 'binder', 'varName']), `x${scope.length}`);
    const type = field(term, ['type', 'domain', 'argType']);
    const body = field(term, ['body', 'codomain', 'result']);
    if (!type || !body) throw requestError('Stored CIC forall is incomplete.');
    const typeCode = renderTerm(type, language, scope);
    const bodyCode = renderTerm(body, language, scope.concat(name));
    return language === 'coq'
      ? `(forall ${name} : ${typeCode}, ${bodyCode})`
      : `(forall (${name} : ${typeCode}), ${bodyCode})`;
  }
  if (kind === 'lambda' || kind === 'lam') {
    const name = sanitizeIdentifier(field(term, ['name', 'binder', 'varName']), `x${scope.length}`);
    const type = field(term, ['type', 'domain', 'argType']);
    const body = field(term, ['body', 'result']);
    if (!type || !body) throw requestError('Stored CIC lambda is incomplete.');
    const typeCode = renderTerm(type, language, scope);
    const bodyCode = renderTerm(body, language, scope.concat(name));
    return `(fun ${language === 'coq' ? `${name} : ${typeCode}` : `(${name} : ${typeCode})`} => ${bodyCode})`;
  }
  if (kind === 'let' || kind === 'letin') {
    const name = sanitizeIdentifier(field(term, ['name', 'binder', 'varName']), `x${scope.length}`);
    const type = field(term, ['type', 'annotation']);
    const value = field(term, ['value', 'expr', 'definition']);
    const body = field(term, ['body', 'result']);
    if (!value || !body) throw requestError('Stored CIC let is incomplete.');
    const typePart = type ? ` : ${renderTerm(type, language, scope)}` : '';
    const valueCode = renderTerm(value, language, scope);
    const bodyCode = renderTerm(body, language, scope.concat(name));
    return language === 'coq'
      ? `(let ${name}${typePart} := ${valueCode} in ${bodyCode})`
      : `(let ${name}${typePart} := ${valueCode}; ${bodyCode})`;
  }
  for (const key of ['raw', 'value', 'text', 'sourceText']) {
    if (Object.prototype.hasOwnProperty.call(term, key)) return renderTerm(term[key], language, scope);
  }
  if (Object.prototype.hasOwnProperty.call(term, 'name')) return mapName(term.name, language);
  throw requestError(`Stored CIC target uses unsupported node: ${kind || 'unknown'}.`);
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
  if (!solveContext || !solveContext.problemId) return;
  if (!originalProblem || String(originalProblem.id) !== String(solveContext.problemId)) {
    throw requestError('The submitted proof is bound to a different problem.');
  }
  if (String(originalProblem.proof_state || '').toUpperCase() !== 'NY') {
    throw requestError('Only an unresolved problem can receive a solution.', 409);
  }

  const storedTerm = unwrapTerm(originalProblem.normalized_term);
  const submittedTerm = unwrapTerm(solveContext.normalizedTerm);
  if (!isPlainObject(storedTerm) || !isPlainObject(submittedTerm) || stableStringify(storedTerm) !== stableStringify(submittedTerm)) {
    throw requestError('The submitted CIC target does not match the stored problem target.');
  }

  const language = String(solutionRecord.language || '').trim().toLowerCase();
  if (!['coq', 'lean'].includes(language)) throw requestError('Problem solutions require Coq or Lean.');
  assertSourceTarget(language, solutionRecord.source_code, renderTerm(storedTerm, language));
  assertConditionalSelection(isPlainObject(originalProblem.request_meta) ? originalProblem.request_meta : {}, solveContext);
}
