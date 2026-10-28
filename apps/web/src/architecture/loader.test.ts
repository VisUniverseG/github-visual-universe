import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubApiError } from '../github/client.ts';
import type { RepositoryTree, TreeListing, loadTreeListing } from '../github/tree.ts';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import {
  FixtureTree,
  blob,
  completeTreeOf,
  dirEntry,
  fakeSha,
  lazyTreeOf,
  submodule,
  symlink,
} from '../testing/treeFixtures.ts';
import {
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DirectoryLoader,
  type DirectoryLoaderOptions,
  type LoaderSnapshot,
} from './loader.ts';
import { TreeStore, type TreeNode, type TreeSnapshot } from './store.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

const GH = 'https://api.github.com';
const REPOSITORY = { owner: 'octo', name: 'alpha' };
const FAR_FUTURE_SECONDS = 2_000_000_000; // the year 2033
const NOW = 1_900_000_000_000; // a fixed "now" before it

/**
 *   README.md 100 B
 *   docs/guide.md 1,000 B
 *   src/index.ts 300 B
 *   src/util/math.ts 50 B
 *   empty/
 */
const REPO = new FixtureTree([
  blob('README.md', 100),
  dirEntry('src'),
  blob('src/index.ts', 300),
  dirEntry('src/util'),
  blob('src/util/math.ts', 50),
  dirEntry('docs'),
  blob('docs/guide.md', 1000),
  dirEntry('empty'),
]);

const treeRoute = (sha: string) => `GET ${GH}/repos/octo/alpha/git/trees/${sha}`;

const listingBody = (fixture: FixtureTree, path: string) => ({
  sha: fixture.shaOf(path),
  truncated: false,
  tree: fixture.listing(path).entries,
});

const okResponse = (fixture: FixtureTree, path: string, headers: Record<string, string> = {}) =>
  Response.json(listingBody(fixture, path), {
    headers: {
      'x-ratelimit-remaining': '4000',
      'x-ratelimit-reset': String(FAR_FUTURE_SECONDS),
      ...headers,
    },
  });

/** A route for every folder of the fixture, each answering with its own direct listing. */
function routesFor(
  fixture: FixtureTree,
  overrides: Record<string, Handler> = {},
): Record<string, Handler> {
  const routes: Record<string, Handler> = {};
  for (const path of fixture.directories()) {
    routes[treeRoute(fixture.shaOf(path))] = () => okResponse(fixture, path);
  }
  return { ...routes, ...overrides };
}

function network(fixture: FixtureTree, overrides: Record<string, Handler> = {}) {
  const net = createFakeFetch(routesFor(fixture, overrides));
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

/** A request that waits until `release()`, and fails if it is aborted first. */
function gated(respond: () => Response, options: { honourAbort?: boolean } = {}) {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: Handler = async (request) => {
    const signal = request.init.signal;
    if (options.honourAbort !== false && signal) {
      await Promise.race([
        opened,
        new Promise<void>((_resolve, reject) => {
          const abort = () => {
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } else {
      await opened;
    }
    return respond();
  };
  return { handler, release: () => release() };
}

function makeLoader(
  tree: RepositoryTree,
  options: Partial<DirectoryLoaderOptions> = {},
): DirectoryLoader {
  const created = DirectoryLoader.create({
    token: TEST_TOKEN,
    repository: REPOSITORY,
    tree,
    now: () => NOW,
    ...options,
  });
  if (!created.ok) throw new Error(`Could not create the loader (${created.reason}).`);
  return created.value;
}

const lazyLoader = (fixture: FixtureTree = REPO, options: Partial<DirectoryLoaderOptions> = {}) =>
  makeLoader(lazyTreeOf(fixture), options);

const nodeAt = (snapshot: LoaderSnapshot | TreeSnapshot, path: string): TreeNode => {
  const tree = 'tree' in snapshot ? snapshot.tree : snapshot;
  const node = tree.nodes.find((candidate) => candidate.path === path);
  if (node === undefined) throw new Error(`No node at "${path}"`);
  return node;
};

const idOf = (loader: DirectoryLoader, path: string): number =>
  nodeAt(loader.getSnapshot(), path).id;

/** The tree's data, without request or completeness markers: what a failed request must not change. */
const dataOf = (snapshot: LoaderSnapshot) => ({
  totals: snapshot.tree.totals,
  extensions: snapshot.tree.extensions,
  nodes: snapshot.tree.nodes.map((n) => [n.path, n.kind, n.bytes, n.fileCount, n.directoryCount]),
});

const paths = (net: ReturnType<typeof network>) =>
  net.requests.map((request) => `${request.url.pathname}${request.url.search}`);

const wasRecursive = (net: ReturnType<typeof network>) =>
  net.requests.some((request) => request.url.searchParams.has('recursive'));

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

// -----------------------------------------------------------------------------------------------
// Creation
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: creation', () => {
  it('starts a lazy repository with unloaded folders, and makes no request', () => {
    const net = network(REPO);
    const loader = lazyLoader();
    const snapshot = loader.getSnapshot();

    expect(net.requests).toHaveLength(0);
    expect(snapshot.tree.totals).toMatchObject({ exact: false, unloadedDirectories: 3 });
    expect(nodeAt(snapshot, 'src')).toMatchObject({
      status: 'unloaded',
      activity: 'idle',
      loadable: true,
      bytes: null,
    });
    expect(snapshot).toMatchObject({
      failures: new Map(),
      rateLimit: null,
      blockedUntil: null,
      unauthorized: false,
    });
  });

  it('starts a complete repository with everything loaded, and makes no request', async () => {
    const net = network(REPO);
    const loader = makeLoader(completeTreeOf(REPO));

    expect(loader.getSnapshot().tree.totals).toMatchObject({ exact: true, unloadedDirectories: 0 });
    for (const path of ['src', 'src/util', 'docs', 'empty']) {
      expect(await loader.loadDirectory(idOf(loader, path))).toEqual({ status: 'already-loaded' });
    }
    expect(net.requests).toHaveLength(0);
  });

  it('says why when the tree cannot be used, and makes no request', () => {
    const net = network(REPO);
    const created = DirectoryLoader.create({
      token: TEST_TOKEN,
      repository: REPOSITORY,
      tree: { ...lazyTreeOf(REPO), treeSha: 'not-a-sha' },
    });
    expect(created).toEqual({ ok: false, reason: 'invalid-sha' });
    expect(net.requests).toHaveLength(0);
  });

  it('never exposes the token in its state', async () => {
    network(REPO);
    const loader = lazyLoader();
    await loader.loadDirectory(idOf(loader, 'src'));
    expect(JSON.stringify(loader.getSnapshot().tree)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify([...loader.getSnapshot().failures])).not.toContain(TEST_TOKEN);
  });
});

// -----------------------------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: loading a directory', () => {
  it('requests the folder by its own SHA, non-recursively, and attaches the listing', async () => {
    const net = network(REPO);
    const loader = lazyLoader();

    const result = await loader.loadDirectory(idOf(loader, 'src'));

    expect(result).toEqual({ status: 'loaded', added: 2 });
    expect(paths(net)).toEqual([`/repos/octo/alpha/git/trees/${REPO.shaOf('src')}`]);
    expect(net.requests[0]).toMatchObject({ method: 'GET' });
    expect(net.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    expect(net.requests[0]?.init.credentials).toBe('omit');

    const snapshot = loader.getSnapshot();
    expect(nodeAt(snapshot, 'src')).toMatchObject({
      status: 'shallow', // src/util is still unloaded
      activity: 'idle',
      bytes: 300,
      fileCount: 1,
    });
    expect(nodeAt(snapshot, 'src/util')).toMatchObject({ status: 'unloaded', loadable: true });
    expect(snapshot.tree.root).toMatchObject({ bytes: 400, exact: false });
    expect(snapshot.failures.size).toBe(0);
  });

  it('loads nested folders, one request each, ending at the complete tree', async () => {
    const net = network(REPO);
    const loader = lazyLoader();

    for (const path of ['src', 'src/util', 'docs', 'empty']) {
      expect((await loader.loadDirectory(idOf(loader, path))).status).toBe('loaded');
    }

    const whole = TreeStore.fromRootListing(REPO.recursiveListing('')).snapshot();
    const snapshot = loader.getSnapshot().tree;
    expect(snapshot.totals).toEqual(whole.totals);
    expect(snapshot.extensions).toEqual(whole.extensions);
    expect(nodeAt(snapshot, 'src')).toMatchObject({ status: 'complete', bytes: 350 });
    expect(snapshot.root.status).toBe('complete');
    expect(paths(net)).toHaveLength(4);
  });

  it('can load a whole tree folder by folder and never makes a recursive request', async () => {
    const net = network(REPO);
    const loader = lazyLoader();
    let rounds = 0;
    for (;;) {
      const next = loader
        .getSnapshot()
        .tree.nodes.find((n) => n.kind === 'directory' && n.status === 'unloaded' && n.loadable);
      if (next === undefined) break;
      await loader.loadDirectory(next.id);
      rounds += 1;
    }
    expect(rounds).toBe(4);
    expect(loader.getSnapshot().tree.totals.exact).toBe(true);
    expect(wasRecursive(net)).toBe(false);
    expect(net.requests.every((r) => r.url.search === '')).toBe(true);
  });

  it('shares one request between concurrent calls for the same folder', async () => {
    const gate = gated(() => okResponse(REPO, 'src'));
    const net = network(REPO, { [treeRoute(REPO.shaOf('src'))]: gate.handler });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');

    const first = loader.loadDirectory(id);
    const second = loader.loadDirectory(id);
    const third = loader.loadDirectory(id, { refresh: true });
    expect(second).toBe(first);
    expect(third).toBe(first);

    gate.release();
    expect(await Promise.all([first, second, third])).toEqual([
      { status: 'loaded', added: 2 },
      { status: 'loaded', added: 2 },
      { status: 'loaded', added: 2 },
    ]);
    expect(net.requests).toHaveLength(1);
  });

  it('allows a new request for a folder once its earlier one has finished', async () => {
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('{}', { status: 500 }),
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    await loader.loadDirectory(id);
    await loader.loadDirectory(id);
    expect(net.requests).toHaveLength(2);
  });

  it('does not request a folder that is already loaded', async () => {
    const net = network(REPO);
    const loader = lazyLoader();
    const id = idOf(loader, 'docs');
    await loader.loadDirectory(id);
    const before = loader.getSnapshot();

    expect(await loader.loadDirectory(id)).toEqual({ status: 'already-loaded' });
    expect(await loader.loadDirectory(id)).toEqual({ status: 'already-loaded' });
    expect(net.requests).toHaveLength(1);
    expect(loader.getSnapshot()).toBe(before);
  });

  it('treats a folder that was loaded with problems as loaded too, rather than asking again', async () => {
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('docs'))]: () =>
        Response.json({
          sha: REPO.shaOf('docs'),
          truncated: true,
          tree: REPO.listing('docs').entries,
        }),
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'docs');
    expect((await loader.loadDirectory(id)).status).toBe('loaded');
    expect(nodeAt(loader.getSnapshot(), 'docs')).toMatchObject({
      status: 'shallow',
      truncated: true,
      exact: false,
    });
    expect(await loader.loadDirectory(id)).toEqual({ status: 'already-loaded' });
    expect(net.requests).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------------------------
// Refreshing
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: refreshing a loaded folder', () => {
  it('keeps showing the loaded data while the new request is in flight', async () => {
    const gate = gated(() => okResponse(REPO, 'docs'));
    const net = network(REPO);
    const loader = lazyLoader();
    const id = idOf(loader, 'docs');
    await loader.loadDirectory(id);
    const loaded = loader.getSnapshot();

    // Swap the route for a slow one only now, so the first load was immediate.
    const slow = createFakeFetch(
      routesFor(REPO, { [treeRoute(REPO.shaOf('docs'))]: gate.handler }),
    );
    vi.stubGlobal('fetch', slow.fetch);

    const refresh = loader.loadDirectory(id, { refresh: true });
    const during = loader.getSnapshot();
    expect(during).not.toBe(loaded);
    expect(nodeAt(during, 'docs')).toMatchObject({
      status: 'complete', // completeness is untouched…
      activity: 'loading', // …request activity is separate
      bytes: 1000,
      fileCount: 1,
    });
    expect(dataOf(during)).toEqual(dataOf(loaded));

    gate.release();
    expect(await refresh).toEqual({ status: 'loaded', added: 0 });
    expect(nodeAt(loader.getSnapshot(), 'docs')).toMatchObject({
      status: 'complete',
      activity: 'idle',
      bytes: 1000,
    });
    expect(dataOf(loader.getSnapshot())).toEqual(dataOf(loaded));
    expect(net.requests).toHaveLength(1);
    expect(slow.requests).toHaveLength(1);
  });

  it('attaching the same listing again is idempotent', async () => {
    network(REPO);
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    await loader.loadDirectory(id);
    const before = dataOf(loader.getSnapshot());
    for (let round = 0; round < 3; round += 1) {
      expect(await loader.loadDirectory(id, { refresh: true })).toEqual({
        status: 'loaded',
        added: 0,
      });
    }
    expect(dataOf(loader.getSnapshot())).toEqual(before);
  });

  it('keeps the data when a refresh fails, and records the failure', async () => {
    let fail = false;
    network(REPO, {
      [treeRoute(REPO.shaOf('docs'))]: () =>
        fail ? new Response('{}', { status: 503 }) : okResponse(REPO, 'docs'),
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'docs');
    await loader.loadDirectory(id);
    const loaded = loader.getSnapshot();

    fail = true;
    const result = await loader.loadDirectory(id, { refresh: true });
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'http', status: 503, retryable: true },
    });
    expect(nodeAt(loader.getSnapshot(), 'docs')).toMatchObject({
      status: 'complete',
      activity: 'failed',
      bytes: 1000,
    });
    expect(dataOf(loader.getSnapshot())).toEqual(dataOf(loaded));

    fail = false;
    expect((await loader.loadDirectory(id, { refresh: true })).status).toBe('loaded');
    expect(nodeAt(loader.getSnapshot(), 'docs').activity).toBe('idle');
    expect(loader.getSnapshot().failures.size).toBe(0);
  });
});

// -----------------------------------------------------------------------------------------------
// Failures and retry
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: failures and retry', () => {
  it('leaves the store exactly as it was when a request fails, and allows a retry', async () => {
    let attempts = 0;
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new TypeError('offline'));
        return okResponse(REPO, 'src');
      },
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    const before = loader.getSnapshot();

    const failed = await loader.loadDirectory(id);
    expect(failed).toEqual({
      status: 'failed',
      failure: { kind: 'network', status: null, resetAt: null, retryable: true },
    });
    const after = loader.getSnapshot();
    expect(nodeAt(after, 'src')).toMatchObject({
      status: 'failed',
      activity: 'failed',
      bytes: null,
    });
    expect(dataOf(after)).toEqual(dataOf(before));
    expect(after.failures.get(id)).toMatchObject({ kind: 'network' });

    const retried = await loader.loadDirectory(id);
    expect(retried).toEqual({ status: 'loaded', added: 2 });
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({
      status: 'shallow',
      activity: 'idle',
    });
    expect(loader.getSnapshot().failures.size).toBe(0);
    expect(net.requests).toHaveLength(2);
  });

  it('never retries by itself', async () => {
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('{}', { status: 502 }),
    });
    const loader = lazyLoader();
    await loader.loadDirectory(idOf(loader, 'src'));
    await settle();
    expect(net.requests).toHaveLength(1);
  });

  it.each([
    ['a server error (500)', 500, 'http', true],
    ['a bad gateway (502)', 502, 'http', true],
    ['a request timeout (408)', 408, 'http', true],
  ])('treats %s as transient', async (_name, status, kind, retryable) => {
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('{"message":"not echoed"}', { status }),
    });
    const loader = lazyLoader();
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toEqual({
      status: 'failed',
      failure: { kind, status, resetAt: null, retryable },
    });
    expect(JSON.stringify(result)).not.toContain('not echoed');
  });

  it('treats a body that breaks off while downloading as a network failure that can be retried', async () => {
    let calls = 0;
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => {
        calls += 1;
        return calls === 1
          ? Object.assign(new Response('{}'), {
              json: () => Promise.reject(new TypeError('terminated')),
            })
          : okResponse(REPO, 'src');
      },
    });
    const loader = lazyLoader();
    const src = idOf(loader, 'src');

    const first = await loader.loadDirectory(src);
    expect(first).toEqual({
      status: 'failed',
      failure: { kind: 'network', status: null, resetAt: null, retryable: true },
    });
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({ status: 'failed' });

    // Not remembered as a permanent answer: asking again goes to the network and succeeds.
    expect((await loader.loadDirectory(src)).status).toBe('loaded');
    expect(net.requests).toHaveLength(2);
    // Listed, but `src/util` inside it has not been loaded yet.
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({ status: 'shallow' });
    expect(loader.getSnapshot().failures.size).toBe(0);
  });

  it('keeps text that is not JSON a permanent failure', async () => {
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('<html>oops</html>'),
    });
    const loader = lazyLoader();
    const src = idOf(loader, 'src');
    const first = await loader.loadDirectory(src);
    expect(first).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_response', retryable: false },
    });
    expect(await loader.loadDirectory(src)).toEqual(first);
    expect(net.requests).toHaveLength(1);
  });

  it('reports a 404 for that folder only, and does not ask again', async () => {
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('{}', { status: 404 }),
    });
    const loader = lazyLoader();
    const src = idOf(loader, 'src');

    const first = await loader.loadDirectory(src);
    expect(first).toEqual({
      status: 'failed',
      failure: { kind: 'http', status: 404, resetAt: null, retryable: false },
    });
    // The same answer, without another request.
    expect(await loader.loadDirectory(src)).toEqual(first);
    expect(net.requests).toHaveLength(1);

    // Another folder is unaffected, and so is the session.
    expect((await loader.loadDirectory(idOf(loader, 'docs'))).status).toBe('loaded');
    expect(loader.getSnapshot().unauthorized).toBe(false);
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({ status: 'failed' });
    expect(nodeAt(loader.getSnapshot(), 'docs')).toMatchObject({ status: 'complete' });
  });

  it('reports a 403 for that folder only, as something retrying will not fix', async () => {
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('{}', { status: 403 }),
    });
    const loader = lazyLoader();
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'forbidden', status: 403, retryable: false },
    });
    expect(loader.getSnapshot().unauthorized).toBe(false);
  });

  it('does not retry GitHub answers that cannot be used', async () => {
    let calls = 0;
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => {
        calls += 1;
        return Response.json({ nonsense: true });
      },
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    const first = await loader.loadDirectory(id);
    expect(first).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_response', retryable: false },
    });
    expect(await loader.loadDirectory(id)).toEqual(first);
    expect(calls).toBe(1);
    expect(net.requests).toHaveLength(1);
  });

  it('refuses an answer for a different tree than the one asked for', async () => {
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        Response.json({ sha: REPO.shaOf('docs'), truncated: false, tree: [] }),
    });
    const loader = lazyLoader();
    const before = dataOf(loader.getSnapshot());
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_response', retryable: false },
    });
    expect(dataOf(loader.getSnapshot())).toEqual(before);
  });
});

// -----------------------------------------------------------------------------------------------
// Answers the loader itself must refuse (through the replaceable request)
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: checking what comes back before attaching it', () => {
  const answer = (overrides: Partial<TreeListing> = {}): TreeListing => ({
    sha: REPO.shaOf('src'),
    recursive: false,
    entries: REPO.listing('src').entries,
    skipped: 0,
    truncated: false,
    rateLimit: null,
    ...overrides,
  });

  function withAnswer(listing: TreeListing | (() => Promise<TreeListing>)) {
    const loadListing = vi.fn((): Promise<TreeListing> =>
      typeof listing === 'function' ? listing() : Promise.resolve(listing),
    );
    const loader = lazyLoader(REPO, { loadListing });
    return { loader, loadListing };
  }

  it('passes the folder SHA, the repository, the token and "not recursive" to the request', async () => {
    const { loader, loadListing } = withAnswer(answer());
    await loader.loadDirectory(idOf(loader, 'src'));
    expect(loadListing).toHaveBeenCalledTimes(1);
    expect(loadListing).toHaveBeenCalledWith(
      TEST_TOKEN,
      REPOSITORY,
      REPO.shaOf('src'),
      expect.objectContaining({ recursive: false, signal: expect.any(AbortSignal) as AbortSignal }),
    );
  });

  it('refuses a listing for a different SHA, changes nothing, and does not ask again', async () => {
    const { loader, loadListing } = withAnswer(answer({ sha: fakeSha(999) }));
    const before = loader.getSnapshot();
    const id = idOf(loader, 'src');

    const result = await loader.loadDirectory(id);
    expect(result).toEqual({
      status: 'failed',
      failure: { kind: 'sha_mismatch', status: null, resetAt: null, retryable: false },
    });
    expect(dataOf(loader.getSnapshot())).toEqual(dataOf(before));
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({ status: 'failed', bytes: null });

    expect(await loader.loadDirectory(id)).toEqual(result);
    expect(loadListing).toHaveBeenCalledTimes(1);
  });

  it('refuses a recursive listing: this loader only ever attaches direct ones', async () => {
    const { loader } = withAnswer(answer({ recursive: true }));
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toMatchObject({ status: 'failed', failure: { kind: 'invalid_listing' } });
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({ status: 'failed', bytes: null });
    expect(loader.getSnapshot().tree.nodes.some((n) => n.path === 'src/util')).toBe(false);
  });

  it.each([
    ['a negative skipped count', { skipped: -1 }],
    ['entries that are not a list', { entries: null }],
    ['a missing truncated flag', { truncated: undefined }],
  ])('refuses a listing with %s', async (_name, patch) => {
    const { loader, loadListing } = withAnswer(answer(patch as Partial<TreeListing>));
    const id = idOf(loader, 'src');
    const result = await loader.loadDirectory(id);
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_listing', retryable: false },
    });
    await loader.loadDirectory(id);
    expect(loadListing).toHaveBeenCalledTimes(1);
  });

  it('reports something unexpected without rejecting, and leaves nothing marked as loading', async () => {
    const { loader } = withAnswer(() => Promise.reject(new Error('boom')));
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'unexpected', retryable: false },
    });
    expect(nodeAt(loader.getSnapshot(), 'src').activity).toBe('failed');
  });

  it('survives a listing that makes the store throw', async () => {
    const entries = new Proxy([], {
      get() {
        throw new Error('hostile entries');
      },
    }) as unknown as TreeListing['entries'];
    const { loader } = withAnswer(answer({ entries }));
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result.status).toBe('failed');
    expect(nodeAt(loader.getSnapshot(), 'src').activity).not.toBe('loading');
  });
});

// -----------------------------------------------------------------------------------------------
// Authentication
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: a 401', () => {
  const unauthorized = () => new Response('{"message":"Bad credentials"}', { status: 401 });

  it('ends the session, calls back once, and keeps what was already loaded', async () => {
    const onUnauthorized = vi.fn();
    const net = network(REPO, { [treeRoute(REPO.shaOf('docs'))]: unauthorized });
    const loader = lazyLoader(REPO, { onUnauthorized });
    await loader.loadDirectory(idOf(loader, 'src'));
    const loaded = dataOf(loader.getSnapshot());

    expect(await loader.loadDirectory(idOf(loader, 'docs'))).toEqual({ status: 'unauthorized' });

    const snapshot = loader.getSnapshot();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(snapshot.unauthorized).toBe(true);
    // Not recorded as a folder failure: it is a session matter.
    expect(snapshot.failures.size).toBe(0);
    expect(dataOf(snapshot)).toEqual(loaded);
    expect(nodeAt(snapshot, 'docs')).toMatchObject({ status: 'unloaded', activity: 'idle' });

    // Nothing more is requested, whatever is asked.
    const requests = net.requests.length;
    expect(await loader.loadDirectory(idOf(loader, 'empty'))).toEqual({ status: 'unauthorized' });
    expect(await loader.loadDirectory(idOf(loader, 'src'), { refresh: true })).toEqual({
      status: 'unauthorized',
    });
    expect(net.requests).toHaveLength(requests);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('aborts the other requests in flight, whose late answers then change nothing', async () => {
    const slow = gated(() => okResponse(REPO, 'src'), { honourAbort: false });
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: slow.handler,
      [treeRoute(REPO.shaOf('docs'))]: unauthorized,
    });
    const onUnauthorized = vi.fn();
    const loader = lazyLoader(REPO, { onUnauthorized });
    const before = dataOf(loader.getSnapshot());

    const pending = loader.loadDirectory(idOf(loader, 'src'));
    expect(nodeAt(loader.getSnapshot(), 'src').activity).toBe('loading');
    expect(await loader.loadDirectory(idOf(loader, 'docs'))).toEqual({ status: 'unauthorized' });

    const duringSignal = net.requests[0]?.init.signal;
    expect(duringSignal?.aborted).toBe(true);
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({
      status: 'unloaded',
      activity: 'idle',
    });

    // The slow answer arrives anyway.
    const settled = loader.getSnapshot();
    slow.release();
    expect(await pending).toEqual({ status: 'unauthorized' });
    expect(loader.getSnapshot()).toBe(settled);
    expect(dataOf(loader.getSnapshot())).toEqual(before);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('survives a callback that throws', async () => {
    const queued: unknown[] = [];
    vi.stubGlobal('queueMicrotask', (task: () => void) => {
      try {
        task();
      } catch (error) {
        queued.push(error);
      }
    });
    network(REPO, { [treeRoute(REPO.shaOf('docs'))]: unauthorized });
    const loader = lazyLoader(REPO, {
      onUnauthorized: () => {
        throw new Error('callback bug');
      },
    });
    expect(await loader.loadDirectory(idOf(loader, 'docs'))).toEqual({ status: 'unauthorized' });
    expect(loader.getSnapshot().unauthorized).toBe(true);
    expect(queued).toHaveLength(1);
  });

  it("is not mistaken for a client error: it is the client's own unauthorized kind", () => {
    expect(new GitHubApiError('unauthorized', { status: 401 }).kind).toBe('unauthorized');
  });
});

// -----------------------------------------------------------------------------------------------
// Rate limits
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: rate limits', () => {
  it("reports GitHub's reset time with a 429, and makes no request until then", async () => {
    let clock = NOW;
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        new Response('{}', {
          status: 429,
          headers: { 'x-ratelimit-reset': String(FAR_FUTURE_SECONDS) },
        }),
    });
    const loader = lazyLoader(REPO, { now: () => clock });
    const resetAt = FAR_FUTURE_SECONDS * 1000;

    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toEqual({
      status: 'failed',
      failure: { kind: 'rate_limited', status: 429, resetAt, retryable: true },
    });
    expect(loader.getSnapshot()).toMatchObject({ blockedUntil: resetAt });
    expect(nodeAt(loader.getSnapshot(), 'src').activity).toBe('failed');

    // Any folder is held back until GitHub's time, with no request.
    expect(await loader.loadDirectory(idOf(loader, 'docs'))).toEqual({
      status: 'blocked',
      until: resetAt,
    });
    expect(await loader.loadDirectory(idOf(loader, 'src'))).toEqual({
      status: 'blocked',
      until: resetAt,
    });
    expect(net.requests).toHaveLength(1);

    // After the reset time it goes ahead again.
    clock = resetAt + 1;
    expect((await loader.loadDirectory(idOf(loader, 'docs'))).status).toBe('loaded');
    expect(loader.getSnapshot().blockedUntil).toBeNull();
    expect(net.requests).toHaveLength(2);
  });

  it('treats a 403 with no requests remaining as a rate limit too', async () => {
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        new Response('{}', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(FAR_FUTURE_SECONDS),
          },
        }),
    });
    const loader = lazyLoader();
    const result = await loader.loadDirectory(idOf(loader, 'src'));
    expect(result).toMatchObject({
      status: 'failed',
      failure: { kind: 'rate_limited', status: 403, retryable: true },
    });
  });

  it('uses retry-after as GitHub gave it, and invents no timing when GitHub gave none', async () => {
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '60' } }),
      [treeRoute(REPO.shaOf('docs'))]: () => new Response('{}', { status: 429 }),
    });
    const before = Date.now();
    // The default clock is the real one here, because retry-after is relative to it.
    const loader = lazyLoader(REPO, { now: Date.now });

    const withRetryAfter = await loader.loadDirectory(idOf(loader, 'src'));
    expect(withRetryAfter.status).toBe('failed');
    const blockedUntil = loader.getSnapshot().blockedUntil;
    expect(blockedUntil).toBeGreaterThanOrEqual(before + 59_000);
    expect(blockedUntil).toBeLessThanOrEqual(Date.now() + 61_000);
    expect(net.requests).toHaveLength(1);

    // A fresh loader: a 429 with no timing at all blocks nothing.
    const bare = lazyLoader(REPO, { now: () => NOW });
    const unknown = await bare.loadDirectory(idOf(bare, 'docs'));
    expect(unknown).toEqual({
      status: 'failed',
      failure: { kind: 'rate_limited', status: 429, resetAt: null, retryable: true },
    });
    expect(bare.getSnapshot().blockedUntil).toBeNull();
    await settle();
    expect(net.requests).toHaveLength(2); // and it did not retry on its own
  });

  describe('two limits reported by requests that were in flight together', () => {
    const EARLY = FAR_FUTURE_SECONDS;
    const LATE = FAR_FUTURE_SECONDS + 3600;
    const limited = (resetSeconds: number) => () =>
      new Response('{}', {
        status: 429,
        headers: { 'x-ratelimit-reset': String(resetSeconds) },
      });

    it.each([
      ['the later reset arrives first', LATE, EARLY],
      ['the earlier reset arrives first', EARLY, LATE],
    ])('keeps the later block when %s', async (_name, firstSeconds, secondSeconds) => {
      const first = gated(limited(firstSeconds));
      const second = gated(limited(secondSeconds));
      const net = network(REPO, {
        [treeRoute(REPO.shaOf('src'))]: first.handler,
        [treeRoute(REPO.shaOf('docs'))]: second.handler,
      });
      const loader = lazyLoader(REPO, { now: () => NOW });

      const a = loader.loadDirectory(idOf(loader, 'src'));
      const b = loader.loadDirectory(idOf(loader, 'docs'));
      expect(net.requests).toHaveLength(2); // both are on their way before either answers

      first.release();
      await a;
      expect(loader.getSnapshot().blockedUntil).toBe(firstSeconds * 1000);

      second.release();
      await b;
      expect(loader.getSnapshot().blockedUntil).toBe(LATE * 1000);

      // The block that stands is the later one, and it still holds requests back.
      expect(await loader.loadDirectory(idOf(loader, 'empty'))).toEqual({
        status: 'blocked',
        until: LATE * 1000,
      });
      expect(net.requests).toHaveLength(2);
    });

    it('does not let a later answer that is nearly out of requests shorten the block', async () => {
      const limit = gated(limited(LATE));
      const last = gated(() =>
        okResponse(REPO, 'docs', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(EARLY),
        }),
      );
      network(REPO, {
        [treeRoute(REPO.shaOf('src'))]: limit.handler,
        [treeRoute(REPO.shaOf('docs'))]: last.handler,
      });
      const loader = lazyLoader(REPO, { now: () => NOW });

      const a = loader.loadDirectory(idOf(loader, 'src'));
      const b = loader.loadDirectory(idOf(loader, 'docs'));
      limit.release();
      await a;
      last.release();
      expect((await b).status).toBe('loaded');
      expect(loader.getSnapshot().blockedUntil).toBe(LATE * 1000);
    });

    it('raises an earlier block when a later reset is reported', async () => {
      const first = gated(() =>
        okResponse(REPO, 'src', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(EARLY),
        }),
      );
      const second = gated(limited(LATE));
      network(REPO, {
        [treeRoute(REPO.shaOf('src'))]: first.handler,
        [treeRoute(REPO.shaOf('docs'))]: second.handler,
      });
      const loader = lazyLoader(REPO, { now: () => NOW });

      const a = loader.loadDirectory(idOf(loader, 'src'));
      const b = loader.loadDirectory(idOf(loader, 'docs'));
      first.release();
      await a;
      expect(loader.getSnapshot().blockedUntil).toBe(EARLY * 1000);
      second.release();
      await b;
      expect(loader.getSnapshot().blockedUntil).toBe(LATE * 1000);
    });
  });

  it('exposes the rate-limit metadata of successful responses', async () => {
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        okResponse(REPO, 'src', { 'x-ratelimit-remaining': '4321' }),
    });
    const loader = lazyLoader();
    await loader.loadDirectory(idOf(loader, 'src'));
    expect(loader.getSnapshot().rateLimit).toEqual({
      remaining: 4321,
      resetAt: FAR_FUTURE_SECONDS * 1000,
    });
    expect(loader.getSnapshot().blockedUntil).toBeNull();
  });

  it("stops asking when a response says the limit is used up, until GitHub's reset time", async () => {
    let clock = NOW;
    const net = network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        okResponse(REPO, 'src', { 'x-ratelimit-remaining': '0' }),
    });
    const loader = lazyLoader(REPO, { now: () => clock });
    expect((await loader.loadDirectory(idOf(loader, 'src'))).status).toBe('loaded');

    const resetAt = FAR_FUTURE_SECONDS * 1000;
    expect(loader.getSnapshot()).toMatchObject({
      rateLimit: { remaining: 0, resetAt },
      blockedUntil: resetAt,
    });
    // The data that arrived is kept.
    expect(nodeAt(loader.getSnapshot(), 'src').bytes).toBe(300);

    expect(await loader.loadDirectory(idOf(loader, 'docs'))).toEqual({
      status: 'blocked',
      until: resetAt,
    });
    expect(net.requests).toHaveLength(1);
    clock = resetAt;
    expect((await loader.loadDirectory(idOf(loader, 'docs'))).status).toBe('loaded');
  });

  it('keeps a rate-limited folder retryable', async () => {
    let limited = true;
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        limited ? new Response('{}', { status: 429 }) : okResponse(REPO, 'src'),
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    expect((await loader.loadDirectory(id)).status).toBe('failed');
    limited = false;
    expect((await loader.loadDirectory(id)).status).toBe('loaded');
  });
});

// -----------------------------------------------------------------------------------------------
// Which directories may be loaded
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: only real, loadable folders are requested', () => {
  it('does not request a folder without a usable SHA', async () => {
    const net = network(REPO);
    const tree = {
      ...lazyTreeOf(REPO),
      entries: [
        { path: 'missing', type: 'tree' as const },
        { path: 'nulled', type: 'tree' as const, sha: null },
        { path: 'hostile', type: 'tree' as const, sha: '../../user' },
        { path: 'short', type: 'tree' as const, sha: 'abc' },
      ],
    };
    const loader = makeLoader(tree);
    const before = loader.getSnapshot();

    for (const name of ['missing', 'nulled', 'hostile', 'short']) {
      expect(await loader.loadDirectory(idOf(loader, name))).toEqual({
        status: 'not-loadable',
        reason: 'no-sha',
      });
    }
    expect(net.requests).toHaveLength(0);
    expect(loader.getSnapshot()).toBe(before);
    expect(nodeAt(before, 'hostile')).toMatchObject({ loadable: false, status: 'unloaded' });
  });

  it('never requests a file, a symlink or a submodule, whatever SHA they carry', async () => {
    const fixture = new FixtureTree([
      blob('file.txt', 1),
      symlink('link', 4),
      submodule('vendor'),
      dirEntry('src'),
    ]);
    const net = network(fixture);
    const loader = lazyLoader(fixture);
    const before = loader.getSnapshot();

    for (const name of ['file.txt', 'link', 'vendor']) {
      expect(await loader.loadDirectory(idOf(loader, name))).toEqual({
        status: 'not-loadable',
        reason: 'not-a-directory',
      });
      expect(await loader.loadDirectory(idOf(loader, name), { refresh: true })).toEqual({
        status: 'not-loadable',
        reason: 'not-a-directory',
      });
    }
    expect(net.requests).toHaveLength(0);
    expect(loader.getSnapshot()).toBe(before);
  });

  it.each([-1, 9999, Number.NaN, 1.5, Number.POSITIVE_INFINITY])(
    'refuses an id that is not a folder (%s)',
    async (id) => {
      const net = network(REPO);
      const loader = lazyLoader();
      expect(await loader.loadDirectory(id)).toEqual({
        status: 'not-loadable',
        reason: 'unknown-directory',
      });
      expect(net.requests).toHaveLength(0);
    },
  );

  it('loads the root by its id only if it still needs loading', async () => {
    const net = network(REPO);
    const loader = lazyLoader();
    expect(await loader.loadDirectory(0)).toEqual({ status: 'already-loaded' });
    expect(net.requests).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------------
// Cancellation
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: cancellation', () => {
  it('makes no request after it was disposed', async () => {
    const net = network(REPO);
    const loader = lazyLoader();
    const before = loader.getSnapshot();
    loader.dispose();
    expect(await loader.loadDirectory(idOf(loader, 'src'))).toEqual({ status: 'cancelled' });
    expect(net.requests).toHaveLength(0);
    expect(dataOf(loader.getSnapshot())).toEqual(dataOf(before));
  });

  it('makes no request if the signal it was given was already aborted', async () => {
    const net = network(REPO);
    const controller = new AbortController();
    controller.abort();
    const loader = lazyLoader(REPO, { signal: controller.signal });
    expect(await loader.loadDirectory(idOf(loader, 'src'))).toEqual({ status: 'cancelled' });
    expect(net.requests).toHaveLength(0);
  });

  it('aborts a request in flight, and clears its loading mark without touching the data', async () => {
    const gate = gated(() => okResponse(REPO, 'src'));
    const net = network(REPO, { [treeRoute(REPO.shaOf('src'))]: gate.handler });
    const loader = lazyLoader();
    const before = dataOf(loader.getSnapshot());

    const pending = loader.loadDirectory(idOf(loader, 'src'));
    expect(nodeAt(loader.getSnapshot(), 'src').activity).toBe('loading');
    expect(net.requests[0]?.init.signal?.aborted).toBe(false);

    loader.dispose();
    expect(net.requests[0]?.init.signal?.aborted).toBe(true);
    expect(await pending).toEqual({ status: 'cancelled' });

    const snapshot = loader.getSnapshot();
    expect(nodeAt(snapshot, 'src')).toMatchObject({ status: 'unloaded', activity: 'idle' });
    expect(dataOf(snapshot)).toEqual(before);
    expect(snapshot.failures.size).toBe(0);
  });

  it('is cancelled by the signal it was given', async () => {
    const gate = gated(() => okResponse(REPO, 'src'));
    const net = network(REPO, { [treeRoute(REPO.shaOf('src'))]: gate.handler });
    const controller = new AbortController();
    const loader = lazyLoader(REPO, { signal: controller.signal });

    const pending = loader.loadDirectory(idOf(loader, 'src'));
    controller.abort();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(net.requests[0]?.init.signal?.aborted).toBe(true);
    expect(await loader.loadDirectory(idOf(loader, 'docs'))).toEqual({ status: 'cancelled' });
  });

  it('ignores a response that arrives after cancellation', async () => {
    const late = gated(() => okResponse(REPO, 'src'), { honourAbort: false });
    network(REPO, { [treeRoute(REPO.shaOf('src'))]: late.handler });
    const listener = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(listener);

    const pending = loader.loadDirectory(idOf(loader, 'src'));
    loader.dispose();
    const settled = loader.getSnapshot();
    listener.mockClear();

    late.release(); // a perfectly good listing, far too late
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(loader.getSnapshot()).toBe(settled);
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({ status: 'unloaded', bytes: null });
    expect(nodeAt(loader.getSnapshot(), 'src').children).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores an error that arrives after cancellation', async () => {
    const late = gated(() => new Response('{}', { status: 500 }), { honourAbort: false });
    network(REPO, { [treeRoute(REPO.shaOf('src'))]: late.handler });
    const loader = lazyLoader();
    const pending = loader.loadDirectory(idOf(loader, 'src'));
    loader.dispose();
    late.release();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(loader.getSnapshot().failures.size).toBe(0);
    expect(nodeAt(loader.getSnapshot(), 'src').activity).toBe('idle');
  });

  it('is safe to dispose twice, and after everything finished', async () => {
    network(REPO);
    const loader = lazyLoader();
    await loader.loadDirectory(idOf(loader, 'src'));
    const before = loader.getSnapshot();
    loader.dispose();
    loader.dispose();
    expect(dataOf(loader.getSnapshot())).toEqual(dataOf(before));
    expect(nodeAt(loader.getSnapshot(), 'src').status).toBe('shallow');
  });

  it('tells listeners once, when disposing clears a loading mark, and never again', async () => {
    const gate = gated(() => okResponse(REPO, 'src'));
    network(REPO, { [treeRoute(REPO.shaOf('src'))]: gate.handler });
    const listener = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(listener);
    const pending = loader.loadDirectory(idOf(loader, 'src'));
    listener.mockClear();

    loader.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
    // What the listener reads then is the settled state, not "loading".
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({
      status: 'unloaded',
      activity: 'idle',
    });

    await pending;
    loader.dispose();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps its snapshot object, and notifies nobody, when disposing changes nothing', () => {
    network(REPO);
    const listener = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(listener);
    const before = loader.getSnapshot();
    loader.dispose();
    expect(loader.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
  });

  it('reports itself as disposed', () => {
    network(REPO);
    const controller = new AbortController();
    const loader = lazyLoader(REPO, { signal: controller.signal });
    expect(loader.disposed).toBe(false);
    controller.abort();
    expect(loader.disposed).toBe(true);
    const other = lazyLoader();
    other.dispose();
    expect(other.disposed).toBe(true);
  });

  it('shares the cancelled result between callers that were waiting on one request', async () => {
    const gate = gated(() => okResponse(REPO, 'src'));
    network(REPO, { [treeRoute(REPO.shaOf('src'))]: gate.handler });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    const a = loader.loadDirectory(id);
    const b = loader.loadDirectory(id);
    loader.dispose();
    expect(await Promise.all([a, b])).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
  });
});

// -----------------------------------------------------------------------------------------------
// Subscriptions and snapshots
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: subscriptions and snapshots', () => {
  it('hands out the very same snapshot until something observable changes', async () => {
    network(REPO);
    const loader = lazyLoader();
    const a = loader.getSnapshot();
    expect(loader.getSnapshot()).toBe(a);
    expect(loader.getSnapshot().tree).toBe(a.tree);

    await loader.loadDirectory(idOf(loader, 'src'));
    const b = loader.getSnapshot();
    expect(b).not.toBe(a);
    expect(loader.getSnapshot()).toBe(b);
  });

  it('notifies once when a load starts and once when it ends', async () => {
    network(REPO);
    const listener = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(listener);

    const pending = loader.loadDirectory(idOf(loader, 'src'));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(nodeAt(loader.getSnapshot(), 'src').activity).toBe('loading');

    await pending;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(nodeAt(loader.getSnapshot(), 'src')).toMatchObject({
      activity: 'idle',
      status: 'shallow',
    });
  });

  it('notifies for a failure, and again for the retry', async () => {
    let fail = true;
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () =>
        fail ? new Response('{}', { status: 500 }) : okResponse(REPO, 'src'),
    });
    const listener = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(listener);
    const id = idOf(loader, 'src');

    await loader.loadDirectory(id);
    expect(listener).toHaveBeenCalledTimes(2); // loading, failed

    fail = false;
    await loader.loadDirectory(id);
    expect(listener).toHaveBeenCalledTimes(4); // loading, loaded
  });

  it('does not notify when nothing was requested or nothing changed', async () => {
    const net = network(REPO);
    const listener = vi.fn();
    const loader = lazyLoader();
    await loader.loadDirectory(idOf(loader, 'docs'));
    loader.subscribe(listener);

    await loader.loadDirectory(idOf(loader, 'docs')); // already loaded
    await loader.loadDirectory(0); // the root
    await loader.loadDirectory(-5); // unknown
    expect(listener).not.toHaveBeenCalled();
    expect(net.requests).toHaveLength(1);
  });

  it('does not notify for a call that joins a request already in flight', async () => {
    const gate = gated(() => okResponse(REPO, 'src'));
    network(REPO, { [treeRoute(REPO.shaOf('src'))]: gate.handler });
    const listener = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(listener);
    const id = idOf(loader, 'src');

    const first = loader.loadDirectory(id);
    const joined = loader.loadDirectory(id);
    expect(listener).toHaveBeenCalledTimes(1);
    gate.release();
    await Promise.all([first, joined]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('stops notifying a listener that unsubscribed, and tells every other one', async () => {
    network(REPO);
    const kept = vi.fn();
    const dropped = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(kept);
    const unsubscribe = loader.subscribe(dropped);
    unsubscribe();
    unsubscribe(); // harmless

    await loader.loadDirectory(idOf(loader, 'src'));
    expect(kept).toHaveBeenCalledTimes(2);
    expect(dropped).not.toHaveBeenCalled();
  });

  it('lets a listener read the new state, and the earlier snapshot stays as it was', async () => {
    network(REPO);
    const loader = lazyLoader();
    const before = loader.getSnapshot();
    const frozen = JSON.stringify(before.tree);
    const seen: LoaderSnapshot[] = [];
    loader.subscribe(() => seen.push(loader.getSnapshot()));

    await loader.loadDirectory(idOf(loader, 'src'));

    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(loader.getSnapshot());
    expect(seen[0]).not.toBe(seen[1]);
    expect(JSON.stringify(before.tree)).toBe(frozen); // never mutated
    expect(before.tree.root.fileCount).toBe(1);
    // Folders that did not change are the very same objects in the new snapshot.
    expect(nodeAt(seen[1] ?? before, 'docs')).toBe(nodeAt(before, 'docs'));
    expect(nodeAt(seen[1] ?? before, 'README.md')).toBe(nodeAt(before, 'README.md'));
  });

  it('keeps a failure from replacing the tree object when the tree did not change', async () => {
    network(REPO, {
      [treeRoute(REPO.shaOf('src'))]: () => new Response('{}', { status: 404 }),
    });
    const loader = lazyLoader();
    const id = idOf(loader, 'src');
    const before = loader.getSnapshot();
    await loader.loadDirectory(id);
    const after = loader.getSnapshot();
    // The folder's own node changed (failed), but nothing else did.
    expect(nodeAt(after, 'docs')).toBe(nodeAt(before, 'docs'));
    expect(after.failures.get(id)).toMatchObject({ kind: 'http', status: 404 });
  });

  it('survives a listener that throws, and still tells the others', async () => {
    const errors: unknown[] = [];
    vi.stubGlobal('queueMicrotask', (task: () => void) => {
      try {
        task();
      } catch (error) {
        errors.push(error);
      }
    });
    network(REPO);
    const after = vi.fn();
    const loader = lazyLoader();
    loader.subscribe(() => {
      throw new Error('listener bug');
    });
    loader.subscribe(after);

    expect((await loader.loadDirectory(idOf(loader, 'src'))).status).toBe('loaded');
    expect(after).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------------------------------
// Large trees
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: large trees and repeated requests', () => {
  const specs = [];
  for (let dir = 0; dir < 1000; dir += 1) {
    specs.push(dirEntry(`pkg${String(dir)}`));
    for (let index = 0; index < 99; index += 1) {
      specs.push(blob(`pkg${String(dir)}/f${String(index)}.ts`, 10));
    }
  }
  const BIG = new FixtureTree(specs);

  it('loads 1,000 folders of a 100,000-entry repository at once, one request each', async () => {
    const net = network(BIG);
    const loader = lazyLoader(BIG);
    const listener = vi.fn();
    loader.subscribe(listener);
    const ids = loader.getSnapshot().tree.root.children.map((child) => child.id);
    expect(ids).toHaveLength(1000);

    const results = await Promise.all(ids.map((id) => loader.loadDirectory(id)));

    expect(results.every((r) => r.status === 'loaded')).toBe(true);
    expect(net.requests).toHaveLength(1000);
    expect(new Set(paths(net)).size).toBe(1000); // no folder asked for twice
    expect(wasRecursive(net)).toBe(false);
    const { totals } = loader.getSnapshot().tree;
    expect(totals).toMatchObject({
      files: 99_000,
      directories: 1000,
      bytes: 990_000,
      exact: true,
      unloadedDirectories: 0,
    });
    // A start and an end for each: nothing beyond that.
    expect(listener.mock.calls.length).toBeLessThanOrEqual(2000);
  }, 30_000);

  it('makes no further request when asked again, however often', async () => {
    const net = network(BIG);
    const loader = lazyLoader(BIG);
    const ids = loader
      .getSnapshot()
      .tree.root.children.map((child) => child.id)
      .slice(0, 200);
    await Promise.all(ids.map((id) => loader.loadDirectory(id)));
    const after = loader.getSnapshot();
    expect(net.requests).toHaveLength(200);

    for (let round = 0; round < 5; round += 1) {
      const again = await Promise.all(ids.map((id) => loader.loadDirectory(id)));
      expect(again.every((r) => r.status === 'already-loaded')).toBe(true);
    }
    expect(net.requests).toHaveLength(200);
    expect(loader.getSnapshot()).toBe(after);
  });
});

// -----------------------------------------------------------------------------------------------
// Bounded concurrency
// -----------------------------------------------------------------------------------------------

describe('DirectoryLoader: bounded concurrency', () => {
  const WIDE = new FixtureTree(
    Array.from({ length: 8 }, (_unused, index) => [
      dirEntry(`d${String(index)}`),
      blob(`d${String(index)}/f.ts`, 10),
    ]).flat(),
  );

  interface Call {
    readonly path: string;
    readonly signal: AbortSignal;
    settled: boolean;
    /** Answers with the folder's real listing, or with `override`. */
    succeed(override?: Partial<TreeListing>): void;
    fail(error: unknown): void;
  }

  /**
   * A loader whose listing requests are promises the test settles by hand: nothing runs on its
   * own, so what is active at any moment is known exactly.
   */
  function controlled(options: Partial<DirectoryLoaderOptions> = {}, rejectOnAbort = true) {
    const calls: Call[] = [];
    let peak = 0;
    const active = () => calls.filter((call) => !call.settled).length;

    const loadListing = vi.fn(
      (_token: string, _repository: unknown, sha: string, request: { signal?: AbortSignal }) =>
        new Promise<TreeListing>((resolve, reject) => {
          const path = WIDE.directories().find((candidate) => WIDE.shaOf(candidate) === sha);
          const signal = request.signal;
          if (path === undefined || signal === undefined) throw new Error('unexpected request');
          const call: Call = {
            path,
            signal,
            settled: false,
            succeed: (override = {}) => {
              call.settled = true;
              resolve({
                sha,
                recursive: false,
                entries: WIDE.listing(path).entries,
                skipped: 0,
                truncated: false,
                rateLimit: null,
                ...override,
              });
            },
            fail: (error) => {
              call.settled = true;
              reject(error instanceof Error ? error : new Error('failed'));
            },
          };
          if (rejectOnAbort) {
            signal.addEventListener('abort', () => {
              call.fail(new DOMException('Aborted', 'AbortError'));
            });
          }
          calls.push(call);
          peak = Math.max(peak, active());
        }),
    );

    const loader = makeLoader(lazyTreeOf(WIDE), {
      ...options,
      loadListing: loadListing as unknown as typeof loadTreeListing,
    });
    const load = (index: number, refresh = false) =>
      loader.loadDirectory(idOf(loader, `d${String(index)}`), { refresh });
    const callFor = (index: number): Call => {
      const call = calls.find((candidate) => candidate.path === `d${String(index)}`);
      if (call === undefined) throw new Error(`d${String(index)} was never requested`);
      return call;
    };
    return {
      loader,
      load,
      calls,
      callFor,
      loadListing,
      active,
      peak: () => peak,
      started: () => calls.map((call) => call.path),
    };
  }

  it('uses a default limit of four', () => {
    expect(DEFAULT_MAX_CONCURRENT_REQUESTS).toBe(4);
  });

  it('keeps at most four requests active, and queues the rest', () => {
    const t = controlled();
    for (let index = 0; index < 8; index += 1) void t.load(index);

    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3']);
    expect(t.active()).toBe(4);
    expect(t.loadListing).toHaveBeenCalledTimes(4);

    // The queued four look "loading" but have not asked GitHub for anything.
    const snapshot = t.loader.getSnapshot();
    for (const name of ['d4', 'd5', 'd6', 'd7']) {
      expect(nodeAt(snapshot, name)).toMatchObject({ status: 'loading', activity: 'loading' });
    }
  });

  it('starts the fifth request only after one of the first four settles, in order', async () => {
    const t = controlled();
    const results = Array.from({ length: 8 }, (_unused, index) => t.load(index));
    expect(t.calls).toHaveLength(4);

    // Finishing the second one, not the first, frees exactly one slot.
    t.callFor(1).succeed();
    expect(await results[1]).toEqual({ status: 'loaded', added: 1 });
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(t.active()).toBe(4);

    t.callFor(0).succeed();
    t.callFor(3).succeed();
    await Promise.all([results[0], results[3]]);
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6']);

    for (const index of [2, 4, 5, 6]) t.callFor(index).succeed();
    await Promise.all(results.filter((_result, index) => [2, 4, 5, 6].includes(index)));
    expect(t.started()).toHaveLength(8);
    t.callFor(7).succeed();

    expect((await Promise.all(results)).every((r) => r.status === 'loaded')).toBe(true);
    expect(t.peak()).toBe(4);
    expect(t.loader.getSnapshot().tree.totals).toMatchObject({ files: 8, exact: true });
  });

  it('shares one promise and one request for a folder that is queued', async () => {
    const t = controlled();
    for (let index = 0; index < 4; index += 1) void t.load(index);

    const queued = t.load(6);
    expect(t.load(6)).toBe(queued);
    expect(t.load(6, true)).toBe(queued);
    expect(t.calls).toHaveLength(4);

    t.callFor(0).succeed();
    await Promise.resolve();
    await Promise.resolve();
    // Once a slot frees up it is requested exactly once.
    expect(t.started().filter((path) => path === 'd6')).toHaveLength(1);
    t.callFor(6).succeed();
    expect(await queued).toEqual({ status: 'loaded', added: 1 });
    expect(t.load(6)).not.toBe(queued); // the finished request is no longer shared
    expect(t.loadListing).toHaveBeenCalledTimes(5);
  });

  it('releases the slot when a request fails', async () => {
    const t = controlled();
    const first = Array.from({ length: 4 }, (_unused, index) => t.load(index));
    const fifth = t.load(4);
    const sixth = t.load(5);
    expect(t.calls).toHaveLength(4);

    t.callFor(0).fail(new GitHubApiError('http', { status: 500 }));
    expect(await first[0]).toMatchObject({ status: 'failed', failure: { retryable: true } });
    expect(t.started()).toContain('d4');
    expect(t.started()).not.toContain('d5');

    // A failure the loader did not expect, and a listing it refuses, free their slots too.
    t.callFor(1).fail(new Error('boom'));
    expect(await first[1]).toMatchObject({ status: 'failed', failure: { kind: 'unexpected' } });
    t.callFor(2).succeed({ recursive: true });
    expect(await first[2]).toMatchObject({
      status: 'failed',
      failure: { kind: 'invalid_listing' },
    });
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3', 'd4', 'd5']);

    t.callFor(3).succeed();
    t.callFor(4).succeed();
    t.callFor(5).succeed();
    expect((await Promise.all([fifth, sixth])).map((r) => r.status)).toEqual(['loaded', 'loaded']);
    expect(t.active()).toBe(0);
    expect(t.peak()).toBe(4);

    // Nothing is left stuck: a retry of a failed folder starts straight away.
    void t.load(0);
    expect(t.started().filter((path) => path === 'd0')).toHaveLength(2);
  });

  it('settles every queued request as cancelled when disposed, and starts none of them', async () => {
    const t = controlled({}, false); // the active requests ignore the abort, as a late response would
    const results = Array.from({ length: 8 }, (_unused, index) => t.load(index));
    const listener = vi.fn();
    t.loader.subscribe(listener);
    listener.mockClear();

    t.loader.dispose();
    expect(listener).toHaveBeenCalledTimes(1); // the loading marks were cleared, once
    expect(t.calls.every((call) => call.signal.aborted)).toBe(true);
    // Queued requests settle at once, without waiting for any slot.
    expect(await Promise.all(results.slice(4))).toEqual(
      Array.from({ length: 4 }, () => ({ status: 'cancelled' })),
    );

    // The active requests are told too, and their late answers start nothing.
    for (const call of t.calls) call.succeed();
    expect(await Promise.all(results.slice(0, 4))).toEqual(
      Array.from({ length: 4 }, () => ({ status: 'cancelled' })),
    );
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3']);
    expect(t.loadListing).toHaveBeenCalledTimes(4);
    expect(listener).toHaveBeenCalledTimes(1); // and nothing after that

    const snapshot = t.loader.getSnapshot();
    for (let index = 0; index < 8; index += 1) {
      expect(nodeAt(snapshot, `d${String(index)}`)).toMatchObject({
        status: 'unloaded',
        activity: 'idle',
        bytes: null,
      });
    }
    expect(snapshot.failures.size).toBe(0);
    expect(await t.load(0)).toEqual({ status: 'cancelled' });
    expect(t.loadListing).toHaveBeenCalledTimes(4);
  });

  it('treats an external abort like a disposal while requests are queued', async () => {
    const controller = new AbortController();
    const t = controlled({ signal: controller.signal });
    const results = Array.from({ length: 6 }, (_unused, index) => t.load(index));

    controller.abort();
    expect(await Promise.all(results)).toEqual(
      Array.from({ length: 6 }, () => ({ status: 'cancelled' })),
    );
    expect(t.calls.every((call) => call.signal.aborted)).toBe(true);
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3']);
    expect(t.loader.getSnapshot().tree.nodes.some((n) => n.activity === 'loading')).toBe(false);
  });

  it('starts nothing for a signal that was aborted before any request', async () => {
    const controller = new AbortController();
    controller.abort();
    const t = controlled({ signal: controller.signal });
    expect(await Promise.all([t.load(0), t.load(1), t.load(5)])).toEqual([
      { status: 'cancelled' },
      { status: 'cancelled' },
      { status: 'cancelled' },
    ]);
    expect(t.loadListing).not.toHaveBeenCalled();
  });

  it('cancels active and queued requests on a 401, calling back once', async () => {
    const onUnauthorized = vi.fn();
    const t = controlled({ onUnauthorized });
    const results = Array.from({ length: 8 }, (_unused, index) => t.load(index));

    t.callFor(2).fail(new GitHubApiError('unauthorized', { status: 401 }));
    const settled = await Promise.all(results);

    expect(settled.every((r) => r.status === 'unauthorized')).toBe(true);
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3']); // the queued four never started
    expect(t.calls.every((call) => call.signal.aborted)).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);

    const snapshot = t.loader.getSnapshot();
    expect(snapshot.unauthorized).toBe(true);
    expect(snapshot.failures.size).toBe(0);
    expect(snapshot.tree.nodes.some((n) => n.activity === 'loading')).toBe(false);
    expect(snapshot.tree.totals.exact).toBe(false);

    expect(await t.load(7)).toEqual({ status: 'unauthorized' });
    expect(t.loadListing).toHaveBeenCalledTimes(4);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not start a queued request when a 401 arrives while a late answer is pending', async () => {
    const t = controlled({}, false);
    const results = Array.from({ length: 6 }, (_unused, index) => t.load(index));
    t.callFor(0).fail(new GitHubApiError('unauthorized', { status: 401 }));
    await results[0];
    // An aborted request finishing afterwards frees its slot, but the queue is already empty.
    for (const index of [1, 2, 3]) t.callFor(index).succeed();
    expect((await Promise.all(results)).every((r) => r.status === 'unauthorized')).toBe(true);
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3']);
  });

  it('settles queued requests as blocked, without a request, when GitHub says to wait', async () => {
    const resetAt = FAR_FUTURE_SECONDS * 1000;
    const t = controlled();
    const results = Array.from({ length: 7 }, (_unused, index) => t.load(index));

    t.callFor(0).fail(new GitHubApiError('rate_limited', { status: 429, resetAt }));
    expect(await results[0]).toMatchObject({ status: 'failed', failure: { kind: 'rate_limited' } });

    // The three queued folders never reach the network; the three still active carry on.
    expect(await Promise.all(results.slice(4))).toEqual([
      { status: 'blocked', until: resetAt },
      { status: 'blocked', until: resetAt },
      { status: 'blocked', until: resetAt },
    ]);
    expect(t.started()).toEqual(['d0', 'd1', 'd2', 'd3']);
    expect(nodeAt(t.loader.getSnapshot(), 'd5')).toMatchObject({
      status: 'unloaded',
      activity: 'idle',
    });

    for (const index of [1, 2, 3]) t.callFor(index).succeed();
    await Promise.all(results.slice(1, 4));
    expect(t.loadListing).toHaveBeenCalledTimes(4);
  });

  it('settles queued requests as blocked when a response says the limit is used up', async () => {
    const resetAt = FAR_FUTURE_SECONDS * 1000;
    const t = controlled();
    const results = Array.from({ length: 6 }, (_unused, index) => t.load(index));
    t.callFor(0).succeed({ rateLimit: { remaining: 0, resetAt } });
    expect(await results[0]).toEqual({ status: 'loaded', added: 1 });
    expect(await Promise.all(results.slice(4))).toEqual([
      { status: 'blocked', until: resetAt },
      { status: 'blocked', until: resetAt },
    ]);
    expect(t.started()).toHaveLength(4);
  });

  it('honours a limit given as an option', async () => {
    const serial = controlled({ maxConcurrentRequests: 1 });
    const results = Array.from({ length: 3 }, (_unused, index) => serial.load(index));
    expect(serial.started()).toEqual(['d0']);
    serial.callFor(0).succeed();
    await results[0];
    expect(serial.started()).toEqual(['d0', 'd1']);
    serial.callFor(1).succeed();
    await results[1];
    serial.callFor(2).succeed();
    await results[2];
    expect(serial.peak()).toBe(1);

    const wide = controlled({ maxConcurrentRequests: 6 });
    for (let index = 0; index < 8; index += 1) void wide.load(index);
    expect(wide.started()).toHaveLength(6);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to four for an unusable limit (%s)',
    (limit) => {
      const t = controlled({ maxConcurrentRequests: limit });
      for (let index = 0; index < 8; index += 1) void t.load(index);
      expect(t.started()).toHaveLength(4);
    },
  );

  it('notifies once when a request is queued and once when it ends, as without a queue', async () => {
    const t = controlled();
    const listener = vi.fn();
    t.loader.subscribe(listener);
    const results = Array.from({ length: 8 }, (_unused, index) => t.load(index));
    expect(listener).toHaveBeenCalledTimes(8); // one "loading" per folder, queued or not

    for (let index = 0; index < 8; index += 1) {
      await Promise.resolve();
      t.callFor(index).succeed();
      await results[index];
    }
    expect(listener).toHaveBeenCalledTimes(16);
    expect(t.peak()).toBe(4);
    expect(t.loader.getSnapshot().tree.totals).toMatchObject({ files: 8, exact: true });
  });

  it('never exceeds four active requests over the real client, with a fake network', async () => {
    let active = 0;
    let peak = 0;
    const ids = WIDE.directories().filter((path) => path !== '');
    const handlers: Record<string, Handler> = {};
    const waiting: (() => void)[] = [];
    for (const path of ids) {
      handlers[treeRoute(WIDE.shaOf(path))] = async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => waiting.push(resolve));
        active -= 1;
        return okResponse(WIDE, path);
      };
    }
    const net = network(WIDE, handlers);
    const loader = lazyLoader(WIDE);
    const results = ids.map((path) => loader.loadDirectory(idOf(loader, path)));
    expect(net.requests).toHaveLength(4);

    while (net.requests.length < ids.length || waiting.length > 0) {
      waiting.shift()?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect((await Promise.all(results)).every((r) => r.status === 'loaded')).toBe(true);
    expect(peak).toBe(4);
    expect(net.requests).toHaveLength(8);
  });
});
