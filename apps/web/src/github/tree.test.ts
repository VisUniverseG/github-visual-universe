import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import { GitHubApiError } from './client.ts';
import { loadRepositoryTree, loadTreeListing } from './tree.ts';

const GH = 'https://api.github.com';
const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const TARGET = { owner: 'octo', name: 'alpha', defaultBranch: 'main' };

afterEach(() => {
  vi.unstubAllGlobals();
});

const branchBody = () => ({
  name: 'main',
  commit: { sha: COMMIT, commit: { tree: { sha: TREE } } },
});
const entry = (path: string, type: string, size?: number) => ({
  path,
  mode: type === 'tree' ? '040000' : '100644',
  type,
  sha: 'e'.repeat(40),
  ...(size === undefined ? {} : { size }),
});
const treeBody = (tree: unknown[], truncated = false) => ({ sha: TREE, truncated, tree });

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`GET ${GH}/repos/octo/alpha/branches/main`]: () => Response.json(branchBody()),
    [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
      Response.json(treeBody([entry('src', 'tree'), entry('src/a.ts', 'blob', 42)])),
    ...overrides,
  };
}

function useNetwork(overrides: Record<string, Handler> = {}) {
  const net = createFakeFetch(routes(overrides));
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

describe('loadRepositoryTree', () => {
  it('resolves the default branch to its tree, then reads the recursive tree', async () => {
    const net = useNetwork();

    const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);

    expect(tree).toMatchObject({
      branch: 'main',
      commitSha: COMMIT,
      treeSha: TREE,
      skipped: 0,
      truncated: false,
    });
    expect(tree.entries.map((e) => `${e.type}:${e.path}`)).toEqual(['tree:src', 'blob:src/a.ts']);
    expect(net.requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`)).toEqual([
      'GET /repos/octo/alpha/branches/main',
      `GET /repos/octo/alpha/git/trees/${TREE}?recursive=1`,
    ]);
  });

  it('only issues authenticated GETs to api.github.com', async () => {
    const net = useNetwork();
    await loadRepositoryTree(TEST_TOKEN, TARGET);
    expect(net.requests.every((r) => r.method === 'GET')).toBe(true);
    expect(net.requests.every((r) => r.url.origin === GH)).toBe(true);
    expect(
      net.requests.every((r) => r.headers.get('authorization') === `Bearer ${TEST_TOKEN}`),
    ).toBe(true);
    expect(net.requests.every((r) => r.init.credentials === 'omit')).toBe(true);
  });

  it('asks GitHub for the default branch only when the list did not provide one', async () => {
    const net = useNetwork({
      [`GET ${GH}/repos/octo/alpha`]: () => Response.json({ default_branch: 'main', id: 1 }),
    });

    const tree = await loadRepositoryTree(TEST_TOKEN, { ...TARGET, defaultBranch: null });

    expect(tree.branch).toBe('main');
    expect(net.requests.map((r) => r.url.pathname)).toEqual([
      '/repos/octo/alpha',
      '/repos/octo/alpha/branches/main',
      `/repos/octo/alpha/git/trees/${TREE}`,
    ]);
  });

  it('treats a blank default branch like a missing one', async () => {
    const net = useNetwork({
      [`GET ${GH}/repos/octo/alpha`]: () => Response.json({ default_branch: 'main' }),
    });
    await loadRepositoryTree(TEST_TOKEN, { ...TARGET, defaultBranch: '  ' });
    expect(net.requests[0]?.url.pathname).toBe('/repos/octo/alpha');
  });

  it('encodes a branch name that contains a slash', async () => {
    const net = useNetwork({
      [`GET ${GH}/repos/octo/alpha/branches/release%2F1.x`]: () => Response.json(branchBody()),
    });
    const tree = await loadRepositoryTree(TEST_TOKEN, { ...TARGET, defaultBranch: 'release/1.x' });
    expect(tree.branch).toBe('release/1.x');
    expect(net.requests[0]?.url.pathname).toBe('/repos/octo/alpha/branches/release%2F1.x');
  });

  it('marks a complete recursive listing as complete, with its rate limit', async () => {
    useNetwork({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
        Response.json(treeBody([entry('a', 'blob', 1)]), {
          headers: { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1800000000' },
        }),
    });
    const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);
    expect(tree.mode).toBe('complete');
    expect(tree.truncated).toBe(false);
    expect(tree.rateLimit).toEqual({ remaining: 4000, resetAt: 1_800_000_000_000 });
  });

  describe('when the recursive listing is truncated', () => {
    /** Recursive: a cut-off listing. Non-recursive: the root's direct children. */
    const truncatedRoutes = (
      root: unknown[] = [entry('src', 'tree'), entry('a.txt', 'blob', 5)],
    ) => ({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: (request: { url: URL }) =>
        request.url.searchParams.has('recursive')
          ? Response.json(treeBody([entry('src', 'tree'), entry('src/a.ts', 'blob', 42)], true))
          : Response.json(treeBody(root), { headers: { 'x-ratelimit-remaining': '123' } }),
    });

    it('discards it and returns the root from a non-recursive request in lazy mode', async () => {
      const net = useNetwork(truncatedRoutes());

      const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);

      expect(tree).toMatchObject({
        mode: 'lazy',
        branch: 'main',
        commitSha: COMMIT,
        treeSha: TREE,
        truncated: true,
        rootTruncated: false,
        skipped: 0,
        rateLimit: { remaining: 123, resetAt: null },
      });
      // Nothing from the truncated recursive response survives (no `src/a.ts`).
      expect(tree.entries.map((e) => `${e.type}:${e.path}`)).toEqual(['tree:src', 'blob:a.txt']);
      expect(net.requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`)).toEqual([
        'GET /repos/octo/alpha/branches/main',
        `GET /repos/octo/alpha/git/trees/${TREE}?recursive=1`,
        `GET /repos/octo/alpha/git/trees/${TREE}`,
      ]);
    });

    it('keeps the SHAs of folders so they can be listed later', async () => {
      useNetwork(truncatedRoutes());
      const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);
      expect(tree.entries[0]).toMatchObject({ path: 'src', type: 'tree', sha: 'e'.repeat(40) });
    });

    it('reports when even the root listing is truncated', async () => {
      useNetwork({
        [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
          Response.json(treeBody([entry('a', 'blob', 1)], true)),
      });
      const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);
      expect(tree).toMatchObject({ mode: 'lazy', truncated: true, rootTruncated: true });
    });

    it('counts root entries that contradict a direct-children listing', async () => {
      useNetwork(truncatedRoutes([entry('a.txt', 'blob', 1), entry('deep/b.txt', 'blob', 1)]));
      const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);
      expect(tree.entries.map((e) => e.path)).toEqual(['a.txt']);
      expect(tree.skipped).toBe(1);
    });

    it('surfaces a failure of the root request instead of falling back to the cut-off data', async () => {
      useNetwork({
        [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: (request: { url: URL }) =>
          request.url.searchParams.has('recursive')
            ? Response.json(treeBody([entry('a', 'blob', 1)], true))
            : new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      });
      await expect(loadRepositoryTree(TEST_TOKEN, TARGET)).rejects.toMatchObject({
        kind: 'rate_limited',
      });
    });

    it('only issues GETs to api.github.com', async () => {
      const net = useNetwork(truncatedRoutes());
      await loadRepositoryTree(TEST_TOKEN, TARGET);
      expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
    });
  });

  it('counts entries it cannot read', async () => {
    useNetwork({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
        Response.json(treeBody([entry('a', 'blob', 1), entry('b', 'future-kind'), { nope: 1 }])),
    });
    const tree = await loadRepositoryTree(TEST_TOKEN, TARGET);
    expect(tree.entries).toHaveLength(1);
    expect(tree.skipped).toBe(2);
  });

  it.each([
    ['an empty repository (409)', 409, 'http'],
    ['a missing branch or no access (404)', 404, 'http'],
    ['a refused request (403)', 403, 'forbidden'],
    ['an expired token (401)', 401, 'unauthorized'],
  ])('surfaces %s from the tree request', async (_name, status, kind) => {
    useNetwork({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
        new Response('{"message":"details are never echoed"}', { status }),
    });
    await expect(loadRepositoryTree(TEST_TOKEN, TARGET)).rejects.toMatchObject({ kind, status });
  });

  it('surfaces a missing branch from the branch request', async () => {
    const net = useNetwork({
      [`GET ${GH}/repos/octo/alpha/branches/main`]: () => new Response('{}', { status: 404 }),
    });
    await expect(loadRepositoryTree(TEST_TOKEN, TARGET)).rejects.toMatchObject({ status: 404 });
    // It stops there: no tree request is made.
    expect(net.requests).toHaveLength(1);
  });

  it('reports a rate limit', async () => {
    useNetwork({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
        new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    });
    await expect(loadRepositoryTree(TEST_TOKEN, TARGET)).rejects.toMatchObject({
      kind: 'rate_limited',
    });
  });

  it.each([
    ['a branch response without a tree', { commit: { sha: COMMIT, commit: {} } }],
    [
      'a branch response with a non-hex tree SHA',
      { commit: { sha: COMMIT, commit: { tree: { sha: '../x' } } } },
    ],
  ])('rejects %s', async (_name, body) => {
    const net = useNetwork({
      [`GET ${GH}/repos/octo/alpha/branches/main`]: () => Response.json(body),
    });
    await expect(loadRepositoryTree(TEST_TOKEN, TARGET)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(net.requests).toHaveLength(1);
  });

  it('rejects a tree response that breaks the contract', async () => {
    useNetwork({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () => Response.json({ tree: [] }),
    });
    await expect(loadRepositoryTree(TEST_TOKEN, TARGET)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it.each([
    ['dot-dot owner', { ...TARGET, owner: '..' }],
    ['path in the name', { ...TARGET, name: 'a/../../user' }],
    ['query in the name', { ...TARGET, name: 'a?x=1' }],
    ['empty owner', { ...TARGET, owner: '' }],
    ['dot name', { ...TARGET, name: '.' }],
  ])('makes no request for an unsafe repository (%s)', async (_name, target) => {
    const net = useNetwork();
    await expect(loadRepositoryTree(TEST_TOKEN, target)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
    expect(net.requests).toHaveLength(0);
  });

  it('never follows a redirect (the client refuses them)', async () => {
    const net = useNetwork();
    await loadRepositoryTree(TEST_TOKEN, TARGET);
    expect(net.requests.every((r) => r.init.redirect === 'error')).toBe(true);
  });
});

describe('loadTreeListing', () => {
  const REPO = { owner: 'octo', name: 'alpha' };
  const SUB = 'f'.repeat(40);
  const SUB_ROUTE = `GET ${GH}/repos/octo/alpha/git/trees/${SUB}`;
  const subBody = (tree: unknown[], truncated = false, sha = SUB) => ({ sha, truncated, tree });

  const listing = (overrides: Record<string, Handler> = {}) => {
    const net = createFakeFetch({
      [SUB_ROUTE]: () =>
        Response.json(subBody([entry('a.ts', 'blob', 3), entry('lib', 'tree')]), {
          headers: { 'x-ratelimit-remaining': '77', 'x-ratelimit-reset': '1800000000' },
        }),
      ...overrides,
    });
    vi.stubGlobal('fetch', net.fetch);
    return net;
  };

  it('requests a non-recursive listing with no query string at all', async () => {
    const net = listing();
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });

    expect(net.requests.map((r) => `${r.method} ${r.url.pathname}${r.url.search}`)).toEqual([
      `GET /repos/octo/alpha/git/trees/${SUB}`,
    ]);
    // GitHub treats any `recursive` value (even 0) as true, so none may be sent.
    expect(net.requests[0]?.url.searchParams.has('recursive')).toBe(false);
    expect(result).toMatchObject({ sha: SUB, recursive: false, truncated: false, skipped: 0 });
    expect(result.entries.map((e) => e.path)).toEqual(['a.ts', 'lib']);
  });

  it('requests a recursive listing with ?recursive=1', async () => {
    const net = listing({
      [SUB_ROUTE]: () =>
        Response.json(subBody([entry('lib', 'tree'), entry('lib/x.ts', 'blob', 1)])),
    });
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: true });

    expect(net.requests.map((r) => `${r.url.pathname}${r.url.search}`)).toEqual([
      `/repos/octo/alpha/git/trees/${SUB}?recursive=1`,
    ]);
    expect(result.recursive).toBe(true);
    // Nested paths are expected (and kept) in a recursive listing.
    expect(result.entries.map((e) => e.path)).toEqual(['lib', 'lib/x.ts']);
  });

  it('reports the rate limit from the response', async () => {
    listing();
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });
    expect(result.rateLimit).toEqual({ remaining: 77, resetAt: 1_800_000_000_000 });
  });

  it('reports no rate limit when GitHub sent none', async () => {
    listing({ [SUB_ROUTE]: () => Response.json(subBody([])) });
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });
    expect(result.rateLimit).toBeNull();
  });

  it.each([true, false])('reports truncation explicitly (recursive: %s)', async (recursive) => {
    listing({ [SUB_ROUTE]: () => Response.json(subBody([entry('a', 'blob', 1)], true)) });
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  it('rejects a response without the truncated flag', async () => {
    listing({ [SUB_ROUTE]: () => Response.json({ sha: SUB, tree: [] }) });
    await expect(
      loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('rejects a response for a different tree than the one requested', async () => {
    listing({ [SUB_ROUTE]: () => Response.json(subBody([], false, 'a'.repeat(40))) });
    await expect(
      loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('leaves out, and counts, direct-children entries whose path contains a slash', async () => {
    listing({
      [SUB_ROUTE]: () =>
        Response.json(subBody([entry('ok.ts', 'blob', 1), entry('x/y.ts', 'blob', 1)])),
    });
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });
    expect(result.entries.map((e) => e.path)).toEqual(['ok.ts']);
    expect(result.skipped).toBe(1);
  });

  it('adds unreadable entries to the skipped count', async () => {
    listing({
      [SUB_ROUTE]: () =>
        Response.json(subBody([entry('a', 'blob', 1), entry('b', 'future-kind'), { nope: 1 }])),
    });
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });
    expect(result.skipped).toBe(2);
  });

  it('keeps submodule and symlink entries as they are, for the caller to treat as leaves', async () => {
    listing({
      [SUB_ROUTE]: () =>
        Response.json(
          subBody([
            { path: 'vendor', type: 'commit', mode: '160000', sha: 'a'.repeat(40) },
            { path: 'link', type: 'blob', mode: '120000', sha: 'b'.repeat(40), size: 6 },
          ]),
        ),
    });
    const result = await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });
    expect(result.entries.map((e) => [e.path, e.type, e.mode])).toEqual([
      ['vendor', 'commit', '160000'],
      ['link', 'blob', '120000'],
    ]);
  });

  describe('SHA validation', () => {
    it.each([
      ['a 40-character SHA-1', 'a'.repeat(40), true],
      ['a 64-character SHA-256', 'b'.repeat(64), true],
      ['an empty string', '', false],
      ['a short hex string', 'abc123', false],
      ['upper-case hex', 'A'.repeat(40), false],
      ['non-hex characters', 'z'.repeat(40), false],
      ['a path traversal', '../../user', false],
      ['a SHA with a query', `${'a'.repeat(40)}?recursive=1`, false],
      ['a SHA with a path suffix', `${'a'.repeat(40)}/../../user`, false],
      ['a SHA with a fragment', `${'a'.repeat(40)}#x`, false],
      ['a SHA with a trailing newline', `${'a'.repeat(40)}\n`, false],
      ['a SHA with an encoded slash', `${'a'.repeat(37)}%2f..`, false],
    ])('%s', async (_name, sha, valid) => {
      const net = createFakeFetch({
        [`GET ${GH}/repos/octo/alpha/git/trees/${sha}`]: () =>
          Response.json(subBody([], false, sha)),
      });
      vi.stubGlobal('fetch', net.fetch);

      const result = loadTreeListing(TEST_TOKEN, REPO, sha, { recursive: false });
      if (valid) {
        await expect(result).resolves.toMatchObject({ sha });
        expect(net.requests).toHaveLength(1);
      } else {
        await expect(result).rejects.toMatchObject({ kind: 'invalid_response' });
        // An invalid SHA must never reach the network.
        expect(net.requests).toHaveLength(0);
      }
    });

    it.each([true, false])(
      'makes no request for an invalid SHA (recursive: %s)',
      async (recursive) => {
        const net = listing();
        await expect(
          loadTreeListing(TEST_TOKEN, REPO, 'not-a-sha', { recursive }),
        ).rejects.toMatchObject({ kind: 'invalid_response' });
        expect(net.requests).toHaveLength(0);
      },
    );
  });

  it.each([
    ['dot-dot owner', { owner: '..', name: 'alpha' }],
    ['path in the name', { owner: 'octo', name: 'a/../../user' }],
    ['query in the name', { owner: 'octo', name: 'a?x=1' }],
    ['empty owner', { owner: '', name: 'alpha' }],
  ])('makes no request for an unsafe repository (%s)', async (_name, repository) => {
    const net = listing();
    await expect(
      loadTreeListing(TEST_TOKEN, repository, SUB, { recursive: false }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(net.requests).toHaveLength(0);
  });

  it('only issues authenticated, credential-less GETs to api.github.com, never following redirects', async () => {
    const net = listing();
    await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false });
    await loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: true });

    expect(net.requests).toHaveLength(2);
    for (const request of net.requests) {
      expect(request.method).toBe('GET');
      expect(request.url.origin).toBe(GH);
      expect(request.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
      expect(request.init.credentials).toBe('omit');
      expect(request.init.redirect).toBe('error');
      expect(request.init.body).toBeUndefined();
    }
  });

  it.each([
    ['an expired token (401)', 401, 'unauthorized'],
    ['a rate limit (429)', 429, 'rate_limited'],
    ['a vanished tree (404)', 404, 'http'],
  ])('surfaces %s', async (_name, status, kind) => {
    listing({ [SUB_ROUTE]: () => new Response('{"message":"never echoed"}', { status }) });
    await expect(
      loadTreeListing(TEST_TOKEN, REPO, SUB, { recursive: false }),
    ).rejects.toMatchObject({ kind, status });
  });

  it('passes the abort signal through, and an aborted request is not reported as a GitHub error', async () => {
    const net = listing({
      [SUB_ROUTE]: (request) => {
        if (request.init.signal?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        return Response.json(subBody([]));
      },
    });
    const controller = new AbortController();
    controller.abort();

    const error: unknown = await loadTreeListing(TEST_TOKEN, REPO, SUB, {
      recursive: false,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error).not.toBeInstanceOf(GitHubApiError);
    expect(net.requests.every((r) => r.init.signal?.aborted === true)).toBe(true);
  });
});
