import type { GitHubTreeEntry } from '@gvu/shared';
import { describe, expect, it } from 'vitest';
import {
  FixtureTree,
  blob,
  dirEntry,
  fakeSha,
  randomFixture,
  seeded,
  shuffled,
  submodule,
  symlink,
} from '../testing/treeFixtures.ts';
import { buildReferenceArchitecture } from '../testing/referenceArchitecture.ts';
import { buildArchitecture, type ArchitectureModel } from './model.ts';
import { TreeStore, type StoreListing, type TreeNode, type TreeSnapshot } from './store.ts';

// -----------------------------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------------------------

/**
 *   README.md 100 B
 *   docs/guide.md 1,000 B
 *   src/index.ts 300 B
 *   src/util/math.ts 50 B
 *   src/util/Strings.TS 25 B
 *   empty/                      -> 5 files, 4 folders, 1,475 B, 3 levels deep
 */
const SMALL = new FixtureTree([
  blob('README.md', 100),
  dirEntry('src'),
  blob('src/index.ts', 300),
  dirEntry('src/util'),
  blob('src/util/math.ts', 50),
  blob('src/util/Strings.TS', 25),
  dirEntry('docs'),
  blob('docs/guide.md', 1000),
  dirEntry('empty'),
]);

function at(snapshot: TreeSnapshot, path: string): TreeNode {
  const node = snapshot.nodes.find((candidate) => candidate.path === path);
  if (node === undefined) throw new Error(`No node at "${path}"`);
  return node;
}

const idOf = (store: TreeStore, path: string): number => at(store.snapshot(), path).id;

function attachAt(store: TreeStore, path: string, listing: StoreListing) {
  return store.attach(idOf(store, path), listing);
}

/** Opens a store from the root's direct listing, like a truncated repository would be. */
const lazyStore = (fixture: FixtureTree = SMALL) => TreeStore.fromRootListing(fixture.listing(''));

/**
 * Re-derives every aggregate of every node from its children and checks it against what the
 * snapshot reports, so a test can prove that all views drawn from one snapshot agree.
 */
function expectConsistent(snapshot: TreeSnapshot): void {
  let maxDepth = 0;
  for (const node of snapshot.nodes) {
    expect(snapshot.nodes[node.id]).toBe(node);
    maxDepth = Math.max(maxDepth, node.depth);
    if (node.parent !== null) {
      const parent = snapshot.nodes[node.parent];
      expect(parent?.kind).toBe('directory');
      expect(parent?.children).toContain(node);
      expect(node.depth).toBe((parent?.depth ?? -1) + 1);
      expect(node.id).toBeGreaterThan(node.parent);
    }
    if (node.kind !== 'directory') {
      expect(node.children).toEqual([]);
      expect(node.status).toBeNull();
      expect(node.loadable).toBe(false);
      continue;
    }

    let files = 0;
    let directories = 0;
    let bytes = 0;
    let unsized = 0;
    let unloaded =
      node.status === 'unloaded' || node.status === 'loading' || node.status === 'failed' ? 1 : 0;
    let childrenExact = true;
    for (const child of node.children) {
      if (child.kind === 'directory') {
        directories += 1 + (child.directoryCount ?? 0);
        files += child.fileCount ?? 0;
        bytes += child.bytes ?? 0;
        unsized += child.filesWithoutSize;
        unloaded += child.unloadedDirectories;
        childrenExact &&= child.exact;
      } else if (child.kind === 'file' || child.kind === 'symlink') {
        files += 1;
        bytes += child.bytes ?? 0;
        unsized += child.bytes === null ? 1 : 0;
      }
    }
    const listed = node.status === 'shallow' || node.status === 'complete';
    if (listed) {
      expect(node.fileCount).toBe(files);
      expect(node.directoryCount).toBe(directories);
      expect(node.bytes).toBe(bytes);
    } else {
      // Nothing is known: never zero, and no children.
      expect(node.fileCount).toBeNull();
      expect(node.directoryCount).toBeNull();
      expect(node.bytes).toBeNull();
      expect(node.children).toEqual([]);
      expect(node.exact).toBe(false);
    }
    expect(node.filesWithoutSize).toBe(unsized);
    expect(node.unloadedDirectories).toBe(unloaded);
    expect(node.status === 'complete').toBe(node.exact);
    if (node.exact) {
      expect(childrenExact).toBe(true);
      expect(node.unloadedDirectories).toBe(0);
    }
    expect(node.bytesExact).toBe(node.exact && unsized === 0);
    // Children are directories first, then natural name order.
    const kinds = node.children.map((child) => (child.kind === 'directory' ? 0 : 1));
    expect(kinds).toEqual([...kinds].sort((a, b) => a - b));
  }

  const { totals, root } = snapshot;
  expect(totals.files + totals.symlinks).toBe(root.fileCount);
  expect(totals.directories).toBe(root.directoryCount);
  expect(totals.bytes).toBe(root.bytes);
  expect(totals.filesWithoutSize).toBe(root.filesWithoutSize);
  expect(totals.unloadedDirectories).toBe(root.unloadedDirectories);
  expect(totals.exact).toBe(root.exact);
  expect(totals.bytesExact).toBe(root.bytesExact);
  expect(totals.maxDepth).toBe(maxDepth);
  expect(snapshot.extensions.reduce((sum, stat) => sum + stat.files, 0)).toBe(
    snapshot.nodes.filter((node) => node.kind === 'file').length,
  );
}

/** A cheaper check for very large snapshots: the invariants on the root and every folder row. */
function expectConsistentSample(snapshot: TreeSnapshot): void {
  const { root, totals } = snapshot;
  expect(totals.files + totals.symlinks).toBe(root.fileCount);
  expect(totals.directories).toBe(root.directoryCount);
  expect(totals.bytes).toBe(root.bytes);
  for (const node of snapshot.nodes) {
    if (node.kind !== 'directory' || node.children.length === 0) continue;
    let files = 0;
    let bytes = 0;
    for (const child of node.children) {
      files +=
        child.kind === 'directory' ? (child.fileCount ?? 0) : child.kind === 'submodule' ? 0 : 1;
      bytes += child.bytes ?? 0;
    }
    if (node.fileCount !== files || node.bytes !== bytes) {
      throw new Error(`Inconsistent folder at "${node.path.slice(0, 40)}"`);
    }
  }
}

/** Everything the views draw, keyed by path (ids differ with the order directories were loaded). */
function describeByPath(snapshot: TreeSnapshot) {
  return Object.fromEntries(
    snapshot.nodes.map((node) => [
      node.path,
      {
        kind: node.kind,
        depth: node.depth,
        extension: node.extension,
        bytes: node.bytes,
        fileCount: node.fileCount ?? 0,
        directoryCount: node.directoryCount ?? 0,
        children: node.children.map((child) => child.path),
      },
    ]),
  );
}

/** Asserts a fully loaded store is the same as the batch reference over the same entries. */
function expectMatchesReference(snapshot: TreeSnapshot, entries: readonly GitHubTreeEntry[]) {
  const reference = buildReferenceArchitecture(entries);
  expect(snapshot.totals).toMatchObject(reference.totals);
  expect(snapshot.extensions).toEqual(reference.extensions);
  expect(snapshot.inconsistent).toBe(reference.inconsistent);
  expect(describeByPath(snapshot)).toEqual(
    Object.fromEntries(
      reference.nodes.map((node) => [
        node.path,
        {
          kind: node.kind,
          depth: node.depth,
          extension: node.extension,
          bytes: node.bytes,
          fileCount: node.fileCount,
          directoryCount: node.directoryCount,
          children: node.children.map((child) => child.path),
        },
      ]),
    ),
  );
}

/**
 * Loads every directory with its direct listing, picking the next one at random among those
 * currently loadable. Checks the snapshot is consistent after every step.
 */
function loadEverything(
  store: TreeStore,
  fixture: FixtureTree,
  random: () => number,
  check = true,
): number {
  let loads = 0;
  for (;;) {
    const waiting = store
      .snapshot()
      .nodes.filter(
        (node) => node.kind === 'directory' && node.status === 'unloaded' && node.loadable,
      );
    if (waiting.length === 0) return loads;
    const pick = waiting[Math.floor(random() * waiting.length)];
    if (pick === undefined) return loads;
    const result = store.attach(pick.id, fixture.listing(pick.path));
    expect(result.applied).toBe(true);
    loads += 1;
    if (check) expectConsistent(store.snapshot());
  }
}

// -----------------------------------------------------------------------------------------------
// Initialisation
// -----------------------------------------------------------------------------------------------

describe('TreeStore: initialising from the root listing', () => {
  it('opens from a direct root listing with unloaded folders and lower-bound totals', () => {
    const snapshot = lazyStore().snapshot();

    expect(snapshot.root).toMatchObject({
      status: 'shallow',
      bytes: 100,
      fileCount: 1,
      directoryCount: 3,
      unloadedDirectories: 3,
      exact: false,
      depth: 0,
    });
    expect(snapshot.totals).toMatchObject({
      files: 1,
      directories: 3,
      bytes: 100,
      maxDepth: 1,
      unloadedDirectories: 3,
      exact: false,
    });
    expect(snapshot.root.children.map((child) => child.name)).toEqual([
      'docs',
      'empty',
      'src',
      'README.md',
    ]);
    expect(snapshot.extensions).toEqual([{ extension: 'md', files: 1, bytes: 100 }]);
    expectConsistent(snapshot);
  });

  it('shows folders that have not been listed as unknown, never as empty or zero', () => {
    const snapshot = lazyStore().snapshot();
    for (const name of ['docs', 'empty', 'src']) {
      const folder = at(snapshot, name);
      expect(folder).toMatchObject({
        status: 'unloaded',
        activity: 'idle',
        loadable: true,
        sha: SMALL.shaOf(name),
        bytes: null,
        fileCount: null,
        directoryCount: null,
        exact: false,
        bytesExact: false,
        unloadedDirectories: 1,
        children: [],
      });
    }
  });

  it('opens from a recursive root listing as a complete tree', () => {
    const store = TreeStore.fromRootListing(SMALL.recursiveListing(''));
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({
      files: 5,
      directories: 4,
      bytes: 1475,
      maxDepth: 3,
      unloadedDirectories: 0,
      exact: true,
      bytesExact: true,
    });
    expect(
      snapshot.nodes.filter((n) => n.kind === 'directory').every((n) => n.status === 'complete'),
    ).toBe(true);
    expectConsistent(snapshot);
    expectMatchesReference(snapshot, SMALL.entries);
  });

  it('opens an empty repository as a complete, empty tree', () => {
    const snapshot = TreeStore.fromRootListing(new FixtureTree([]).recursiveListing('')).snapshot();
    expect(snapshot.root).toMatchObject({
      status: 'complete',
      exact: true,
      fileCount: 0,
      bytes: 0,
    });
    expect(snapshot.totals).toMatchObject({ files: 0, directories: 0, bytes: 0, maxDepth: 0 });
  });

  it('refuses to start from a truncated recursive listing', () => {
    expect(() =>
      TreeStore.fromRootListing(SMALL.recursiveListing('', { truncated: true })),
    ).toThrow(/truncated-recursive/);
  });

  it('opens even when the root listing itself was cut off, and never calls it complete', () => {
    const snapshot = TreeStore.fromRootListing(SMALL.listing('', { truncated: true })).snapshot();
    expect(snapshot.root).toMatchObject({ truncated: true, exact: false, status: 'shallow' });
  });
});

// -----------------------------------------------------------------------------------------------
// Attaching listings
// -----------------------------------------------------------------------------------------------

describe('TreeStore: attaching directory listings', () => {
  it('rolls a loaded folder up through every ancestor', () => {
    const store = lazyStore();
    expect(attachAt(store, 'src', SMALL.listing('src'))).toEqual({ applied: true, added: 2 });

    const snapshot = store.snapshot();
    expect(at(snapshot, 'src')).toMatchObject({
      status: 'shallow', // src/util is still unloaded
      bytes: 300,
      fileCount: 1,
      directoryCount: 1,
      unloadedDirectories: 1,
    });
    expect(snapshot.root).toMatchObject({
      bytes: 400,
      fileCount: 2,
      directoryCount: 4,
      unloadedDirectories: 3,
      exact: false,
    });
    expect(snapshot.totals).toMatchObject({ files: 2, directories: 4, bytes: 400, maxDepth: 2 });
    expectConsistent(snapshot);
  });

  it('attaches nested listings and turns folders complete from the bottom up', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    attachAt(store, 'src/util', SMALL.listing('src/util'));

    let snapshot = store.snapshot();
    expect(at(snapshot, 'src/util')).toMatchObject({
      status: 'complete',
      exact: true,
      bytes: 75,
      fileCount: 2,
      directoryCount: 0,
    });
    // src is now whole: everything below it is listed.
    expect(at(snapshot, 'src')).toMatchObject({ status: 'complete', exact: true, bytes: 375 });
    // The root is not: docs and empty are still unloaded.
    expect(snapshot.root).toMatchObject({
      status: 'shallow',
      exact: false,
      unloadedDirectories: 2,
    });

    attachAt(store, 'docs', SMALL.listing('docs'));
    attachAt(store, 'empty', SMALL.listing('empty'));
    snapshot = store.snapshot();
    expect(snapshot.root).toMatchObject({ status: 'complete', exact: true, bytes: 1475 });
    expect(at(snapshot, 'empty')).toMatchObject({ status: 'complete', fileCount: 0, bytes: 0 });
    expectConsistent(snapshot);
    expectMatchesReference(snapshot, SMALL.entries);
  });

  it('keeps extension statistics in step with the files that have been loaded', () => {
    const store = lazyStore();
    expect(store.snapshot().extensions).toEqual([{ extension: 'md', files: 1, bytes: 100 }]);

    attachAt(store, 'src', SMALL.listing('src'));
    attachAt(store, 'src/util', SMALL.listing('src/util'));
    expect(store.snapshot().extensions).toEqual([
      { extension: 'ts', files: 3, bytes: 375 }, // index.ts, math.ts and Strings.TS together
      { extension: 'md', files: 1, bytes: 100 },
    ]);
  });

  it('does not change the extension list when nothing about it changed', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    const before = store.snapshot().extensions;
    attachAt(store, 'empty', SMALL.listing('empty'));
    expect(store.snapshot().extensions).toBe(before);
  });

  it('reports what a listing added', () => {
    const store = lazyStore();
    expect(attachAt(store, 'docs', SMALL.listing('docs'))).toEqual({ applied: true, added: 1 });
    expect(attachAt(store, 'empty', SMALL.listing('empty'))).toEqual({ applied: true, added: 0 });
  });

  it('refuses a listing for an unknown directory', () => {
    const store = lazyStore();
    expect(store.attach(999, SMALL.listing('src'))).toEqual({
      applied: false,
      reason: 'unknown-directory',
    });
    expect(store.attach(-1, SMALL.listing('src'))).toEqual({
      applied: false,
      reason: 'unknown-directory',
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Idempotency
// -----------------------------------------------------------------------------------------------

describe('TreeStore: attaching the same listing again', () => {
  it('changes nothing: same snapshot object, same version, no nodes added', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    const first = store.snapshot();

    expect(attachAt(store, 'src', SMALL.listing('src'))).toEqual({ applied: true, added: 0 });
    expect(attachAt(store, '', SMALL.listing(''))).toEqual({ applied: true, added: 0 });
    const second = store.snapshot();

    expect(second).toBe(first);
    expect(second.version).toBe(first.version);
  });

  it('is idempotent for recursive listings and for a recursive listing over loaded folders', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    attachAt(store, 'src/util', SMALL.listing('src/util'));
    attachAt(store, 'src', SMALL.recursiveListing('src'));
    const once = store.snapshot();
    attachAt(store, 'src', SMALL.recursiveListing('src'));
    attachAt(store, 'src/util', SMALL.listing('src/util'));
    expect(store.snapshot()).toBe(once);
    expectConsistent(once);
  });

  it('is idempotent for a listing with contradictory and unreadable entries', () => {
    const messy: StoreListing = {
      ...SMALL.listing('src'),
      skipped: 2,
      entries: [
        ...SMALL.listing('src').entries,
        blob('nested/deep.txt', 1), // a direct listing cannot contain a path
        blob('index.ts', 5), // a repeat of an entry in the same listing
      ],
    };
    const store = lazyStore();
    attachAt(store, 'src', messy);
    const once = store.snapshot();
    expect(once).toMatchObject({ inconsistent: 2, skipped: 2 });

    attachAt(store, 'src', messy);
    const twice = store.snapshot();
    expect(twice).toBe(once);
    expect(twice).toMatchObject({ inconsistent: 2, skipped: 2 });
  });

  it('does not count a repeated attach of an unchanged folder twice in any total', () => {
    const store = lazyStore();
    for (let round = 0; round < 3; round += 1) {
      for (const path of ['src', 'src/util', 'docs', 'empty']) {
        attachAt(store, path, SMALL.listing(path));
      }
    }
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({ files: 5, directories: 4, bytes: 1475 });
    expectConsistent(snapshot);
    expectMatchesReference(snapshot, SMALL.entries);
  });
});

// -----------------------------------------------------------------------------------------------
// Order independence
// -----------------------------------------------------------------------------------------------

describe('TreeStore: loading folders in different orders', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])(
    'reaches the same complete tree as the batch model (seed %i)',
    (seed) => {
      const fixture = randomFixture(seed, { directories: 25, files: 120 });
      const random = seeded(seed * 7919);
      const store = TreeStore.fromRootListing(fixture.listing(''));

      loadEverything(store, fixture, random);

      const snapshot = store.snapshot();
      expect(snapshot.totals.exact).toBe(true);
      expect(snapshot.totals.unloadedDirectories).toBe(0);
      expectMatchesReference(snapshot, fixture.entries);
    },
  );

  it('gives identical results for any order of the same listings', () => {
    const fixture = randomFixture(99, { directories: 15, files: 60 });
    const results = [1, 2, 3, 4, 5].map((seed) => {
      const store = TreeStore.fromRootListing(fixture.listing(''));
      loadEverything(store, fixture, seeded(seed), false);
      const { totals, extensions } = store.snapshot();
      return { totals, extensions, tree: describeByPath(store.snapshot()) };
    });
    for (const result of results) expect(result).toEqual(results[0]);
  });

  it('shows lower bounds that only grow as more folders load', () => {
    const fixture = randomFixture(5, { directories: 20, files: 100 });
    const store = TreeStore.fromRootListing(fixture.listing(''));
    const random = seeded(5);
    let previous = store.snapshot().totals;

    for (;;) {
      const waiting = store.snapshot().nodes.filter((n) => n.status === 'unloaded' && n.loadable);
      const pick = shuffled(waiting, random)[0];
      if (pick === undefined) break;
      store.attach(pick.id, fixture.listing(pick.path));
      const totals = store.snapshot().totals;
      expect(totals.files).toBeGreaterThanOrEqual(previous.files);
      expect(totals.directories).toBeGreaterThanOrEqual(previous.directories);
      expect(totals.bytes).toBeGreaterThanOrEqual(previous.bytes);
      expect(totals.unloadedDirectories).toBeLessThanOrEqual(
        previous.unloadedDirectories + (totals.directories - previous.directories),
      );
      previous = totals;
    }
    expect(previous.exact).toBe(true);
  });
});

// -----------------------------------------------------------------------------------------------
// Shallow to complete
// -----------------------------------------------------------------------------------------------

describe('TreeStore: a directory becoming more complete', () => {
  it('turns shallow folders complete when a recursive listing covers them', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    expect(at(store.snapshot(), 'src').status).toBe('shallow');

    attachAt(store, 'src', SMALL.recursiveListing('src'));
    const snapshot = store.snapshot();

    expect(at(snapshot, 'src')).toMatchObject({ status: 'complete', exact: true, bytes: 375 });
    // A folder the recursive listing covered is complete without ever being listed on its own.
    expect(at(snapshot, 'src/util')).toMatchObject({
      status: 'complete',
      exact: true,
      bytes: 75,
      loadable: true,
    });
    expect(snapshot.root.status).toBe('shallow'); // docs and empty are still unloaded
    expectConsistent(snapshot);
  });

  it('completes the whole tree with one recursive listing of the root', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    attachAt(store, '', SMALL.recursiveListing(''));
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({ exact: true, unloadedDirectories: 0, bytes: 1475 });
    expectConsistent(snapshot);
    expectMatchesReference(snapshot, SMALL.entries);
  });

  it('does not downgrade a complete folder when a shallower listing arrives later', () => {
    const store = TreeStore.fromRootListing(SMALL.recursiveListing(''));
    const complete = store.snapshot();
    attachAt(store, 'src', SMALL.listing('src'));
    expect(store.snapshot()).toBe(complete);
    expect(at(store.snapshot(), 'src').status).toBe('complete');
  });

  it('upgrades a folder when a later listing carries a size that was missing', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.recursiveListing(''),
      entries: [blob('a.ts'), blob('b.ts', 10)],
    });
    let snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({ bytes: 10, filesWithoutSize: 1, bytesExact: false });
    expect(at(snapshot, 'a.ts').bytes).toBeNull();
    expect(snapshot.extensions).toEqual([{ extension: 'ts', files: 2, bytes: 10 }]);

    store.attach(0, {
      ...SMALL.recursiveListing(''),
      entries: [blob('a.ts', 5), blob('b.ts', 10)],
    });
    snapshot = store.snapshot();
    expect(at(snapshot, 'a.ts').bytes).toBe(5);
    expect(snapshot.totals).toMatchObject({ bytes: 15, filesWithoutSize: 0, bytesExact: true });
    expect(snapshot.extensions).toEqual([{ extension: 'ts', files: 2, bytes: 15 }]);
    expectConsistent(snapshot);
  });

  it('keeps a size that is already known when a later listing says something else', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.recursiveListing(''),
      entries: [blob('a.ts', 10)],
    });
    const before = store.snapshot();
    store.attach(0, { ...SMALL.recursiveListing(''), entries: [blob('a.ts', 99)] });
    // One tree SHA names one content, so this cannot happen for real; the first value stands.
    expect(store.snapshot()).toBe(before);
    expect(at(store.snapshot(), 'a.ts').bytes).toBe(10);
  });

  it('upgrades a listing that had unreadable entries when a clean one arrives, never the reverse', () => {
    const store = lazyStore();
    attachAt(store, 'docs', SMALL.listing('docs', { skipped: 1 }));
    let docs = at(store.snapshot(), 'docs');
    // Listed, no subfolders, but GitHub sent something we could not read: not whole.
    expect(docs).toMatchObject({ status: 'shallow', exact: false, unreadable: 1, bytes: 1000 });
    expect(store.snapshot().skipped).toBe(1);

    attachAt(store, 'docs', SMALL.listing('docs'));
    docs = at(store.snapshot(), 'docs');
    expect(docs).toMatchObject({ status: 'complete', exact: true, unreadable: 0 });
    expect(store.snapshot().skipped).toBe(0);

    // A worse listing for the same directory later does not undo it.
    const settled = store.snapshot();
    attachAt(store, 'docs', SMALL.listing('docs', { skipped: 3 }));
    expect(store.snapshot()).toBe(settled);
    expect(at(store.snapshot(), 'docs').status).toBe('complete');
  });

  it('never calls a folder complete while its own listing was cut off', () => {
    const store = lazyStore();
    attachAt(store, 'docs', SMALL.listing('docs', { truncated: true }));
    let docs = at(store.snapshot(), 'docs');
    expect(docs).toMatchObject({ status: 'shallow', truncated: true, exact: false, bytes: 1000 });
    expect(store.snapshot().root.exact).toBe(false);

    // Only a listing that is not cut off can finish the job.
    attachAt(store, 'docs', SMALL.listing('docs'));
    docs = at(store.snapshot(), 'docs');
    expect(docs).toMatchObject({ status: 'complete', truncated: false, exact: true });
  });

  it('ignores a truncated recursive listing entirely', () => {
    const store = lazyStore();
    const before = store.snapshot();
    expect(attachAt(store, 'src', SMALL.recursiveListing('src', { truncated: true }))).toEqual({
      applied: false,
      reason: 'truncated-recursive',
    });
    expect(store.snapshot()).toBe(before);
    expect(at(store.snapshot(), 'src').status).toBe('unloaded');
  });

  it('keeps a recursive listing with unreadable entries from calling anything below complete', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.recursiveListing('src', { skipped: 1 }));
    const snapshot = store.snapshot();
    expect(at(snapshot, 'src')).toMatchObject({ status: 'shallow', exact: false });
    // The entry GitHub could not give us may have been in src/util.
    expect(at(snapshot, 'src/util')).toMatchObject({ status: 'shallow', exact: false });
    expect(snapshot.skipped).toBe(1);
    expectConsistent(snapshot);
  });
});

// -----------------------------------------------------------------------------------------------
// SHAs
// -----------------------------------------------------------------------------------------------

describe('TreeStore: missing and invalid SHAs', () => {
  const GOOD = fakeSha(7);
  const root: StoreListing = {
    sha: fakeSha(1),
    recursive: false,
    skipped: 0,
    truncated: false,
    entries: [
      { path: 'good', type: 'tree', sha: GOOD },
      { path: 'missing', type: 'tree' },
      { path: 'nulled', type: 'tree', sha: null },
      { path: 'hostile', type: 'tree', sha: '../../user' },
      { path: 'short', type: 'tree', sha: 'abc' },
    ],
  };

  it('keeps a folder without a usable SHA, as visible but not loadable', () => {
    const snapshot = TreeStore.fromRootListing(root).snapshot();
    expect(at(snapshot, 'good')).toMatchObject({ sha: GOOD, loadable: true });
    for (const name of ['missing', 'nulled', 'hostile', 'short']) {
      expect(at(snapshot, name)).toMatchObject({
        kind: 'directory',
        status: 'unloaded',
        sha: null,
        loadable: false,
        bytes: null,
        fileCount: null,
      });
    }
    // Its content can never be known, so the tree is never exact.
    expect(snapshot.totals).toMatchObject({ exact: false, unloadedDirectories: 5 });
  });

  it('never marks a folder without a SHA as loading', () => {
    const store = TreeStore.fromRootListing(root);
    const id = idOf(store, 'hostile');
    const before = store.snapshot();
    expect(store.markLoading(id)).toBe(false);
    expect(store.snapshot()).toBe(before);
  });

  it('refuses a listing that is for a different tree than the folder', () => {
    const store = TreeStore.fromRootListing(root);
    const before = store.snapshot();
    const listing: StoreListing = {
      sha: fakeSha(8),
      recursive: false,
      skipped: 0,
      truncated: false,
      entries: [blob('x.txt', 1)],
    };
    expect(store.attach(idOf(store, 'good'), listing)).toEqual({
      applied: false,
      reason: 'sha-mismatch',
    });
    // It also refuses a SHA for a folder that has none.
    expect(store.attach(idOf(store, 'missing'), { ...listing, sha: GOOD })).toEqual({
      applied: false,
      reason: 'sha-mismatch',
    });
    expect(store.snapshot()).toBe(before);
  });

  it('accepts the listing for the folder it belongs to', () => {
    const store = TreeStore.fromRootListing(root);
    const result = store.attach(idOf(store, 'good'), {
      sha: GOOD,
      recursive: false,
      skipped: 0,
      truncated: false,
      entries: [blob('x.txt', 4)],
    });
    expect(result).toEqual({ applied: true, added: 1 });
    expect(at(store.snapshot(), 'good')).toMatchObject({ status: 'complete', bytes: 4 });
  });

  it('fills in a missing SHA from a later listing and keeps one that is known', () => {
    const store = TreeStore.fromRootListing({
      ...root,
      recursive: true,
      entries: [{ path: 'a/b.txt', type: 'blob', size: 1 }],
    });
    // `a` was created implicitly, so it has no SHA yet.
    expect(at(store.snapshot(), 'a').sha).toBeNull();

    store.attach(0, {
      ...root,
      recursive: true,
      entries: [
        { path: 'a/b.txt', type: 'blob', size: 1 },
        { path: 'a', type: 'tree', sha: GOOD },
      ],
    });
    expect(at(store.snapshot(), 'a')).toMatchObject({ sha: GOOD, loadable: true });
    expect(store.snapshot().inconsistent).toBe(0);

    store.attach(0, {
      ...root,
      recursive: true,
      entries: [{ path: 'a', type: 'tree', sha: fakeSha(9) }],
    });
    expect(at(store.snapshot(), 'a').sha).toBe(GOOD); // the first one stands
  });
});

// -----------------------------------------------------------------------------------------------
// Leaves: files, symlinks, submodules
// -----------------------------------------------------------------------------------------------

describe('TreeStore: files, symlinks and submodules are leaves', () => {
  const fixture = new FixtureTree([
    blob('real.txt', 10),
    symlink('link-to-dir', 8),
    submodule('vendor-lib'),
    dirEntry('src'),
    blob('src/a.ts', 1),
  ]);

  it('keeps them as separate kinds that are never followed or loaded', () => {
    const store = TreeStore.fromRootListing(fixture.listing(''));
    const snapshot = store.snapshot();
    const real = at(snapshot, 'real.txt');
    const link = at(snapshot, 'link-to-dir');
    const vendor = at(snapshot, 'vendor-lib');

    expect([real.kind, link.kind, vendor.kind]).toEqual(['file', 'symlink', 'submodule']);
    for (const leaf of [real, link, vendor]) {
      expect(leaf).toMatchObject({
        status: null,
        activity: null,
        loadable: false,
        sha: null,
        children: [],
        fileCount: null,
        directoryCount: null,
        unloadedDirectories: 0,
        exact: true,
      });
    }
    expect(snapshot.totals).toMatchObject({
      files: 1,
      symlinks: 1,
      submodules: 1,
      directories: 1,
      bytes: 18,
    });
    // The submodule has no size and is not counted as a file without one.
    expect(vendor.bytes).toBeNull();
    expect(snapshot.totals.filesWithoutSize).toBe(0);
    expect(snapshot.extensions).toEqual([{ extension: 'txt', files: 1, bytes: 10 }]);
  });

  it('refuses to attach a listing to a leaf, whatever SHA it carries', () => {
    const store = TreeStore.fromRootListing(fixture.listing(''));
    const before = store.snapshot();
    for (const name of ['real.txt', 'link-to-dir', 'vendor-lib']) {
      expect(store.attach(idOf(store, name), fixture.listing('src'))).toEqual({
        applied: false,
        reason: 'not-a-directory',
      });
      expect(store.markLoading(idOf(store, name))).toBe(false);
      expect(store.markFailed(idOf(store, name))).toBe(false);
      expect(store.markIdle(idOf(store, name))).toBe(false);
    }
    expect(store.snapshot()).toBe(before);
  });

  it('does not treat a submodule or symlink as a directory when paths run through it', () => {
    const store = TreeStore.fromRootListing({
      ...fixture.recursiveListing(''),
      entries: [
        submodule('sub'),
        symlink('link'),
        blob('sub/inner.txt', 1),
        blob('link/inner.txt', 1),
        blob('ok.txt', 2),
      ],
    });
    const snapshot = store.snapshot();
    expect(snapshot.inconsistent).toBe(2);
    expect(snapshot.totals).toMatchObject({ files: 1, symlinks: 1, submodules: 1, directories: 0 });
    expect(at(snapshot, 'sub').children).toEqual([]);
    expect(snapshot.nodes.some((node) => node.path === 'sub/inner.txt')).toBe(false);
  });

  it('does not let an entry of another kind replace a directory, a file or a symlink', () => {
    const store = TreeStore.fromRootListing({
      sha: fakeSha(1),
      recursive: false,
      skipped: 0,
      truncated: false,
      entries: [
        { path: 'src', type: 'tree', sha: fakeSha(2) },
        symlinkEntry('src'), // a symlink where a directory already is
        blob('real.txt', 1),
        { path: 'real.txt', type: 'tree', sha: fakeSha(3) }, // a directory where a file already is
        symlinkEntry('link'),
        blob('link', 1), // a file where a symlink already is
      ],
    });
    const snapshot = store.snapshot();
    expect(snapshot.nodes.map((node) => [node.path, node.kind])).toEqual([
      ['', 'directory'],
      ['src', 'directory'],
      ['real.txt', 'file'],
      ['link', 'symlink'],
    ]);
    expect(snapshot.inconsistent).toBe(3);
    expect(snapshot.totals.exact).toBe(false);
  });

  it('treats a repository made only of leaves as complete', () => {
    const store = TreeStore.fromRootListing({
      sha: fakeSha(1),
      recursive: false,
      skipped: 0,
      truncated: false,
      entries: [blob('a.txt', 1), symlink('b'), submodule('c')],
    });
    expect(store.snapshot().totals).toMatchObject({ exact: true, unloadedDirectories: 0 });
  });
});

function symlinkEntry(path: string): GitHubTreeEntry {
  return { path, type: 'blob', mode: '120000', sha: fakeSha(41), size: 3 };
}

// -----------------------------------------------------------------------------------------------
// Unknown values, activity
// -----------------------------------------------------------------------------------------------

describe('TreeStore: unknown values and request state', () => {
  it('reports loading and failed folders as still unknown', () => {
    const store = lazyStore();
    const src = idOf(store, 'src');

    expect(store.markLoading(src)).toBe(true);
    expect(at(store.snapshot(), 'src')).toMatchObject({
      status: 'loading',
      activity: 'loading',
      bytes: null,
      fileCount: null,
    });

    expect(store.markFailed(src)).toBe(true);
    expect(at(store.snapshot(), 'src')).toMatchObject({
      status: 'failed',
      activity: 'failed',
      bytes: null,
    });

    expect(store.markIdle(src)).toBe(true);
    expect(at(store.snapshot(), 'src')).toMatchObject({ status: 'unloaded', activity: 'idle' });
  });

  it('does not change any totals when a request starts or fails', () => {
    const store = lazyStore();
    const { totals } = store.snapshot();
    store.markLoading(idOf(store, 'src'));
    store.markFailed(idOf(store, 'docs'));
    expect(store.snapshot().totals).toEqual(totals);
    expectConsistent(store.snapshot());
  });

  it('clears the marker when the listing arrives', () => {
    const store = lazyStore();
    const src = idOf(store, 'src');
    store.markLoading(src);
    store.attach(src, SMALL.listing('src'));
    expect(at(store.snapshot(), 'src')).toMatchObject({ status: 'shallow', activity: 'idle' });
  });

  it('keeps a loaded folder shown as loaded while it is refreshed or a refresh fails', () => {
    const store = lazyStore();
    attachAt(store, 'docs', SMALL.listing('docs'));
    const docs = idOf(store, 'docs');

    store.markLoading(docs);
    expect(at(store.snapshot(), 'docs')).toMatchObject({
      status: 'complete',
      activity: 'loading',
      bytes: 1000,
    });
    store.markFailed(docs);
    expect(at(store.snapshot(), 'docs')).toMatchObject({
      status: 'complete',
      activity: 'failed',
      bytes: 1000,
    });
  });

  it('is a no-op to repeat a marker', () => {
    const store = lazyStore();
    const src = idOf(store, 'src');
    store.markLoading(src);
    const marked = store.snapshot();
    expect(store.markLoading(src)).toBe(true);
    expect(store.snapshot()).toBe(marked);
  });

  it('does not accept markers for folders that do not exist', () => {
    const store = lazyStore();
    expect(store.markLoading(500)).toBe(false);
    expect(store.markFailed(-3)).toBe(false);
    expect(store.markIdle(500)).toBe(false);
  });

  it('counts files without a reported size without adding bytes for them', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.listing(''),
      entries: [blob('a.txt'), blob('b.txt', 7), symlink('c')],
    });
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({
      files: 2,
      symlinks: 1,
      bytes: 13,
      filesWithoutSize: 1,
      exact: true,
      bytesExact: false,
    });
    expect(at(snapshot, 'a.txt')).toMatchObject({
      bytes: null,
      bytesExact: false,
      filesWithoutSize: 1,
    });
  });
});

// -----------------------------------------------------------------------------------------------
// Snapshots
// -----------------------------------------------------------------------------------------------

describe('TreeStore: snapshots', () => {
  it('returns the very same snapshot until something changes', () => {
    const store = lazyStore();
    const a = store.snapshot();
    expect(store.snapshot()).toBe(a);
    attachAt(store, 'src', SMALL.listing('src'));
    const b = store.snapshot();
    expect(b).not.toBe(a);
    expect(b.version).toBeGreaterThan(a.version);
  });

  it('never changes a snapshot that was already handed out', () => {
    const store = lazyStore();
    const before = store.snapshot();
    const frozenCopy = JSON.stringify(before);

    attachAt(store, 'src', SMALL.listing('src'));
    attachAt(store, 'src/util', SMALL.listing('src/util'));
    store.markFailed(idOf(store, 'docs'));

    expect(JSON.stringify(before)).toBe(frozenCopy);
    expect(before.root.fileCount).toBe(1);
    expect(before.nodes).toHaveLength(5);
  });

  it('shares every node a change did not touch', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    attachAt(store, 'docs', SMALL.listing('docs'));
    const before = store.snapshot();

    attachAt(store, 'src/util', SMALL.listing('src/util'));
    const after = store.snapshot();

    // Untouched branches are the same objects…
    expect(at(after, 'docs')).toBe(at(before, 'docs'));
    expect(at(after, 'docs/guide.md')).toBe(at(before, 'docs/guide.md'));
    expect(at(after, 'empty')).toBe(at(before, 'empty'));
    expect(at(after, 'README.md')).toBe(at(before, 'README.md'));
    expect(at(after, 'src/index.ts')).toBe(at(before, 'src/index.ts'));
    // …and the changed path (the folder and each ancestor) was rebuilt.
    expect(at(after, 'src/util')).not.toBe(at(before, 'src/util'));
    expect(at(after, 'src')).not.toBe(at(before, 'src'));
    expect(after.root).not.toBe(before.root);
  });

  it('makes every view agree: children, parents, totals and statistics come from one snapshot', () => {
    const store = lazyStore();
    attachAt(store, 'src', SMALL.listing('src'));
    const snapshot = store.snapshot();
    expectConsistent(snapshot);
    // Walking down from the root reaches exactly the nodes in the id table.
    const reached: number[] = [];
    const queue: TreeNode[] = [snapshot.root];
    for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
      reached.push(node.id);
      queue.push(...node.children);
    }
    expect(reached.sort((a, b) => a - b)).toEqual(snapshot.nodes.map((node) => node.id));
  });
});

// -----------------------------------------------------------------------------------------------
// Paths
// -----------------------------------------------------------------------------------------------

describe('TreeStore: path safety', () => {
  it('treats "." and ".." as plain names and never resolves a path', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.recursiveListing(''),
      entries: [blob('../../etc/passwd', 5), blob('./x', 1)],
    });
    expect(store.snapshot().nodes.map((node) => node.path)).toEqual([
      '',
      '..',
      '../..',
      '../../etc',
      '../../etc/passwd',
      '.',
      './x',
    ]);
  });

  it('makes control and bidirectional characters visible and harmless, in names and paths', () => {
    const store = TreeStore.fromRootListing({
      sha: fakeSha(1),
      recursive: false,
      skipped: 0,
      truncated: false,
      entries: [{ path: 'evil\u202Edir', type: 'tree', sha: fakeSha(2) }, blob('nul\u0000byte', 1)],
    });
    const dir = store.snapshot().root.children.find((child) => child.kind === 'directory');
    expect(dir?.name).toBe('evil\uFFFDdir');

    store.attach(dir?.id ?? -1, {
      sha: fakeSha(2),
      recursive: false,
      skipped: 0,
      truncated: false,
      entries: [blob('in\u2066side\u0007.txt', 1)],
    });
    const paths = store.snapshot().nodes.map((node) => node.path);
    expect(paths).toContain('evil\uFFFDdir/in\uFFFDside\uFFFD.txt');
    expect(paths).toContain('nul\uFFFDbyte');
    for (const path of paths) {
      for (const char of path) {
        const code = char.codePointAt(0) ?? 0;
        const unsafe =
          code <= 0x1f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
        expect(unsafe).toBe(false);
      }
    }
  });

  it('keeps two raw names that sanitize to the same text as two separate entries', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.listing(''),
      entries: [blob('a\u0001b', 1), blob('a\u0002b', 2)],
    });
    expect(store.snapshot().root.children).toHaveLength(2);
    expect(store.snapshot().totals.files).toBe(2);
  });

  it('caps very long names', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.listing(''),
      entries: [blob(`${'x'.repeat(3000)}.txt`, 1)],
    });
    expect(store.snapshot().root.children[0]?.name.length).toBeLessThanOrEqual(200);
  });

  it.each([
    ['an empty segment', 'a//b.txt'],
    ['a leading slash', '/abs.txt'],
    ['a trailing slash', 'trailing/'],
  ])('skips and counts a recursive entry with %s', (_name, path) => {
    const store = TreeStore.fromRootListing({
      ...SMALL.recursiveListing(''),
      entries: [blob(path, 1), blob('ok.txt', 1)],
    });
    const snapshot = store.snapshot();
    expect(snapshot.inconsistent).toBe(1);
    expect(snapshot.totals.files).toBe(1);
    expect(snapshot.totals.exact).toBe(false);
  });

  it('skips and counts a nested path in a direct listing', () => {
    const store = TreeStore.fromRootListing({
      ...SMALL.listing(''),
      entries: [blob('a/b.txt', 1), blob('ok.txt', 1)],
    });
    const snapshot = store.snapshot();
    expect(snapshot.inconsistent).toBe(1);
    expect(snapshot.nodes.map((node) => node.path)).toEqual(['', 'ok.txt']);
    expect(snapshot.totals.exact).toBe(false);
  });
});

// -----------------------------------------------------------------------------------------------
// Depth and size
// -----------------------------------------------------------------------------------------------

describe('TreeStore: deep and large trees', () => {
  const chain = (length: number) => Array.from({ length }, (_unused, index) => `d${String(index)}`);

  it('does not overflow the stack on one extremely deep recursive listing', () => {
    const deep = chain(5000).join('/');
    const store = TreeStore.fromRootListing({
      ...SMALL.recursiveListing(''),
      entries: [blob(`${deep}/leaf.txt`, 9)],
    });
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({
      files: 1,
      directories: 5000,
      bytes: 9,
      maxDepth: 5001,
      exact: true,
    });
    expect(snapshot.root.bytes).toBe(9);
    expect(snapshot.nodes).toHaveLength(5002);
  });

  it('loads a deep tree one folder at a time without recursion, keeping every total exact', () => {
    const depth = 1500;
    const specs = [];
    let path = '';
    for (const name of chain(depth)) {
      path = path === '' ? name : `${path}/${name}`;
      specs.push(dirEntry(path), blob(`${path}/f.txt`, 2));
    }
    const fixture = new FixtureTree(specs);
    const store = TreeStore.fromRootListing(fixture.listing(''));

    path = '';
    for (const name of chain(depth)) {
      path = path === '' ? name : `${path}/${name}`;
      expect(store.attach(idOf(store, path), fixture.listing(path)).applied).toBe(true);
    }
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({
      files: depth,
      directories: depth,
      bytes: depth * 2,
      maxDepth: depth + 1,
      exact: true,
      unloadedDirectories: 0,
    });
    expect(at(snapshot, chain(depth).join('/'))).toMatchObject({ status: 'complete', depth });
    expectConsistentSample(snapshot);
  });

  it('keeps ancestors exact when a deep folder is loaded first from the bottom of a recursive listing', () => {
    const deep = chain(300).join('/');
    const fixture = new FixtureTree([
      ...chain(300).map((_name, index) => dirEntry(chain(index + 1).join('/'))),
      blob(`${deep}/x.ts`, 3),
    ]);
    const store = TreeStore.fromRootListing(fixture.listing(''));
    attachAt(store, 'd0', fixture.recursiveListing('d0'));
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({ exact: true, files: 1, bytes: 3, directories: 300 });
  });

  it('builds a 100,000-entry tree folder by folder with exact totals and shared structure', () => {
    const specs = [];
    for (let dir = 0; dir < 1000; dir += 1) {
      specs.push(dirEntry(`pkg${String(dir)}`));
      for (let index = 0; index < 99; index += 1) {
        specs.push(blob(`pkg${String(dir)}/f${String(index)}.ts`, 10));
      }
    }
    const fixture = new FixtureTree(specs);
    const store = TreeStore.fromRootListing(fixture.listing(''));
    expect(store.snapshot().totals).toMatchObject({ directories: 1000, files: 0, exact: false });

    const ids = new Map(store.snapshot().root.children.map((child) => [child.path, child.id]));
    const random = seeded(2024);
    const order = shuffled(
      fixture.directories().filter((path) => path !== ''),
      random,
    );
    let loaded = 0;
    let previous: TreeSnapshot | null = null;
    for (const path of order) {
      expect(store.attach(ids.get(path) ?? -1, fixture.listing(path))).toEqual({
        applied: true,
        added: 99,
      });
      loaded += 1;
      if (loaded % 100 === 0) {
        const snapshot = store.snapshot();
        expect(snapshot.totals.files).toBe(loaded * 99);
        expect(snapshot.totals.bytes).toBe(loaded * 990);
        expect(snapshot.totals.exact).toBe(loaded === 1000);
        if (previous !== null) {
          // Every folder that was complete in the previous snapshot is carried over untouched.
          const settled = previous.root.children.filter((child) => child.status === 'complete');
          expect(settled).toHaveLength(loaded - 100);
          for (const child of settled) expect(snapshot.nodes[child.id]).toBe(child);
        }
        previous = snapshot;
      }
    }

    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({
      files: 99_000,
      directories: 1000,
      bytes: 990_000,
      maxDepth: 2,
      exact: true,
      unloadedDirectories: 0,
    });
    expect(snapshot.nodes).toHaveLength(100_001);
    expect(snapshot.extensions).toEqual([{ extension: 'ts', files: 99_000, bytes: 990_000 }]);
    expectMatchesReference(snapshot, fixture.entries);
  }, 30_000);

  it('applies a 100,000-entry recursive listing in one go', () => {
    const specs = [];
    for (let dir = 0; dir < 1000; dir += 1) {
      specs.push(dirEntry(`pkg${String(dir)}`));
      for (let index = 0; index < 99; index += 1) {
        specs.push(blob(`pkg${String(dir)}/f${String(index)}.ts`, 10));
      }
    }
    const fixture = new FixtureTree(specs);
    const store = TreeStore.fromRootListing(fixture.listing(''));
    store.attach(0, fixture.recursiveListing(''));
    const snapshot = store.snapshot();
    expect(snapshot.totals).toMatchObject({ files: 99_000, directories: 1000, exact: true });
    expectConsistentSample(snapshot);
  }, 30_000);
});

// -----------------------------------------------------------------------------------------------
// Regression against the batch model
// -----------------------------------------------------------------------------------------------

describe('buildArchitecture (the store-backed wrapper) matches the original batch model', () => {
  const plain = (model: ArchitectureModel) => ({
    totals: model.totals,
    extensions: model.extensions,
    inconsistent: model.inconsistent,
    nodes: model.nodes.map((node) => ({
      id: node.id,
      parent: node.parent,
      name: node.name,
      path: node.path,
      kind: node.kind,
      depth: node.depth,
      bytes: node.bytes,
      fileCount: node.fileCount,
      directoryCount: node.directoryCount,
      extension: node.extension,
      children: node.children.map((child) => child.id),
    })),
  });

  const file = (path: string, size?: number): GitHubTreeEntry => ({
    path,
    type: 'blob',
    mode: '100644',
    ...(size === undefined ? {} : { size }),
  });
  const tree = (path: string): GitHubTreeEntry => ({ path, type: 'tree', mode: '040000' });

  const cases: Array<[string, GitHubTreeEntry[]]> = [
    ['an empty tree', []],
    ['implicit parents', [file('a/b/c.txt', 5)]],
    ['a directory entry after its children', [file('a/x.txt', 1), tree('a')]],
    ['a repeated directory entry', [tree('a'), tree('a'), file('a/x', 1)]],
    ['files with no size', [file('a.txt'), file('b.txt', 7)]],
    ['no-extension names', [file('Makefile', 1), file('.gitignore', 1), file('x.', 1)]],
    [
      'empty path parts',
      [file('/abs.txt', 1), file('a//b.txt', 1), file('trailing/', 1), file('ok', 1)],
    ],
    [
      'a file used as a directory, and duplicates',
      [file('a', 1), file('a/b.txt', 1), file('dup.txt', 1), file('dup.txt', 1), tree('a')],
    ],
    ['dot names', [file('../../etc/passwd', 5), file('./x', 1)]],
    ['unsafe characters', [file('evil\u202Etxt.exe', 1), file('nul\u0000byte', 1)]],
    ['colliding sanitized names', [file('a\u0001b', 1), file('a\u0002b', 2)]],
    [
      'symlinks and submodules',
      [
        file('real.txt', 10),
        { path: 'link', type: 'blob', mode: '120000', size: 8 },
        { path: 'vendor/lib', type: 'commit', mode: '160000' },
        { path: 'sub', type: 'commit', mode: '160000' },
        file('sub/inner.txt', 1),
      ],
    ],
    [
      'natural ordering',
      [file('b10.txt', 1), file('b2.txt', 1), file('a.txt', 1), tree('zdir'), tree('adir')],
    ],
  ];

  it.each(cases)('is identical for %s', (_name, entries) => {
    expect(plain(buildArchitecture(entries))).toEqual(plain(buildReferenceArchitecture(entries)));
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'is identical for random trees, whatever order GitHub listed them in (seed %i)',
    (seed) => {
      const fixture = randomFixture(seed, { directories: 30, files: 150 });
      const entries = shuffled(fixture.entries, seeded(seed));
      expect(plain(buildArchitecture(entries))).toEqual(plain(buildReferenceArchitecture(entries)));
    },
  );

  it('reports every directory of a batch tree as exact and complete', () => {
    const snapshot = TreeStore.fromRootListing({
      sha: null,
      recursive: true,
      entries: SMALL.entries,
      skipped: 0,
      truncated: false,
    }).snapshot();
    expectConsistent(snapshot);
    expect(snapshot.totals.exact).toBe(true);
  });
});
