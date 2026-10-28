import type { GitHubTreeEntry } from '@gvu/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import {
  FixtureTree,
  blob,
  dirEntry,
  fakeSha,
  submodule,
  symlink,
} from '../testing/treeFixtures.ts';
import {
  loadRepositoryTree,
  loadTreeListing,
  type CompleteRepositoryTree,
  type LazyRepositoryTree,
  type RepositoryTree,
  type TreeListing,
} from '../github/tree.ts';
import { createTreeStore, directoryListingOf, rootListingOf, type AdaptResult } from './adapter.ts';
import { TreeStore, type TreeNode, type TreeSnapshot } from './store.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

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

const base = {
  branch: 'main',
  commitSha: fakeSha(900),
  rateLimit: null,
} as const;

function completeTree(
  fixture: FixtureTree = REPO,
  overrides: Partial<CompleteRepositoryTree> = {},
): CompleteRepositoryTree {
  return {
    ...base,
    mode: 'complete',
    treeSha: fixture.shaOf(''),
    entries: fixture.entries,
    skipped: 0,
    truncated: false,
    ...overrides,
  };
}

function lazyTree(
  fixture: FixtureTree = REPO,
  overrides: Partial<LazyRepositoryTree> = {},
): LazyRepositoryTree {
  return {
    ...base,
    mode: 'lazy',
    treeSha: fixture.shaOf(''),
    entries: fixture.listing('').entries,
    skipped: 0,
    truncated: true,
    rootTruncated: false,
    ...overrides,
  };
}

function treeListing(
  fixture: FixtureTree,
  path: string,
  options: { recursive?: boolean } & Partial<TreeListing> = {},
): TreeListing {
  const { recursive = false, ...overrides } = options;
  const source = recursive ? fixture.recursiveListing(path) : fixture.listing(path);
  return {
    sha: source.sha ?? fixture.shaOf(path),
    recursive,
    entries: source.entries,
    skipped: 0,
    truncated: false,
    rateLimit: { remaining: 4000, resetAt: 1_800_000_000_000 },
    ...overrides,
  };
}

function unwrap<T>(result: AdaptResult<T>): T {
  if (!result.ok) throw new Error(`Expected the adapter to accept this (${result.reason}).`);
  return result.value;
}

const at = (snapshot: TreeSnapshot, path: string): TreeNode => {
  const node = snapshot.nodes.find((candidate) => candidate.path === path);
  if (node === undefined) throw new Error(`No node at "${path}"`);
  return node;
};

/** Two snapshots of the same content differ in `version` if one was read more often. */
const sameApartFromVersion = (snapshot: TreeSnapshot) => ({ ...snapshot, version: 0 });

/** What the views draw for every node, keyed by path. */
const byPath = (snapshot: TreeSnapshot) =>
  Object.fromEntries(
    snapshot.nodes.map((n) => [
      n.path,
      [
        n.kind,
        n.bytes,
        n.fileCount,
        n.directoryCount,
        n.status,
        n.exact,
        n.children.map((c) => c.path),
      ],
    ]),
  );

/** Hands the store an untyped value, as a caller with corrupt data would. */
const loose = <T>(value: unknown): T => value as T;

// -----------------------------------------------------------------------------------------------
// The root listing
// -----------------------------------------------------------------------------------------------

describe('rootListingOf: a complete recursive tree', () => {
  it('becomes a recursive root listing for the same tree SHA', () => {
    const listing = unwrap(rootListingOf(completeTree()));
    expect(listing).toEqual({
      sha: REPO.shaOf(''),
      recursive: true,
      entries: REPO.entries,
      skipped: 0,
      truncated: false,
    });
  });

  it('produces the same store as the equivalent hand-built listing', () => {
    const adapted = TreeStore.fromRootListing(unwrap(rootListingOf(completeTree()))).snapshot();
    const manual = TreeStore.fromRootListing(REPO.recursiveListing('')).snapshot();
    expect(sameApartFromVersion(adapted)).toEqual(sameApartFromVersion(manual));
    expect(adapted.totals).toMatchObject({
      files: 4,
      directories: 4,
      bytes: 1450,
      exact: true,
      unloadedDirectories: 0,
    });
    expect(adapted.root.status).toBe('complete');
  });

  it('carries entries the store needs to the store unchanged: names, sizes, kinds', () => {
    const fixture = new FixtureTree([
      blob('a.txt', 5),
      blob('no-size.txt'),
      symlink('link', 8),
      submodule('vendor'),
      dirEntry('d'),
    ]);
    const snapshot = TreeStore.fromRootListing(
      unwrap(rootListingOf(completeTree(fixture))),
    ).snapshot();
    expect(snapshot.root.children.map((n) => [n.name, n.kind, n.bytes])).toEqual([
      ['d', 'directory', 0],
      ['a.txt', 'file', 5],
      ['link', 'symlink', 8],
      ['no-size.txt', 'file', null],
      ['vendor', 'submodule', null],
    ]);
  });
});

describe('rootListingOf: a lazy tree', () => {
  it('becomes a direct root listing; the repository being incomplete is not the root being cut off', () => {
    const tree = lazyTree();
    expect(tree.truncated).toBe(true);
    expect(unwrap(rootListingOf(tree))).toEqual({
      sha: REPO.shaOf(''),
      recursive: false,
      entries: REPO.listing('').entries,
      skipped: 0,
      truncated: false, // the root listing itself was whole
    });
  });

  it('produces the same store as the equivalent hand-built listing', () => {
    const adapted = TreeStore.fromRootListing(unwrap(rootListingOf(lazyTree()))).snapshot();
    const manual = TreeStore.fromRootListing(REPO.listing('')).snapshot();
    expect(sameApartFromVersion(adapted)).toEqual(sameApartFromVersion(manual));
  });

  it('leaves unloaded folders unknown, never zero, and the totals as lower bounds', () => {
    const snapshot = TreeStore.fromRootListing(unwrap(rootListingOf(lazyTree()))).snapshot();
    expect(snapshot.totals).toMatchObject({
      files: 1,
      directories: 3,
      bytes: 100,
      unloadedDirectories: 3,
      exact: false,
    });
    for (const name of ['src', 'docs', 'empty']) {
      expect(at(snapshot, name)).toMatchObject({
        status: 'unloaded',
        bytes: null,
        fileCount: null,
        directoryCount: null,
        loadable: true,
        sha: REPO.shaOf(name),
      });
    }
  });

  it('passes on that the root listing itself was cut off', () => {
    const listing = unwrap(rootListingOf(lazyTree(REPO, { rootTruncated: true })));
    expect(listing).toMatchObject({ recursive: false, truncated: true });
    const snapshot = TreeStore.fromRootListing(listing).snapshot();
    expect(snapshot.root).toMatchObject({ truncated: true, exact: false });
  });

  it('keeps a lazy tree with no folders at all inexact only if the root was cut off', () => {
    const flat = new FixtureTree([blob('a.txt', 1), blob('b.txt', 2)]);
    const whole = TreeStore.fromRootListing(unwrap(rootListingOf(lazyTree(flat)))).snapshot();
    expect(whole.totals.exact).toBe(true); // nothing below to load, nothing missing
    const cut = TreeStore.fromRootListing(
      unwrap(rootListingOf(lazyTree(flat, { rootTruncated: true }))),
    ).snapshot();
    expect(cut.totals.exact).toBe(false);
  });
});

describe('rootListingOf: completeness information', () => {
  it('adds entries GitHub reported as unreadable to the count, so nothing is called exact', () => {
    const complete = TreeStore.fromRootListing(
      unwrap(rootListingOf(completeTree(REPO, { skipped: 3 }))),
    ).snapshot();
    expect(complete.skipped).toBe(3);
    expect(complete.totals.exact).toBe(false);

    const lazy = TreeStore.fromRootListing(
      unwrap(rootListingOf(lazyTree(REPO, { skipped: 2 }))),
    ).snapshot();
    expect(lazy.skipped).toBe(2);
    expect(lazy.root).toMatchObject({ unreadable: 2, exact: false });
  });

  it('does not change the tree it is given', () => {
    const tree = completeTree();
    const before = JSON.stringify(tree);
    rootListingOf(tree);
    createTreeStore(tree);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('is deterministic', () => {
    expect(rootListingOf(lazyTree())).toEqual(rootListingOf(lazyTree()));
  });

  it('makes no network request', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in the adapter')));
    vi.stubGlobal('fetch', fetchSpy);
    createTreeStore(completeTree());
    createTreeStore(lazyTree());
    directoryListingOf(treeListing(REPO, 'src'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------------------------
// Malformed and incomplete data
// -----------------------------------------------------------------------------------------------

describe('rootListingOf: malformed or incomplete data', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['too short', 'abc123'],
    ['upper case', 'A'.repeat(40)],
    ['path-like', '../../user'],
    ['carrying a query', `${'a'.repeat(40)}?x=1`],
    ['a number', 12345],
  ])('refuses a root whose tree SHA is %s, and never invents one', (_name, treeSha) => {
    for (const tree of [completeTree(), lazyTree()]) {
      const result = rootListingOf(loose<RepositoryTree>({ ...tree, treeSha }));
      expect(result).toEqual({ ok: false, reason: 'invalid-sha' });
    }
  });

  it('refuses a "complete" tree that says it was truncated', () => {
    // The entries could be a cut-off recursive listing, so none of them may be used.
    expect(rootListingOf(loose<RepositoryTree>({ ...completeTree(), truncated: true }))).toEqual({
      ok: false,
      reason: 'inconsistent',
    });
  });

  it('refuses a "lazy" tree that says it was not truncated', () => {
    expect(rootListingOf(loose<RepositoryTree>({ ...lazyTree(), truncated: false }))).toEqual({
      ok: false,
      reason: 'inconsistent',
    });
  });

  it.each([
    ['a missing truncated flag', { truncated: undefined }],
    ['a string truncated flag', { truncated: 'false' }],
    ['a null truncated flag', { truncated: null }],
  ])('refuses a complete tree with %s', (_name, patch) => {
    expect(rootListingOf(loose<RepositoryTree>({ ...completeTree(), ...patch }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it.each([
    ['a missing rootTruncated flag', { rootTruncated: undefined }],
    ['a string rootTruncated flag', { rootTruncated: 'no' }],
    ['a negative skipped count', { skipped: -1 }],
    ['a fractional skipped count', { skipped: 1.5 }],
    ['a NaN skipped count', { skipped: Number.NaN }],
    ['an infinite skipped count', { skipped: Number.POSITIVE_INFINITY }],
    ['a string skipped count', { skipped: '2' }],
    ['a missing skipped count', { skipped: undefined }],
    ['entries that are not a list', { entries: 'nope' }],
    ['missing entries', { entries: undefined }],
    ['entries that are an object', { entries: { 0: { path: 'a', type: 'blob' } } }],
  ])('refuses a lazy tree with %s', (_name, patch) => {
    expect(rootListingOf(loose<RepositoryTree>({ ...lazyTree(), ...patch }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('refuses a tree of an unknown mode', () => {
    expect(rootListingOf(loose<RepositoryTree>({ ...completeTree(), mode: 'partial' }))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('leaves out entries that cannot be read and counts them, rather than losing them silently', () => {
    const entries = loose<GitHubTreeEntry[]>([
      ...REPO.entries,
      { path: 'future', type: 'unknown-kind' },
      { nope: 1 },
      'not an object',
      null,
      { path: '', type: 'blob' },
      { path: 'x'.repeat(5000), type: 'blob' },
    ]);
    const listing = unwrap(rootListingOf(completeTree(REPO, { entries, skipped: 1 })));
    expect(listing.entries).toHaveLength(REPO.entries.length);
    expect(listing.skipped).toBe(1 + 6);

    const snapshot = TreeStore.fromRootListing(listing).snapshot();
    expect(snapshot.skipped).toBe(7);
    expect(snapshot.totals.exact).toBe(false);
    expect(snapshot.totals.files).toBe(4);
  });

  it('keeps a folder with a malformed or missing SHA, but as one that cannot be loaded', () => {
    const entries = loose<GitHubTreeEntry[]>([
      { path: 'good', type: 'tree', sha: fakeSha(5) },
      { path: 'missing', type: 'tree' },
      { path: 'null', type: 'tree', sha: null },
      { path: 'hostile', type: 'tree', sha: '../../user' },
      { path: 'short', type: 'tree', sha: 'abc' },
      { path: 'number', type: 'tree', sha: 42 },
    ]);
    const listing = unwrap(rootListingOf(lazyTree(REPO, { entries })));

    // No SHA was invented for any of them.
    expect(listing.entries.map((e) => e.sha ?? null)).toEqual([
      fakeSha(5),
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(listing.skipped).toBe(0);

    const snapshot = TreeStore.fromRootListing(listing).snapshot();
    expect(at(snapshot, 'good')).toMatchObject({ loadable: true, sha: fakeSha(5) });
    for (const name of ['missing', 'null', 'hostile', 'short', 'number']) {
      expect(at(snapshot, name)).toMatchObject({
        kind: 'directory',
        status: 'unloaded',
        loadable: false,
        sha: null,
        bytes: null,
        fileCount: null,
      });
    }
    expect(snapshot.totals).toMatchObject({ exact: false, unloadedDirectories: 6 });
  });

  it('does not turn a missing, malformed or negative file size into zero', () => {
    const entries = loose<GitHubTreeEntry[]>([
      { path: 'absent.txt', type: 'blob', mode: '100644' },
      { path: 'null.txt', type: 'blob', size: null },
      { path: 'string.txt', type: 'blob', size: '12' },
      { path: 'negative.txt', type: 'blob', size: -5 },
      { path: 'fraction.txt', type: 'blob', size: 1.5 },
      { path: 'real.txt', type: 'blob', size: 9 },
      { path: 'zero.txt', type: 'blob', size: 0 },
    ]);
    const snapshot = TreeStore.fromRootListing(
      unwrap(rootListingOf(completeTree(REPO, { entries }))),
    ).snapshot();

    for (const name of ['absent.txt', 'null.txt', 'string.txt', 'negative.txt', 'fraction.txt']) {
      expect(at(snapshot, name).bytes).toBeNull();
    }
    // A genuine zero stays a zero, and is the only one.
    expect(at(snapshot, 'zero.txt').bytes).toBe(0);
    expect(at(snapshot, 'real.txt').bytes).toBe(9);
    expect(snapshot.totals).toMatchObject({
      files: 7,
      bytes: 9,
      filesWithoutSize: 5,
      exact: true,
      bytesExact: false,
    });
    expect(snapshot.skipped).toBe(0); // the entries were kept, only their sizes are unknown
  });

  it('passes bad paths to the store, which counts them (the adapter does not judge paths)', () => {
    const entries: GitHubTreeEntry[] = [
      { path: 'ok.txt', type: 'blob', size: 1 },
      { path: 'a//b.txt', type: 'blob', size: 1 },
      { path: '/abs.txt', type: 'blob', size: 1 },
      { path: 'trailing/', type: 'blob', size: 1 },
      { path: '../../etc/passwd', type: 'blob', size: 1 },
    ];
    const listing = unwrap(rootListingOf(completeTree(REPO, { entries })));
    expect(listing.entries.map((e) => e.path)).toEqual(entries.map((e) => e.path));

    const snapshot = TreeStore.fromRootListing(listing).snapshot();
    expect(snapshot.inconsistent).toBe(3);
    expect(snapshot.totals.exact).toBe(false);
    // `..` is just a name: nothing is resolved.
    expect(snapshot.nodes.map((n) => n.path)).toContain('../../etc/passwd');
  });

  it('passes a nested path in a lazy root to the store, which counts it', () => {
    const entries: GitHubTreeEntry[] = [
      { path: 'a.txt', type: 'blob', size: 1 },
      { path: 'deep/b.txt', type: 'blob', size: 1 },
    ];
    const snapshot = TreeStore.fromRootListing(
      unwrap(rootListingOf(lazyTree(REPO, { entries }))),
    ).snapshot();
    expect(snapshot.inconsistent).toBe(1);
    expect(snapshot.nodes.map((n) => n.path)).toEqual(['', 'a.txt']);
  });

  it('handles a very large tree', () => {
    const many = new FixtureTree(
      Array.from({ length: 1000 }, (_u, dir) => [
        dirEntry(`pkg${String(dir)}`),
        ...Array.from({ length: 99 }, (_v, file) =>
          blob(`pkg${String(dir)}/f${String(file)}.ts`, 10),
        ),
      ]).flat(),
    );
    const listing = unwrap(rootListingOf(completeTree(many)));
    expect(listing.entries).toHaveLength(100_000);
    const snapshot = TreeStore.fromRootListing(listing).snapshot();
    expect(snapshot.totals).toMatchObject({ files: 99_000, bytes: 990_000, exact: true });
  }, 30_000);
});

// -----------------------------------------------------------------------------------------------
// createTreeStore
// -----------------------------------------------------------------------------------------------

describe('createTreeStore', () => {
  it('starts a store from either shape', () => {
    expect(unwrap(createTreeStore(completeTree())).snapshot().totals.exact).toBe(true);
    expect(unwrap(createTreeStore(lazyTree())).snapshot().totals.exact).toBe(false);
  });

  it('reports why it could not, instead of throwing', () => {
    expect(createTreeStore(loose<RepositoryTree>({ ...completeTree(), treeSha: 'bad' }))).toEqual({
      ok: false,
      reason: 'invalid-sha',
    });
    expect(createTreeStore(loose<RepositoryTree>({ ...completeTree(), truncated: true }))).toEqual({
      ok: false,
      reason: 'inconsistent',
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Directory listings
// -----------------------------------------------------------------------------------------------

describe('directoryListingOf', () => {
  it('keeps what the store reads, and drops the rate limit', () => {
    const listing = unwrap(directoryListingOf(treeListing(REPO, 'src')));
    expect(listing).toEqual({
      sha: REPO.shaOf('src'),
      recursive: false,
      entries: REPO.listing('src').entries,
      skipped: 0,
      truncated: false,
    });
    expect(Object.keys(listing).sort()).toEqual([
      'entries',
      'recursive',
      'sha',
      'skipped',
      'truncated',
    ]);
  });

  it('attaches a nested listing, giving the same store as the hand-built listing', () => {
    const viaAdapter = unwrap(createTreeStore(lazyTree()));
    const manual = TreeStore.fromRootListing(REPO.listing(''));
    const folders = ['src', 'src/util', 'docs'];
    for (const path of folders) {
      const adapted = unwrap(directoryListingOf(treeListing(REPO, path)));
      const id = at(viaAdapter.snapshot(), path).id;
      expect(viaAdapter.attach(id, adapted)).toEqual(manual.attach(id, REPO.listing(path)));
    }
    expect(sameApartFromVersion(viaAdapter.snapshot())).toEqual(
      sameApartFromVersion(manual.snapshot()),
    );

    const snapshot = viaAdapter.snapshot();
    expect(at(snapshot, 'src')).toMatchObject({ status: 'complete', bytes: 350, exact: true });
    expect(snapshot.root).toMatchObject({ exact: false, unloadedDirectories: 1 }); // `empty`
    expect(at(snapshot, 'empty').bytes).toBeNull(); // still unknown, not zero
  });

  it('completes a lazy tree folder by folder to the same result as the complete tree', () => {
    const lazy = unwrap(createTreeStore(lazyTree()));
    for (const path of ['docs', 'empty', 'src', 'src/util']) {
      const result = lazy.attach(
        at(lazy.snapshot(), path).id,
        unwrap(directoryListingOf(treeListing(REPO, path))),
      );
      expect(result.applied).toBe(true);
    }
    const whole = unwrap(createTreeStore(completeTree())).snapshot();
    const snapshot = lazy.snapshot();
    expect(snapshot.totals).toEqual(whole.totals);
    expect(snapshot.extensions).toEqual(whole.extensions);
    // Node ids follow load order, so compare by path.
    expect(byPath(snapshot)).toEqual(byPath(whole));
  });

  it('attaches a recursive listing of a folder and completes everything below it', () => {
    const store = unwrap(createTreeStore(lazyTree()));
    const adapted = unwrap(directoryListingOf(treeListing(REPO, 'src', { recursive: true })));
    expect(adapted.recursive).toBe(true);
    store.attach(at(store.snapshot(), 'src').id, adapted);
    expect(at(store.snapshot(), 'src/util')).toMatchObject({ status: 'complete', bytes: 50 });
  });

  it('passes a truncated recursive listing on faithfully; the store rejects it', () => {
    const store = unwrap(createTreeStore(lazyTree()));
    const before = store.snapshot();
    const adapted = unwrap(
      directoryListingOf(treeListing(REPO, 'src', { recursive: true, truncated: true })),
    );
    expect(adapted).toMatchObject({ recursive: true, truncated: true });
    expect(store.attach(at(before, 'src').id, adapted)).toEqual({
      applied: false,
      reason: 'truncated-recursive',
    });
    expect(store.snapshot()).toBe(before);
  });

  it('passes a truncated direct listing on, so the folder is shown partial and never complete', () => {
    const store = unwrap(createTreeStore(lazyTree()));
    const adapted = unwrap(directoryListingOf(treeListing(REPO, 'docs', { truncated: true })));
    store.attach(at(store.snapshot(), 'docs').id, adapted);
    expect(at(store.snapshot(), 'docs')).toMatchObject({
      status: 'shallow',
      truncated: true,
      exact: false,
      bytes: 1000,
    });
  });

  it('counts unreadable entries in a directory listing, and keeps the folder from being complete', () => {
    const store = unwrap(createTreeStore(lazyTree()));
    const listing = treeListing(REPO, 'docs', {
      skipped: 1,
      entries: loose<GitHubTreeEntry[]>([...REPO.listing('docs').entries, { type: 'blob' }, 7]),
    });
    store.attach(at(store.snapshot(), 'docs').id, unwrap(directoryListingOf(listing)));
    expect(at(store.snapshot(), 'docs')).toMatchObject({ status: 'shallow', unreadable: 3 });
    expect(store.snapshot().skipped).toBe(3);
  });

  it.each([
    ['missing', undefined],
    ["null (which would skip the store's identity check)", null],
    ['empty', ''],
    ['path-like', '../../user'],
    ['too short', 'abc'],
    ['a number', 7],
  ])('refuses a listing whose SHA is %s', (_name, sha) => {
    const result = directoryListingOf(loose<TreeListing>({ ...treeListing(REPO, 'src'), sha }));
    expect(result).toEqual({ ok: false, reason: 'invalid-sha' });
  });

  it.each([
    ['a non-boolean recursive flag', { recursive: 'yes' }],
    ['a missing truncated flag', { truncated: undefined }],
    ['a negative skipped count', { skipped: -2 }],
    ['a NaN skipped count', { skipped: Number.NaN }],
    ['entries that are not a list', { entries: null }],
  ])('refuses a listing with %s', (_name, patch) => {
    const result = directoryListingOf(
      loose<TreeListing>({ ...treeListing(REPO, 'src'), ...patch }),
    );
    expect(result).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a listing for the wrong folder at the store (the SHA is carried, not assumed)', () => {
    const store = unwrap(createTreeStore(lazyTree()));
    const before = store.snapshot();
    const wrong = unwrap(directoryListingOf(treeListing(REPO, 'docs')));
    expect(store.attach(at(before, 'src').id, wrong)).toEqual({
      applied: false,
      reason: 'sha-mismatch',
    });
    expect(store.snapshot()).toBe(before);
  });

  it('keeps submodules and symlinks as leaves that cannot be loaded', () => {
    const fixture = new FixtureTree([
      dirEntry('src'),
      symlink('src/link', 4),
      submodule('src/vendor'),
      blob('src/a.ts'),
    ]);
    const store = unwrap(createTreeStore(lazyTree(fixture)));
    store.attach(
      at(store.snapshot(), 'src').id,
      unwrap(directoryListingOf(treeListing(fixture, 'src'))),
    );
    const snapshot = store.snapshot();
    expect(at(snapshot, 'src/link')).toMatchObject({ kind: 'symlink', bytes: 4, loadable: false });
    expect(at(snapshot, 'src/vendor')).toMatchObject({
      kind: 'submodule',
      bytes: null,
      loadable: false,
      status: null,
    });
    expect(at(snapshot, 'src/a.ts')).toMatchObject({ kind: 'file', bytes: null });
    expect(snapshot.totals).toMatchObject({
      symlinks: 1,
      submodules: 1,
      files: 1,
      filesWithoutSize: 1,
    });
    // A submodule's SHA is never offered as something to load.
    const asFolder = store.attach(
      at(snapshot, 'src/vendor').id,
      unwrap(directoryListingOf(treeListing(fixture, 'src'))),
    );
    expect(asFolder).toEqual({ applied: false, reason: 'not-a-directory' });
  });

  it('is deterministic and leaves its input alone', () => {
    const input = treeListing(REPO, 'src');
    const before = JSON.stringify(input);
    expect(directoryListingOf(input)).toEqual(directoryListingOf(input));
    expect(JSON.stringify(input)).toBe(before);
  });
});

// -----------------------------------------------------------------------------------------------
// End to end with the real client (against a fake network)
// -----------------------------------------------------------------------------------------------

describe('the client output, adapted and stored', () => {
  const GH = 'https://api.github.com';
  const COMMIT = 'c'.repeat(40);
  const ROOT = REPO.shaOf('');
  const TREE_ROUTE = (sha: string) => `GET ${GH}/repos/octo/alpha/git/trees/${sha}`;

  const treeJson = (sha: string, tree: readonly unknown[], truncated = false) =>
    Response.json({ sha, truncated, tree });

  function network(overrides: Record<string, Handler> = {}) {
    const net = createFakeFetch({
      [`GET ${GH}/repos/octo/alpha/branches/main`]: () =>
        Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: ROOT } } } }),
      [TREE_ROUTE(ROOT)]: () => treeJson(ROOT, REPO.entries),
      [TREE_ROUTE(REPO.shaOf('src'))]: () =>
        treeJson(REPO.shaOf('src'), REPO.listing('src').entries),
      ...overrides,
    });
    vi.stubGlobal('fetch', net.fetch);
    return net;
  }

  const target = { owner: 'octo', name: 'alpha', defaultBranch: 'main' };

  it('adapts a complete tree exactly as the batch model would see it', async () => {
    network();
    const tree = await loadRepositoryTree(TEST_TOKEN, target);
    expect(tree.mode).toBe('complete');
    const store = unwrap(createTreeStore(tree));
    expect(store.snapshot()).toEqual(
      TreeStore.fromRootListing(REPO.recursiveListing('')).snapshot(),
    );
  });

  it('adapts a truncated repository into a lazy store, then a folder listing into it', async () => {
    const net = network({
      [TREE_ROUTE(ROOT)]: (request) =>
        request.url.searchParams.has('recursive')
          ? treeJson(ROOT, [{ path: 'cut-off-listing', type: 'blob', size: 1 }], true)
          : treeJson(ROOT, REPO.listing('').entries),
    });

    const tree = await loadRepositoryTree(TEST_TOKEN, target);
    expect(tree).toMatchObject({ mode: 'lazy', truncated: true, rootTruncated: false });
    const store = unwrap(createTreeStore(tree));
    // Nothing from the truncated recursive response reached the store.
    expect(store.snapshot().nodes.some((n) => n.path === 'cut-off-listing')).toBe(false);
    expect(at(store.snapshot(), 'src')).toMatchObject({ status: 'unloaded', loadable: true });

    const src = at(store.snapshot(), 'src');
    const listing = await loadTreeListing(TEST_TOKEN, target, src.sha ?? '', { recursive: false });
    expect(store.attach(src.id, unwrap(directoryListingOf(listing)))).toEqual({
      applied: true,
      added: 2,
    });
    expect(at(store.snapshot(), 'src')).toMatchObject({ status: 'shallow', bytes: 300 });
    expect(store.snapshot().totals.exact).toBe(false);

    // Adapting made no request of its own: branch, recursive, root, src.
    expect(net.requests).toHaveLength(4);
  });

  it('keeps a folder whose SHA GitHub malformed in the store, without requesting it', async () => {
    const net = network({
      [TREE_ROUTE(ROOT)]: (request) =>
        request.url.searchParams.has('recursive')
          ? treeJson(ROOT, [], true)
          : treeJson(ROOT, [
              { path: 'weird', type: 'tree', mode: '040000', sha: '../../user' },
              { path: 'a.txt', type: 'blob', mode: '100644', size: 3 },
            ]),
    });
    const tree = await loadRepositoryTree(TEST_TOKEN, target);
    const snapshot = unwrap(createTreeStore(tree)).snapshot();
    expect(at(snapshot, 'weird')).toMatchObject({ loadable: false, sha: null, bytes: null });
    expect(net.requests).toHaveLength(3); // branch, recursive, root
  });
});
