import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import { loadRepositoryTree } from './tree.ts';

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

  it('reports a truncated listing instead of presenting it as complete', async () => {
    useNetwork({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
        Response.json(treeBody([entry('a', 'blob', 1)], true)),
    });
    expect((await loadRepositoryTree(TEST_TOKEN, TARGET)).truncated).toBe(true);
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
