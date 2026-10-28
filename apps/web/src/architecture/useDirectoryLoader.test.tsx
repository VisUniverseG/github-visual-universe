import { act, cleanup, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryTree } from '../github/tree.ts';
import { TEST_TOKEN } from '../testing/fakeFetch.ts';
import { gated, okResponse, stubNetwork, treeRoute } from '../testing/treeNetwork.ts';
import {
  FixtureTree,
  blob,
  dirEntry,
  lazyTreeOf,
  completeTreeOf,
} from '../testing/treeFixtures.ts';
import { DirectoryLoader } from './loader.ts';
import {
  useDirectoryLoader,
  type DirectoryLoaderOptions,
  type DirectoryLoaderState,
} from './useDirectoryLoader.ts';

const ALPHA = new FixtureTree([
  blob('README.md', 100),
  dirEntry('src'),
  blob('src/index.ts', 300),
  dirEntry('src/util'),
  blob('src/util/math.ts', 50),
  dirEntry('docs'),
  blob('docs/guide.md', 1000),
]);

const BETA = new FixtureTree([
  blob('LICENSE', 10),
  dirEntry('lib'),
  blob('lib/a.js', 20),
  dirEntry('app'),
  blob('app/b.js', 30),
]);

const alphaTree = lazyTreeOf(ALPHA);
const betaTree = lazyTreeOf(BETA);

type Props = Partial<DirectoryLoaderOptions>;

const defaults = (): DirectoryLoaderOptions => ({
  accessToken: TEST_TOKEN,
  owner: 'octo',
  name: 'alpha',
  tree: alphaTree,
  onUnauthorized: () => undefined,
});

function mount(initial: Props = {}, strict = false) {
  const wrapper = strict
    ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
    : undefined;
  return renderHook((props: Props) => useDirectoryLoader({ ...defaults(), ...props }), {
    initialProps: initial,
    ...(wrapper === undefined ? {} : { wrapper }),
  });
}

/** The state of a hook that has a usable loader. */
function usable(state: DirectoryLoaderState) {
  if (!state.usable) throw new Error(`The tree was not usable (${state.reason}).`);
  return state;
}

const idOf = (state: DirectoryLoaderState, path: string): number => {
  const node = usable(state).snapshot.tree.nodes.find((candidate) => candidate.path === path);
  if (node === undefined) throw new Error(`No node at "${path}"`);
  return node.id;
};

const nodeOf = (state: DirectoryLoaderState, path: string) => {
  const node = usable(state).snapshot.tree.nodes.find((candidate) => candidate.path === path);
  if (node === undefined) throw new Error(`No node at "${path}"`);
  return node;
};

const loadPath = (state: DirectoryLoaderState, path: string) =>
  usable(state).loadDirectory(idOf(state, path));

/** Lets the end-of-task disposal of a cleaned-up loader run. */
const settled = () => act(() => Promise.resolve());

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useDirectoryLoader: the snapshot', () => {
  it.each([false, true])(
    'has the root on the first render, without a request (strict: %s)',
    (strict) => {
      const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
      const { result } = mount({}, strict);

      const state = usable(result.current);
      expect(state.snapshot.tree.totals).toMatchObject({ exact: false, unloadedDirectories: 2 });
      expect(nodeOf(result.current, 'src')).toMatchObject({ status: 'unloaded', activity: 'idle' });
      expect(net.requests).toHaveLength(0);
    },
  );

  it('starts a complete tree with everything loaded', () => {
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result } = mount({ tree: completeTreeOf(ALPHA) });
    expect(usable(result.current).snapshot.tree.totals).toMatchObject({
      exact: true,
      unloadedDirectories: 0,
    });
    expect(net.requests).toHaveLength(0);
  });

  it("is the loader's own snapshot object, and keeps it until something changes", () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result, rerender } = mount();
    const first = usable(result.current);
    rerender({});
    rerender({ onUnauthorized: () => undefined });
    expect(usable(result.current).snapshot).toBe(first.snapshot);
    expect(result.current).toBe(first);
  });
});

describe('useDirectoryLoader: updates', () => {
  it('shows a folder loading, then loaded, as the loader changes', async () => {
    const slow = gated(() => okResponse(ALPHA, 'src'));
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }], {
      [treeRoute('octo', 'alpha', ALPHA.shaOf('src'))]: slow.handler,
    });
    const { result } = mount();
    const initial = usable(result.current).snapshot;

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = loadPath(result.current, 'src');
    });
    expect(nodeOf(result.current, 'src')).toMatchObject({ status: 'loading', activity: 'loading' });
    expect(usable(result.current).snapshot).not.toBe(initial);

    await act(async () => {
      slow.release();
      await pending;
    });
    expect(nodeOf(result.current, 'src')).toMatchObject({
      status: 'shallow',
      activity: 'idle',
      bytes: 300,
    });
    expect(errors).not.toHaveBeenCalled();
  });

  it('loads a nested folder after its parent', async () => {
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result } = mount();

    await act(async () => {
      expect(await loadPath(result.current, 'src')).toEqual({ status: 'loaded', added: 2 });
    });
    await act(async () => {
      expect(await loadPath(result.current, 'src/util')).toEqual({ status: 'loaded', added: 1 });
    });

    expect(nodeOf(result.current, 'src')).toMatchObject({ status: 'complete', bytes: 350 });
    expect(usable(result.current).snapshot.tree.totals.bytes).toBe(450);
    expect(net.requests.map((request) => request.url.pathname)).toEqual([
      `/repos/octo/alpha/git/trees/${ALPHA.shaOf('src')}`,
      `/repos/octo/alpha/git/trees/${ALPHA.shaOf('src/util')}`,
    ]);
    expect(net.requests.every((request) => !request.url.searchParams.has('recursive'))).toBe(true);
  });

  it('keeps `loadDirectory` the same function while the loader is the same', async () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result, rerender } = mount();
    const before = usable(result.current).loadDirectory;

    await act(async () => {
      await loadPath(result.current, 'docs');
    });
    rerender({});
    expect(usable(result.current).loadDirectory).toBe(before);
  });

  it("keeps the loader's deduplication and concurrency limit", async () => {
    const fixture = new FixtureTree(
      Array.from({ length: 6 }, (_unused, index) => dirEntry(`d${String(index)}`)),
    );
    const slow = new Map(
      fixture
        .directories()
        .filter((path) => path !== '')
        .map((path) => [path, gated(() => okResponse(fixture, path))]),
    );
    const net = stubNetwork(
      [{ owner: 'octo', name: 'alpha', fixture }],
      Object.fromEntries(
        [...slow].map(([path, gate]) => [
          treeRoute('octo', 'alpha', fixture.shaOf(path)),
          gate.handler,
        ]),
      ),
    );
    const { result } = mount({ tree: lazyTreeOf(fixture) });

    const calls: Promise<unknown>[] = [];
    act(() => {
      for (let index = 0; index < 6; index += 1) {
        calls.push(loadPath(result.current, `d${String(index)}`));
      }
      // The same folder again shares the request already made.
      const again = loadPath(result.current, 'd0');
      expect(again).toBe(calls[0]);
    });
    expect(net.requests).toHaveLength(4);

    await act(async () => {
      slow.get('d0')?.release();
      await calls[0];
    });
    expect(net.requests).toHaveLength(5);

    await act(async () => {
      for (const gate of slow.values()) gate.release();
      await Promise.all(calls);
    });
    expect(net.requests).toHaveLength(6);
    expect(usable(result.current).snapshot.tree.totals).toMatchObject({ unloadedDirectories: 0 });
  });
});

describe('useDirectoryLoader: a different repository, token or tree', () => {
  it('makes a new loader for another repository, and disposes the old one first', async () => {
    const slow = gated(() => okResponse(ALPHA, 'src'));
    const net = stubNetwork(
      [
        { owner: 'octo', name: 'alpha', fixture: ALPHA },
        { owner: 'octo', name: 'beta', fixture: BETA },
      ],
      { [treeRoute('octo', 'alpha', ALPHA.shaOf('src'))]: slow.handler },
    );
    const dispose = vi.spyOn(DirectoryLoader.prototype, 'dispose');
    const { result, rerender } = mount();
    const before = usable(result.current);

    let stale: Promise<unknown> = Promise.resolve();
    act(() => {
      stale = loadPath(result.current, 'src');
    });
    const aborted = net.requests[0]?.init.signal;
    expect(aborted?.aborted).toBe(false);

    const disposedBefore = dispose.mock.calls.length;
    rerender({ name: 'beta', tree: betaTree });

    expect(dispose.mock.calls.length).toBeGreaterThan(disposedBefore);
    expect(aborted?.aborted).toBe(true);
    const after = usable(result.current);
    expect(after.loadDirectory).not.toBe(before.loadDirectory);
    expect(after.snapshot.tree.nodes.map((node) => node.path)).toEqual(
      expect.arrayContaining(['LICENSE', 'lib', 'app']),
    );
    expect(after.snapshot.tree.nodes.map((node) => node.path)).not.toContain('src');

    // The old request's answer arrives late: the new view is untouched.
    await act(async () => {
      slow.release();
      expect(await stale).toEqual({ status: 'cancelled' });
    });
    expect(usable(result.current).snapshot).toBe(after.snapshot);
    expect(errors).not.toHaveBeenCalled();
  });

  it("requests with the new repository's own address after the switch", async () => {
    const net = stubNetwork([
      { owner: 'octo', name: 'alpha', fixture: ALPHA },
      { owner: 'octo', name: 'beta', fixture: BETA },
    ]);
    const { result, rerender } = mount();
    rerender({ name: 'beta', tree: betaTree });

    await act(async () => {
      await loadPath(result.current, 'lib');
    });
    expect(net.requests.map((request) => request.url.pathname)).toEqual([
      `/repos/octo/beta/git/trees/${BETA.shaOf('lib')}`,
    ]);
    expect(nodeOf(result.current, 'lib')).toMatchObject({ status: 'complete', bytes: 20 });
  });

  it('makes a new loader for another token, and uses it from then on', async () => {
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result, rerender } = mount();
    const before = usable(result.current);

    await act(async () => {
      await loadPath(result.current, 'docs');
    });
    rerender({ accessToken: 'ghu_another_token' });

    const after = usable(result.current);
    expect(after.loadDirectory).not.toBe(before.loadDirectory);
    // A fresh loader starts again from the tree it was given.
    expect(nodeOf(result.current, 'docs')).toMatchObject({ status: 'unloaded' });
    await act(async () => {
      await loadPath(result.current, 'docs');
    });
    expect(net.requests.map((request) => request.headers.get('authorization'))).toEqual([
      `Bearer ${TEST_TOKEN}`,
      'Bearer ghu_another_token',
    ]);
  });

  it('makes a new loader when the tree is another object, and keeps the loader when it is not', () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const create = vi.spyOn(DirectoryLoader, 'create');
    const { result, rerender } = mount();
    const first = usable(result.current);
    const createdAtStart = create.mock.calls.length;

    rerender({ tree: alphaTree }); // the same object
    expect(create.mock.calls.length).toBe(createdAtStart);
    expect(usable(result.current).loadDirectory).toBe(first.loadDirectory);

    rerender({ tree: { ...alphaTree } }); // an equal copy is still another tree
    expect(create.mock.calls.length).toBe(createdAtStart + 1);
    expect(usable(result.current).loadDirectory).not.toBe(first.loadDirectory);
  });

  it('does not make a new loader when only `onUnauthorized` changes', () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const create = vi.spyOn(DirectoryLoader, 'create');
    const { rerender } = mount();
    const count = create.mock.calls.length;
    for (let round = 0; round < 3; round += 1) rerender({ onUnauthorized: () => undefined });
    expect(create.mock.calls.length).toBe(count);
  });
});

describe('useDirectoryLoader: unmounting', () => {
  it('disposes the loader, aborts what is in flight, and ignores the late answer', async () => {
    const slow = gated(() => okResponse(ALPHA, 'src'));
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }], {
      [treeRoute('octo', 'alpha', ALPHA.shaOf('src'))]: slow.handler,
    });
    const loadSpy = vi.spyOn(DirectoryLoader.prototype, 'loadDirectory');
    const { result, unmount } = mount();

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = loadPath(result.current, 'src');
    });
    const loader = loadSpy.mock.contexts[0] as DirectoryLoader;
    expect(loader.disposed).toBe(false);

    unmount();
    await settled();
    expect(loader.disposed).toBe(true);
    expect(net.requests[0]?.init.signal?.aborted).toBe(true);

    slow.release();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(errors).not.toHaveBeenCalled(); // no state update on an unmounted component
  });

  it('unsubscribes: nothing is notified after the unmount', async () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const subscribe = vi.spyOn(DirectoryLoader.prototype, 'subscribe');
    const { result, unmount } = mount();
    const load = usable(result.current).loadDirectory;
    const docs = idOf(result.current, 'docs');
    unmount();
    await settled();
    expect(subscribe).toHaveBeenCalled();

    await expect(load(docs)).resolves.toEqual({ status: 'cancelled' });
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('useDirectoryLoader: Strict Mode', () => {
  it('ends with a working loader after the effect was cleaned up and set up again', async () => {
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const loadSpy = vi.spyOn(DirectoryLoader.prototype, 'loadDirectory');
    const { result, unmount } = mount({}, true);

    await act(async () => {
      expect(await loadPath(result.current, 'src')).toEqual({ status: 'loaded', added: 2 });
    });
    expect(nodeOf(result.current, 'src')).toMatchObject({ status: 'shallow', bytes: 300 });
    expect(net.requests).toHaveLength(1);

    // Whichever loader served the request is the live one, and unmounting disposes it.
    const live = loadSpy.mock.contexts[0] as DirectoryLoader;
    expect(live.disposed).toBe(false);
    unmount();
    await settled();
    expect(live.disposed).toBe(true);
    expect(errors).not.toHaveBeenCalled();
  });

  it('keeps the very same loader through the cleanup and setup, so nothing is recreated', async () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result } = mount({}, true);
    const first = usable(result.current);
    await settled();
    await settled();
    expect(usable(result.current).loadDirectory).toBe(first.loadDirectory);
    expect(usable(result.current).snapshot).toBe(first.snapshot);
  });

  it('keeps what was loaded when it is mounted, cleaned up and set up again', async () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result } = mount({}, true);
    await act(async () => {
      await loadPath(result.current, 'src');
    });
    // React 19 re-runs Strict Mode effects only on mount: a rerender must not lose the data.
    expect(nodeOf(result.current, 'src')).toMatchObject({ status: 'shallow', bytes: 300 });
    await settled();
    expect(nodeOf(result.current, 'src')).toMatchObject({ status: 'shallow', bytes: 300 });
  });

  it('shows the root immediately, and makes no request of its own', () => {
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result } = mount({}, true);
    expect(usable(result.current).snapshot.tree.root.children).toHaveLength(3);
    expect(net.requests).toHaveLength(0);
  });

  it('still switches repositories cleanly', async () => {
    const net = stubNetwork([
      { owner: 'octo', name: 'alpha', fixture: ALPHA },
      { owner: 'octo', name: 'beta', fixture: BETA },
    ]);
    const { result, rerender } = mount({}, true);
    rerender({ name: 'beta', tree: betaTree });
    await act(async () => {
      await loadPath(result.current, 'app');
    });
    expect(nodeOf(result.current, 'app')).toMatchObject({ status: 'complete', bytes: 30 });
    expect(net.requests).toHaveLength(1);
  });
});

describe('useDirectoryLoader: external cancellation', () => {
  it('disposes the loader when the signal aborts, settling what is queued as cancelled', async () => {
    const controller = new AbortController();
    const slow = gated(() => okResponse(ALPHA, 'src'));
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }], {
      [treeRoute('octo', 'alpha', ALPHA.shaOf('src'))]: slow.handler,
    });
    const { result } = mount({ signal: controller.signal });

    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = loadPath(result.current, 'src');
    });
    act(() => {
      controller.abort();
    });
    expect(net.requests[0]?.init.signal?.aborted).toBe(true);
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(await loadPath(result.current, 'docs')).toEqual({ status: 'cancelled' });
    expect(net.requests).toHaveLength(1);
    expect(nodeOf(result.current, 'src')).toMatchObject({ activity: 'idle' });
  });

  it('starts nothing, and does not recreate the loader, when the signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const create = vi.spyOn(DirectoryLoader, 'create');
    const { result } = mount({ signal: controller.signal }, true);

    expect(await loadPath(result.current, 'src')).toEqual({ status: 'cancelled' });
    expect(net.requests).toHaveLength(0);
    expect(create.mock.calls.length).toBeLessThan(6); // no endless re-creation
  });

  it('makes a fresh loader when the one it had was disposed while no effect was set up', async () => {
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const { result, rerender } = mount();
    const before = usable(result.current);

    // Something outside React disposed it (a hidden `Activity` cleans up and re-runs effects).
    const loadSpy = vi.spyOn(DirectoryLoader.prototype, 'loadDirectory');
    await act(async () => {
      await loadPath(result.current, 'docs');
    });
    (loadSpy.mock.contexts[0] as DirectoryLoader).dispose();
    rerender({ signal: new AbortController().signal });
    await settled();

    const after = usable(result.current);
    expect(after.loadDirectory).not.toBe(before.loadDirectory);
    expect(nodeOf(result.current, 'docs')).toMatchObject({ status: 'unloaded' });
    await act(async () => {
      expect(await loadPath(result.current, 'docs')).toEqual({ status: 'loaded', added: 1 });
    });
    expect(net.requests).toHaveLength(2);
  });

  it('stops listening to the signal when it unmounts', async () => {
    const controller = new AbortController();
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const dispose = vi.spyOn(DirectoryLoader.prototype, 'dispose');
    const { unmount } = mount({ signal: controller.signal });
    unmount();
    await settled();
    const afterUnmount = dispose.mock.calls.length;
    controller.abort();
    expect(dispose.mock.calls.length).toBe(afterUnmount);
  });
});

describe('useDirectoryLoader: authentication', () => {
  const unauthorized = () => new Response('{}', { status: 401 });

  it('calls the latest `onUnauthorized`, once', async () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }], {
      [treeRoute('octo', 'alpha', ALPHA.shaOf('docs'))]: unauthorized,
    });
    const first = vi.fn();
    const latest = vi.fn();
    const { result, rerender } = mount({ onUnauthorized: first });
    rerender({ onUnauthorized: latest });

    await act(async () => {
      expect(await loadPath(result.current, 'docs')).toEqual({ status: 'unauthorized' });
    });
    expect(usable(result.current).snapshot.unauthorized).toBe(true);
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('reports a tree it cannot use instead of throwing', () => {
    stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }]);
    const broken: RepositoryTree = { ...alphaTree, treeSha: 'not-a-sha' };
    const { result } = mount({ tree: broken });
    expect(result.current).toEqual({ usable: false, reason: 'invalid-sha' });
  });

  it('surfaces a failed folder as data, and a retry as a new request', async () => {
    let fail = true;
    const net = stubNetwork([{ owner: 'octo', name: 'alpha', fixture: ALPHA }], {
      [treeRoute('octo', 'alpha', ALPHA.shaOf('docs'))]: () =>
        fail ? new Response('{}', { status: 503 }) : okResponse(ALPHA, 'docs'),
    });
    const { result } = mount();
    const docs = idOf(result.current, 'docs');

    await act(async () => {
      await usable(result.current).loadDirectory(docs);
    });
    expect(nodeOf(result.current, 'docs')).toMatchObject({ status: 'failed', activity: 'failed' });
    expect(usable(result.current).snapshot.failures.get(docs)).toMatchObject({
      kind: 'http',
      status: 503,
      retryable: true,
    });

    fail = false;
    await act(async () => {
      await usable(result.current).loadDirectory(docs);
    });
    expect(nodeOf(result.current, 'docs')).toMatchObject({ status: 'complete', activity: 'idle' });
    expect(usable(result.current).snapshot.failures.size).toBe(0);
    expect(net.requests).toHaveLength(2);
  });
});
