import { randomBytes } from 'crypto';

const AUDIT_TARGET_PATTERN = /^[A-Za-z_][A-Za-z0-9_'.]*$/;

function stripCoqCommentsAndStrings(input) {
  return String(input || '')
    .replace(/\(\*[\s\S]*?\*\)/g, ' ')
    .replace(/"([^"\\]|\\.)*"/g, '""');
}

function stripLeanCommentsAndStrings(input) {
  return String(input || '')
    .replace(/\/-[\s\S]*?-\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/"([^"\\]|\\.)*"/g, '""');
}

function lastMatch(source, pattern) {
  let found = '';
  for (const match of source.matchAll(pattern)) {
    found = String(match[1] || '').trim();
  }
  return found;
}

export function findProofAuditTarget(language, code, solveContext = null) {
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  const source = normalizedLanguage === 'coq'
    ? stripCoqCommentsAndStrings(code)
    : stripLeanCommentsAndStrings(code);
  const boundSolution = solveContext && String(solveContext.problemId || '').trim();

  if (boundSolution) {
    const candidates = ['provf_problem_solution', 'provf_solution'];
    for (const candidate of candidates) {
      const pattern = normalizedLanguage === 'coq'
        ? new RegExp(`\\b(?:Theorem|Lemma)\\s+(${candidate})\\s*:`, 'i')
        : new RegExp(`\\btheorem\\s+(${candidate})\\s*:`, 'i');
      const match = source.match(pattern);
      if (match) return match[1];
    }
    return '';
  }

  const target = normalizedLanguage === 'coq'
    ? lastMatch(
        source,
        /(?:^|\n)\s*(?:Local\s+|Global\s+|Program\s+|Polymorphic\s+|Monomorphic\s+|Cumulative\s+|NonCumulative\s+)*(?:Theorem|Lemma|Fact|Remark|Corollary|Proposition|Definition|Fixpoint|Let)\s+([A-Za-z_][A-Za-z0-9_']*)\b/g
      )
    : lastMatch(
        source,
        /(?:^|\n)\s*(?:@[A-Za-z0-9_.]+\s+)*(?:(?:private|protected|noncomputable|local|scoped)\s+)*(?:theorem|lemma|def|abbrev|opaque)\s+([A-Za-z_][A-Za-z0-9_']*)\b/g
      );

  return AUDIT_TARGET_PATTERN.test(target) ? target : '';
}

export function buildProofAssumptionAudit(language, code, target) {
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  const safeTarget = String(target || '').trim();
  if (!AUDIT_TARGET_PATTERN.test(safeTarget)) {
    throw new Error('A safe proof declaration could not be selected for the assumption audit.');
  }
  const nonce = randomBytes(16).toString('hex');
  const startMarker = `IVUCX_ASSUMPTION_AUDIT_START_${nonce}`;
  const endMarker = `IVUCX_ASSUMPTION_AUDIT_END_${nonce}`;
  const commands = normalizedLanguage === 'coq'
    ? [
        'Goal Coq.Init.Logic.True.',
        `  idtac "${startMarker}".`,
        '  exact Coq.Init.Logic.I.',
        'Qed.',
        `Print Assumptions ${safeTarget}.`,
        'Goal Coq.Init.Logic.True.',
        `  idtac "${endMarker}".`,
        '  exact Coq.Init.Logic.I.',
        'Qed.'
      ]
    : [
        `theorem ${startMarker} : _root_.True := _root_.True.intro`,
        `#check ${startMarker}`,
        `#print axioms ${safeTarget}`,
        `theorem ${endMarker} : _root_.True := _root_.True.intro`,
        `#check ${endMarker}`
      ];
  return {
    code: `${String(code || '').trimEnd()}\n\n${commands.join('\n')}\n`,
    startMarker,
    endMarker
  };
}

function uniqueNames(values) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean))).sort();
}

export function parseProofAssumptions(language, output, markers = null) {
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  let text = String(output || '').replace(/\r/g, '');
  if (markers && markers.startMarker && markers.endMarker) {
    const start = text.lastIndexOf(markers.startMarker);
    const end = start >= 0 ? text.indexOf(markers.endMarker, start + markers.startMarker.length) : -1;
    if (start < 0 || end < 0) return { recognized: false, assumptions: [] };
    text = text.slice(start + markers.startMarker.length, end);
  }

  if (normalizedLanguage === 'lean') {
    if (/\bdoes not depend on any axioms\b/i.test(text)) {
      return { recognized: true, assumptions: [] };
    }
    const matches = Array.from(text.matchAll(/\bdepends on axioms\s*:\s*\[([^\]]*)\]/gi));
    if (!matches.length) return { recognized: false, assumptions: [] };
    const raw = matches[matches.length - 1][1];
    const assumptions = raw
      .split(',')
      .map((name) => name.trim().replace(/^['"`]+|['"`]+$/g, ''))
      .filter((name) => AUDIT_TARGET_PATTERN.test(name));
    return { recognized: true, assumptions: uniqueNames(assumptions) };
  }

  if (/\bClosed under the global context\b/i.test(text)) {
    return { recognized: true, assumptions: [] };
  }
  const marker = text.lastIndexOf('Axioms:');
  if (marker < 0) return { recognized: false, assumptions: [] };
  const section = text.slice(marker + 'Axioms:'.length);
  const assumptions = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_'.]*)\s*:/);
    if (match) assumptions.push(match[1]);
  }
  return { recognized: true, assumptions: uniqueNames(assumptions) };
}

export function allowedConditionalAssumptionNames(solveContext) {
  const selected = solveContext && Array.isArray(solveContext.selectedConditionals)
    ? solveContext.selectedConditionals
    : [];
  return new Set(selected.map((conditional, index) => {
    const key = String(
      conditional && (
        conditional.conditionalProblemId
        || conditional.postedAt
        || conditional.conditionalTitle
      )
      || index
    ).trim();
    return `provf_conditional_${key}`
      .replace(/[^A-Za-z0-9_']/g, '_')
      .replace(/^[^A-Za-z_]+/, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  }).filter(Boolean));
}
