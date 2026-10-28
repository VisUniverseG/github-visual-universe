/**
 * Minimal read-only GitHub REST client.
 *
 * It can only issue GET requests, only to https://api.github.com, and never follows redirects.
 * The bearer token is attached here and nowhere else. Errors carry a fixed `kind` and status,
 * never response bodies.
 */

export const GITHUB_API_ORIGIN = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;

export type GitHubErrorKind =
  'unauthorized' | 'rate_limited' | 'forbidden' | 'http' | 'network' | 'invalid_response';

export class GitHubApiError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | undefined;
  /** Epoch milliseconds at which a rate limit resets, when GitHub told us. */
  readonly resetAt: number | undefined;

  constructor(kind: GitHubErrorKind, details: { status?: number; resetAt?: number } = {}) {
    super(`GitHub API error: ${kind}`);
    this.name = 'GitHubApiError';
    this.kind = kind;
    this.status = details.status;
    this.resetAt = details.resetAt;
  }
}

/** What GitHub says about the request budget after a response. Nothing else is exposed. */
export interface GitHubRateLimit {
  /** Requests left in the current window. */
  readonly remaining: number;
  /** Epoch milliseconds at which the window resets; `null` when GitHub did not say. */
  readonly resetAt: number | null;
}

export interface GitHubPage<T> {
  readonly data: T;
  /** Absolute URL of the next page, validated to be on api.github.com; `null` on the last page. */
  readonly nextUrl: string | null;
  /** `null` when the response carried no readable rate-limit headers. */
  readonly rateLimit: GitHubRateLimit | null;
}

/** Resolves a path or absolute URL and refuses anything that is not https://api.github.com. */
export function resolveGitHubUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input, GITHUB_API_ORIGIN);
  } catch {
    throw new GitHubApiError('invalid_response');
  }
  if (url.origin !== GITHUB_API_ORIGIN || url.username || url.password) {
    throw new GitHubApiError('invalid_response');
  }
  return url;
}

/** Extracts `rel="next"` from a Link header, accepting only api.github.com URLs. */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="?next"?\s*$/.exec(part);
    if (match?.[1]) {
      try {
        return resolveGitHubUrl(match[1]).href;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Reads `x-ratelimit-remaining` / `x-ratelimit-reset`; a missing or malformed pair is `null`. */
export function parseRateLimit(headers: Headers): GitHubRateLimit | null {
  const rawRemaining = headers.get('x-ratelimit-remaining');
  // `Number(null)` and `Number('')` are 0, which would read as "exhausted": require real digits.
  if (rawRemaining === null || !/^\d{1,9}$/.test(rawRemaining.trim())) return null;
  const rawReset = headers.get('x-ratelimit-reset');
  const reset = rawReset !== null && /^\d{1,12}$/.test(rawReset.trim()) ? Number(rawReset) : 0;
  return {
    remaining: Number(rawRemaining),
    resetAt: reset > 0 ? reset * 1000 : null,
  };
}

/**
 * When a rate limit ends, in epoch milliseconds. `retry-after` (seconds from now) comes first: it
 * is what GitHub asks for, and for a secondary limit `x-ratelimit-reset` describes the primary
 * window, which may end much later. A missing or unusable `retry-after` falls back to
 * `x-ratelimit-reset` (epoch seconds). With neither, there is no time to report.
 */
function rateLimitReset(headers: Headers): number | undefined {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  return undefined;
}

function classifyFailure(res: Response): GitHubApiError {
  if (res.status === 401) return new GitHubApiError('unauthorized', { status: 401 });
  const limited =
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
  if (limited) {
    const resetAt = rateLimitReset(res.headers);
    return new GitHubApiError('rate_limited', {
      status: res.status,
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }
  if (res.status === 403) return new GitHubApiError('forbidden', { status: 403 });
  return new GitHubApiError('http', { status: res.status });
}

export async function githubGet<T>(
  pathOrUrl: string,
  accessToken: string,
  parse: (json: unknown) => T,
  signal?: AbortSignal,
): Promise<GitHubPage<T>> {
  const url = resolveGitHubUrl(pathOrUrl);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
      },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GitHubApiError('network');
  }

  // A 401 is surfaced as-is; the caller ends the session. There is no retry or refresh in the
  // browser (the refresh token is never stored here).
  if (!res.ok) throw classifyFailure(res);

  // Reading the body can fail for two different reasons. A broken connection or the timeout while
  // the body is still arriving is a network problem and asking again may work; text that is not
  // JSON is something GitHub sent and asking again will not fix. An abort by the caller is theirs
  // to handle, exactly as in the request above.
  let body: unknown;
  try {
    body = await res.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new GitHubApiError(isSyntaxError(error) ? 'invalid_response' : 'network');
  }

  try {
    return {
      data: parse(body),
      nextUrl: parseNextLink(res.headers.get('link')),
      rateLimit: parseRateLimit(res.headers),
    };
  } catch {
    throw new GitHubApiError('invalid_response');
  }
}

/** `JSON.parse` failures. Matched by name, because the error may come from another realm. */
function isSyntaxError(error: unknown): boolean {
  return error instanceof Error && error.name === 'SyntaxError';
}
