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

export interface GitHubPage<T> {
  readonly data: T;
  /** Absolute URL of the next page, validated to be on api.github.com; `null` on the last page. */
  readonly nextUrl: string | null;
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

function rateLimitReset(headers: Headers): number | undefined {
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return reset * 1000;
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000;
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

  try {
    return {
      data: parse((await res.json()) as unknown),
      nextUrl: parseNextLink(res.headers.get('link')),
    };
  } catch {
    throw new GitHubApiError('invalid_response');
  }
}
