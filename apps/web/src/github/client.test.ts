import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch } from '../testing/fakeFetch.ts';
import {
  GITHUB_API_ORIGIN,
  GitHubApiError,
  githubGet,
  parseNextLink,
  resolveGitHubUrl,
} from './client.ts';

const identity = (json: unknown) => json;

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe('githubGet', () => {
  it('sends a credential-less, read-only GET with the bearer token', async () => {
    const net = stubGitHub(() => Response.json({ ok: 1 }));
    const page = await githubGet('/thing', TEST_TOKEN, identity);

    expect(page).toEqual({ data: { ok: 1 }, nextUrl: null });
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

  it('never includes the token or response body in an error message', async () => {
    stubGitHub(() => Response.json({ message: `leak ${TEST_TOKEN}` }, { status: 500 }));
    const error = await githubGet('/thing', TEST_TOKEN, identity).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(TEST_TOKEN);
    expect((error as Error).message).not.toContain('leak');
  });
});
