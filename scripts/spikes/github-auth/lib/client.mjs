// Minimal, safety-first HTTP client for the spike harness.
//
// Properties (all covered by tests):
//  - every request is validated by `assertAllowedRequest` before it is sent
//  - redirects are never followed (a token must not follow a redirect to another host)
//  - no automatic retries; a 401 or a rate-limit response stops the whole run
//  - a hard request budget shared by all clients in a run
//  - response bodies are parsed but never returned as raw text, so callers cannot
//    accidentally print them

import { API_ORIGIN, SafetyError, assertAllowedRequest, redact } from './safety.mjs';

export class HaltError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'HaltError';
  }
}

export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

export function createBudget(max) {
  return { used: 0, max };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createClient({
  token = null,
  origin = API_ORIGIN,
  allowedOrigins = [API_ORIGIN],
  budget,
  delayMs = 250,
  timeoutMs = 15_000,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
}) {
  let haltReason = null;
  const secrets = token ? [token] : [];

  async function request(method, path, { body, headers = {} } = {}) {
    if (haltReason) throw new HaltError(`stopped earlier: ${haltReason}`);
    if (budget.used >= budget.max) {
      throw new BudgetError(`request budget of ${budget.max} exhausted`);
    }
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new SafetyError('request path must start with a single "/"');
    }
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'authorization') {
        throw new SafetyError('callers may not set the Authorization header');
      }
    }

    const url = new URL(path, origin).toString();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    assertAllowedRequest(
      { method, url, body: payload, hasCredentials: token !== null },
      allowedOrigins,
    );

    if (budget.used > 0 && delayMs > 0) await sleep(delayMs);
    budget.used += 1;

    const finalHeaders = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gvu-auth-spike (local read-only harness)',
      ...headers,
    };
    if (token) finalHeaders.Authorization = `Bearer ${token}`;
    if (payload !== undefined) finalHeaders['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: finalHeaders,
        body: payload,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = error?.cause?.code ?? error?.name ?? 'unknown error';
      // Only `.message` is ever printed by callers; the cause is kept for debugging.
      throw new Error(`network error: ${redact(detail, secrets)}`, { cause: error });
    }

    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    const remaining = response.headers.get('x-ratelimit-remaining');
    if (token !== null && response.status === 401) {
      haltReason =
        'received 401 (token invalid, expired or revoked); not retrying to avoid a credential lockout';
    } else if (
      (response.status === 403 || response.status === 429) &&
      (response.headers.has('retry-after') || remaining === '0')
    ) {
      haltReason = 'rate limit or secondary rate limit reached; not retrying';
    }

    return { status: response.status, headers: response.headers, json };
  }

  return {
    get: (path, options) => request('GET', path, options),
    options: (path, options) => request('OPTIONS', path, options),
    graphql: (query, variables = {}) => request('POST', '/graphql', { body: { query, variables } }),
    get haltReason() {
      return haltReason;
    },
  };
}
