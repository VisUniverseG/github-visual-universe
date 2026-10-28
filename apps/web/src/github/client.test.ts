import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch } from '../testing/fakeFetch.ts';
import {
  GITHUB_API_ORIGIN,
  GitHubApiError,
  githubGet,
  parseNextLink,
  parseRateLimit,
  resolveGitHubUrl,
} from './client.ts';

const identity = (json: unknown) => json;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A real, successful response whose body fails (or is read) in the way the test says. */
function withBody(json: () => Promise<unknown>): Response {
  return Object.assign(new Response('{}'), { json });
}

function stubGitHub(respond: () => Response) {
  const net = createFakeFetch({ [`GET ${GITHUB_API_ORIGIN}/thing`]: respond });
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

describe('resolveGitHubUrl', () => {
  it('resolves paths against api.github.com', () => {
    expect(resolveGitHubUrl('/user/installations?per_page=100').href).toBe(
      'https://api.github.com/user/installations?per_page=100',
    );
  });

  it.each([
    'https://evil.example/user',
    'http://api.github.com/user',
    'https://api.github.com.evil.example/user',
    'https://user:pw@api.github.com/user',
    '//evil.example/x',
  ])('refuses %s', (target) => {
    expect(() => resolveGitHubUrl(target)).toThrow(GitHubApiError);
  });
});

describe('parseNextLink', () => {
  it('finds rel="next" among several links', () => {
    const header =
      '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe('https://api.github.com/x?page=3');
  });

  it('returns null when there is no next page', () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"')).toBeNull();
  });

  it('refuses a next link that points off api.github.com', () => {
    expect(parseNextLink('<https://evil.example/steal>; rel="next"')).toBeNull();
  });
});

describe('parseRateLimit', () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  it('reads the remaining count and the reset time in milliseconds', () => {
    expect(
      parseRateLimit(
        headers({ 'x-ratelimit-remaining': '4986', 'x-ratelimit-reset': '1800000000' }),
      ),
    ).toEqual({ remaining: 4986, resetAt: 1_800_000_000_000 });
  });

  it('keeps a remaining count of zero (exhausted) distinct from missing headers', () => {
    expect(parseRateLimit(headers({ 'x-ratelimit-remaining': '0' }))).toEqual({
      remaining: 0,
      resetAt: null,
    });
    expect(parseRateLimit(headers({}))).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['not a number', 'lots'],
    ['hex', '0x10'],
    ['absurdly long', '9'.repeat(20)],
  ])('treats a %s remaining value as unreadable', (_name, value) => {
    expect(parseRateLimit(headers({ 'x-ratelimit-remaining': value }))).toBeNull();
  });

  it('ignores a malformed reset time but keeps the remaining count', () => {
    expect(
      parseRateLimit(headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': 'soon' })),
    ).toEqual({ remaining: 10, resetAt: null });
  });
});

describe('githubGet', () => {
  it('exposes the rate limit on a successful response and nothing else from the headers', async () => {
    stubGitHub(
      () =>
        new Response('{}', {
          headers: {
            'x-ratelimit-remaining': '42',
            'x-ratelimit-reset': '1800000000',
            'x-ratelimit-limit': '5000',
            'x-github-request-id': 'secret-ish',
          },
        }),
    );
    const page = await githubGet('/thing', TEST_TOKEN, identity);
    expect(page.rateLimit).toEqual({ remaining: 42, resetAt: 1_800_000_000_000 });
    expect(JSON.stringify(page)).not.toContain('secret-ish');
  });

  it('sends a credential-less, read-only GET with the bearer token', async () => {
    const net = stubGitHub(() => Response.json({ ok: 1 }));
    const page = await githubGet('/thing', TEST_TOKEN, identity);

    expect(page).toEqual({ data: { ok: 1 }, nextUrl: null, rateLimit: null });
    const sent = net.requests[0];
    expect(sent?.method).toBe('GET');
    expect(sent?.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    expect(sent?.init.credentials).toBe('omit');
    expect(sent?.init.redirect).toBe('error');
    expect(sent?.init.body).toBeUndefined();
  });

  it('never sends the token to a non-GitHub URL', async () => {
    const net = stubGitHub(() => Response.json({}));
    await expect(
      githubGet('https://evil.example/thing', TEST_TOKEN, identity),
    ).rejects.toBeInstanceOf(GitHubApiError);
    expect(net.requests).toHaveLength(0);
  });

  it('follows pagination only through validated Link headers', async () => {
    stubGitHub(
      () =>
        new Response('[]', {
          headers: { Link: '<https://api.github.com/thing?page=2>; rel="next"' },
        }),
    );
    const page = await githubGet('/thing', TEST_TOKEN, identity);
    expect(page.nextUrl).toBe('https://api.github.com/thing?page=2');
  });

  it('reports 401 as unauthorized', async () => {
    stubGitHub(() => Response.json({ message: 'Bad credentials' }, { status: 401 }));
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'unauthorized',
      status: 401,
    });
  });

  it('reports a primary rate limit (403 with remaining 0) with the reset time', async () => {
    stubGitHub(
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1900000000' },
        }),
    );
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'rate_limited',
      resetAt: 1_900_000_000_000,
    });
  });

  it('reports a secondary rate limit (retry-after) and 429', async () => {
    stubGitHub(() => new Response('{}', { status: 403, headers: { 'retry-after': '30' } }));
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    stubGitHub(() => new Response('{}', { status: 429 }));
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  describe('retry-after and x-ratelimit-reset', () => {
    const NOW = 1_700_000_000_000;
    const RESET_SECONDS = 1_800_000_000;

    async function resetAtFor(status: number, headers: Record<string, string>) {
      vi.spyOn(Date, 'now').mockReturnValue(NOW);
      stubGitHub(() => new Response('{}', { status, headers }));
      const error = await githubGet('/thing', TEST_TOKEN, identity).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ kind: 'rate_limited' });
      return (error as GitHubApiError).resetAt;
    }

    it('prefers retry-after (seconds from now) when both headers are present', async () => {
      expect(
        await resetAtFor(429, {
          'retry-after': '30',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(RESET_SECONDS),
        }),
      ).toBe(NOW + 30_000);
      expect(
        await resetAtFor(403, {
          'retry-after': '90',
          'x-ratelimit-reset': String(RESET_SECONDS),
        }),
      ).toBe(NOW + 90_000);
    });

    it.each([
      ['not a number', 'soon'],
      ['empty', ''],
      ['zero', '0'],
      ['negative', '-5'],
      ['infinite', 'Infinity'],
    ])('falls back to x-ratelimit-reset when retry-after is %s', async (_name, value) => {
      expect(
        await resetAtFor(429, {
          'retry-after': value,
          'x-ratelimit-reset': String(RESET_SECONDS),
        }),
      ).toBe(RESET_SECONDS * 1000);
    });

    it('uses x-ratelimit-reset alone, in epoch seconds', async () => {
      expect(
        await resetAtFor(403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(RESET_SECONDS),
        }),
      ).toBe(RESET_SECONDS * 1000);
    });

    it('uses retry-after alone', async () => {
      expect(await resetAtFor(429, { 'retry-after': '60' })).toBe(NOW + 60_000);
    });

    it('invents no time when neither header is usable', async () => {
      expect(await resetAtFor(429, {})).toBeUndefined();
      expect(
        await resetAtFor(429, { 'retry-after': 'soon', 'x-ratelimit-reset': 'later' }),
      ).toBeUndefined();
      expect(
        await resetAtFor(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }),
      ).toBeUndefined();
    });
  });

  it('distinguishes a plain 403 and other HTTP errors', async () => {
    stubGitHub(() => new Response('{}', { status: 403 }));
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    stubGitHub(() => new Response('{}', { status: 500 }));
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'http',
      status: 500,
    });
  });

  it('reports network failures and malformed bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'network',
    });

    stubGitHub(() => new Response('not json'));
    await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
      kind: 'invalid_response',
    });

    stubGitHub(() => Response.json({}));
    await expect(
      githubGet('/thing', TEST_TOKEN, () => {
        throw new Error('schema mismatch');
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  describe('a response body that cannot be read', () => {
    it('reports a read that breaks off (TypeError) as a network failure, which can be retried', async () => {
      stubGitHub(() => withBody(() => Promise.reject(new TypeError('terminated'))));
      const error = await githubGet('/thing', TEST_TOKEN, identity).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ kind: 'network' });
      expect((error as Error).message).not.toContain('terminated');
    });

    it('reports the timeout firing while the body arrives as a network failure', async () => {
      stubGitHub(() =>
        withBody(() => Promise.reject(new DOMException('Timed out', 'TimeoutError'))),
      );
      await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
        kind: 'network',
      });
    });

    it('passes the cancellation through when the caller aborted during the read', async () => {
      const controller = new AbortController();
      const aborted = new DOMException('Aborted', 'AbortError');
      stubGitHub(() =>
        withBody(() => {
          controller.abort();
          return Promise.reject(aborted);
        }),
      );
      const error = await githubGet('/thing', TEST_TOKEN, identity, controller.signal).catch(
        (e: unknown) => e,
      );
      expect(error).toBe(aborted);
      expect(error).not.toBeInstanceOf(GitHubApiError);
    });

    it('still reports a body that is not JSON as an invalid response', async () => {
      stubGitHub(() => withBody(() => Promise.reject(new SyntaxError('Unexpected token'))));
      await expect(githubGet('/thing', TEST_TOKEN, identity)).rejects.toMatchObject({
        kind: 'invalid_response',
      });
    });

    it('still reports a body the schema refuses as an invalid response', async () => {
      stubGitHub(() => Response.json({ unexpected: true }));
      await expect(
        githubGet('/thing', TEST_TOKEN, () => {
          throw new TypeError('schema says no');
        }),
      ).rejects.toMatchObject({ kind: 'invalid_response' });
    });
  });

  it('never includes the token or response body in an error message', async () => {
    stubGitHub(() => Response.json({ message: `leak ${TEST_TOKEN}` }, { status: 500 }));
    const error = await githubGet('/thing', TEST_TOKEN, identity).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(TEST_TOKEN);
    expect((error as Error).message).not.toContain('leak');
  });
});
