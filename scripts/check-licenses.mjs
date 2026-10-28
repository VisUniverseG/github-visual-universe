#!/usr/bin/env node
// Dependency license review gate.
//
// Reads every installed package's declared license from node_modules and fails
// if any is not on the allow-list below (or explicitly excepted, with a reason,
// in scripts/license-exceptions.json). SPDX "A OR B" expressions pass when at
// least one alternative is allowed; "A AND B" requires every term to be allowed.
//
// This is an automated first-pass review, not legal advice.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Permissive licenses compatible with distributing this MIT project. */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'Python-2.0',
  'Unlicense',
]);

const exceptionsPath = join(root, 'scripts', 'license-exceptions.json');
/** @type {Record<string, string>} package name (or "prefix*") -> justification */
const exceptions = existsSync(exceptionsPath)
  ? JSON.parse(readFileSync(exceptionsPath, 'utf8'))
  : {};

/** @param {string} name */
function isExcepted(name) {
  return Object.keys(exceptions).some((key) =>
    key.endsWith('*') ? name.startsWith(key.slice(0, -1)) : name === key,
  );
}

/** @param {string} dir */
function* packageDirs(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      yield* packageDirs(full);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      if (existsSync(join(full, 'package.json'))) yield full;
      yield* packageDirs(join(full, 'node_modules'));
    }
  }
}

/** @param {unknown} pkg */
function declaredLicense(pkg) {
  if (typeof pkg !== 'object' || pkg === null) return undefined;
  const p = /** @type {Record<string, unknown>} */ (pkg);
  if (typeof p.license === 'string') return p.license;
  if (typeof p.license === 'object' && p.license !== null) {
    const t = /** @type {Record<string, unknown>} */ (p.license).type;
    if (typeof t === 'string') return t;
  }
  if (Array.isArray(p.licenses)) {
    const types = p.licenses
      .map((l) => (typeof l === 'object' && l !== null ? l.type : undefined))
      .filter((t) => typeof t === 'string');
    if (types.length > 0) return `(${types.join(' OR ')})`;
  }
  return undefined;
}

/** Evaluate a (simple) SPDX expression against the allow-list. */
function isAllowed(expression) {
  const tokens = expression
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  // Split on OR into alternatives; each alternative is a conjunction (AND).
  const alternatives = [[]];
  for (const token of tokens) {
    if (token === 'OR') alternatives.push([]);
    else if (token === 'AND') continue;
    else alternatives[alternatives.length - 1].push(token.replace(/\+$/, ''));
  }
  return alternatives.some((terms) => terms.length > 0 && terms.every((t) => ALLOWED.has(t)));
}

const seen = new Map(); // "name@version" -> license
for (const dir of packageDirs(join(root, 'node_modules'))) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (typeof pkg.name !== 'string') continue;
  if (pkg.name.startsWith('@gvu/')) continue; // our own workspace packages (symlinks)
  seen.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, license: declaredLicense(pkg) });
}

const problems = [];
const summary = new Map();
for (const [id, { name, license }] of seen) {
  const label = license ?? 'UNKNOWN';
  summary.set(label, (summary.get(label) ?? 0) + 1);
  if (isExcepted(name)) continue;
  if (!license || !isAllowed(license)) problems.push(`${id}: ${label}`);
}

console.log(`Checked ${String(seen.size)} installed packages.`);
for (const [license, count] of [...summary].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${license}`);
}

if (problems.length > 0) {
  console.error('\nPackages needing license review:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nIf a license is acceptable, add the package to scripts/license-exceptions.json with a justification.',
  );
  process.exit(1);
}
console.log('\nLicense check passed.');
