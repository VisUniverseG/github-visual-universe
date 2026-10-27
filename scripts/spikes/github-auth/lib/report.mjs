import { redact } from './safety.mjs';
import { NOT_TESTABLE_HERE } from '../checks/index.mjs';

export const VERDICT_ORDER = [
  'CRITICAL',
  'UNEXPECTED',
  'FIXTURE_ERROR',
  'ERROR',
  'ABORTED',
  'PASS',
  'INFO',
  'SKIPPED',
];

export function countVerdicts(entries) {
  const counts = {};
  for (const verdict of VERDICT_ORDER) counts[verdict] = 0;
  for (const entry of entries) counts[entry.verdict] = (counts[entry.verdict] ?? 0) + 1;
  return counts;
}

export function exitCodeFor(entries) {
  if (entries.some((e) => e.verdict === 'CRITICAL')) return 1;
  if (entries.some((e) => e.verdict === 'ABORTED' || e.verdict === 'ERROR')) return 3;
  return 0;
}

/** Maps each open question (U1..U11, S1..S6) to the checks that gathered evidence for it. */
export function evidenceByQuestion(entries) {
  const evidence = {};
  for (const entry of entries) {
    if (entry.verdict === 'SKIPPED' || entry.verdict === 'ABORTED') continue;
    for (const question of entry.resolves ?? []) {
      (evidence[question] ??= []).push(`${entry.id}:${entry.verdict}`);
    }
  }
  return evidence;
}

export function buildResult({ label, tokens, entries, requests }) {
  return {
    label,
    tokens,
    counts: countVerdicts(entries),
    exitCode: exitCodeFor(entries),
    entries,
    evidence: evidenceByQuestion(entries),
    requests,
    notTestableHere: NOT_TESTABLE_HERE,
  };
}

export function renderJson(result, secrets) {
  return redact(JSON.stringify(result, null, 2), secrets);
}

export function renderText(result, secrets) {
  const lines = [];
  lines.push(
    `GVU GitHub authorization spike  label=${result.label}  tokenA=${result.tokens.A ?? '-'}  tokenB=${result.tokens.B ?? '-'}`,
  );
  lines.push(`requests used: ${result.requests.total}`);
  lines.push('');
  for (const entry of result.entries) {
    lines.push(`[${entry.verdict}] ${entry.id}  ${entry.title}`);
    if (entry.expected !== undefined) lines.push(`    expected: ${JSON.stringify(entry.expected)}`);
    if (entry.observed && Object.keys(entry.observed).length > 0) {
      lines.push(`    observed: ${JSON.stringify(entry.observed)}`);
    }
    if (entry.note) lines.push(`    note: ${entry.note}`);
  }
  lines.push('');
  lines.push(
    `summary: ${VERDICT_ORDER.filter((v) => result.counts[v] > 0)
      .map((v) => `${v}=${result.counts[v]}`)
      .join('  ')}`,
  );
  lines.push('');
  lines.push('evidence collected per open question (evidence, not conclusions):');
  const questions = Object.keys(result.evidence).sort();
  if (questions.length === 0) lines.push('  (none)');
  for (const question of questions)
    lines.push(`  ${question}: ${result.evidence[question].join(', ')}`);
  lines.push('');
  lines.push('NOT testable by this harness (remain unresolved):');
  for (const item of result.notTestableHere) lines.push(`  - ${item}`);
  return redact(lines.join('\n'), secrets);
}

export function renderDryRun(plan, secrets) {
  const lines = [];
  lines.push('DRY RUN: no network requests are made.');
  lines.push(
    `tokens: A=${plan.tokens.A ?? 'not set'}  B=${plan.tokens.B ?? 'not set'}  (fingerprints only)`,
  );
  lines.push(
    `fixtures: ${Object.entries(plan.fixtures)
      .map(([name, present]) => `${name}=${present ? 'set' : 'not set'}`)
      .join('  ')}`,
  );
  lines.push(`request budget: ${plan.maxRequests}`);
  lines.push('');
  let total = 0;
  for (const item of plan.checks) {
    total += item.maxRequests;
    const status = item.missing.length
      ? `WOULD SKIP (missing ${item.missing.join(', ')})`
      : 'would run';
    lines.push(`${item.id}  ${item.title}`);
    lines.push(`    ${status}; up to ${item.maxRequests} request(s)`);
    for (const step of item.plan) lines.push(`      - ${step}`);
  }
  lines.push('');
  lines.push(`worst case total (if nothing is skipped): ${total} request(s)`);
  return redact(lines.join('\n'), secrets);
}
