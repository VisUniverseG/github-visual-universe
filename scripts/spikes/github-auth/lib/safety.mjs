// Safety layer for the local-only GitHub authorization spike harness.
//
// Everything that touches the network goes through `assertAllowedRequest`, and every
// token goes through `assertUserToken`. These checks are deliberately strict and are
// covered by tests in ../test/safety.test.mjs.

import { createHash } from 'node:crypto';

export const API_ORIGIN = 'https://api.github.com';

export class SafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafetyError';
  }
}

// Matches every GitHub token shape we know of, so nothing token-like can reach the output.
const TOKEN_PATTERN = /(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g;

/** Removes known secrets and anything token-shaped from a string. */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 8) {
      out = out.split(secret).join('[REDACTED]');
    }
  }
  return out.replace(TOKEN_PATTERN, '[REDACTED]');
}

const REJECTED_PREFIXES = [
  ['github_pat_', 'a fine-grained personal access token'],
  ['ghp_', 'a classic personal access token'],
  ['gho_', 'an OAuth App token'],
  ['ghs_', 'an installation access token'],
  ['ghr_', 'a refresh token (this harness must never handle refresh tokens)'],
];

/**
 * Accepts only GitHub App *user access tokens* (`ghu_`). Error messages never contain
 * the supplied value.
 */
export function assertUserToken(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new SafetyError(`${name} is not set`);
  }
  if (value !== value.trim()) {
    throw new SafetyError(`${name} has leading or trailing whitespace`);
  }
  for (const [prefix, kind] of REJECTED_PREFIXES) {
    if (value.startsWith(prefix)) {
      throw new SafetyError(
        `${name} is ${kind}. This spike only accepts GitHub App user access tokens (ghu_...)`,
      );
    }
  }
  if (!/^ghu_[A-Za-z0-9_]{20,255}$/.test(value)) {
    throw new SafetyError(`${name} does not look like a GitHub App user access token (ghu_...)`);
  }
  return value;
}

/** Short, non-reversible identifier so a human can tell tokens apart without seeing them. */
export function fingerprint(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 8);
}

const BLOCKED_PATH_PARTS = ['/applications/', '/authorizations', '/login/', '/app/installations/'];

/** GraphQL is the only POST we allow, and only for queries. */
export function assertReadOnlyGraphQL(body) {
  let parsed;
  try {
    parsed = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    throw new SafetyError('GraphQL body is not valid JSON');
  }
  const query = parsed?.query;
  if (typeof query !== 'string') {
    throw new SafetyError('GraphQL body has no query string');
  }
  // Deliberately conservative: the words are rejected anywhere, even in comments or strings.
  if (/\b(mutation|subscription)\b/i.test(query)) {
    throw new SafetyError('GraphQL mutations and subscriptions are forbidden (read-only harness)');
  }
  if (!/^\s*(query\b|\{)/.test(query)) {
    throw new SafetyError('GraphQL document must start with `query` or a selection set');
  }
}

/**
 * Throws unless the request is one the harness is allowed to make:
 *  - only to an allow-listed origin (api.github.com in production use)
 *  - GET / HEAD anywhere; OPTIONS only without credentials (CORS preflights)
 *  - POST only to /graphql and only for queries
 */
export function assertAllowedRequest({ method, url, body, hasCredentials }, allowedOrigins) {
  const verb = String(method).toUpperCase();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafetyError('request URL is not valid');
  }
  if (parsed.username || parsed.password) {
    throw new SafetyError('credentials in URLs are forbidden');
  }
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new SafetyError(`origin ${parsed.origin} is not allowed`);
  }
  const path = parsed.pathname.toLowerCase();
  if (BLOCKED_PATH_PARTS.some((part) => path.includes(part))) {
    throw new SafetyError(`path ${parsed.pathname} is not allowed`);
  }
  if (verb === 'GET' || verb === 'HEAD') return;
  if (verb === 'OPTIONS') {
    if (hasCredentials) throw new SafetyError('OPTIONS requests must never carry credentials');
    return;
  }
  if (verb === 'POST' && path === '/graphql') {
    assertReadOnlyGraphQL(body);
    return;
  }
  throw new SafetyError(`${verb} ${parsed.pathname} is not allowed (read-only harness)`);
}
