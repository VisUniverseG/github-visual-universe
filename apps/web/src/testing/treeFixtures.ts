import type { GitHubTreeEntry } from '@gvu/shared';
import type { StoreListing } from '../architecture/store.ts';
import type { CompleteRepositoryTree, LazyRepositoryTree } from '../github/tree.ts';

/**
 * Test-only synthetic repositories. A fixture knows the whole tree and can hand out the listing
 * GitHub would return for any directory, either direct (children only) or recursive, so a test can
 * attach them to a store in any order and compare the result with the batch model.
 */

export interface FixtureEntry {
  readonly path: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly size?: number;
  readonly mode?: string;
}

export const blob = (path: string, size?: number): FixtureEntry => ({
  path,
  type: 'blob',
  ...(size === undefined ? {} : { size }),
});
export const dirEntry = (path: string): FixtureEntry => ({ path, type: 'tree' });
export const symlink = (path: string, size = 6): FixtureEntry => ({
  path,
  type: 'blob',
  mode: '120000',
  size,
});
export const submodule = (path: string): FixtureEntry => ({
  path,
  type: 'commit',
  mode: '160000',
});

/** A well-formed, unique 40-character SHA for the n-th object. */
export function fakeSha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

/** A small deterministic random number generator, so a failing seed can be replayed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = copy[index];
    const swap = copy[other];
    if (held !== undefined && swap !== undefined) {
      copy[index] = swap;
      copy[other] = held;
    }
  }
  return copy;
}

const split = (path: string): { parent: string; name: string } => {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? { parent: '', name: path }
    : { parent: path.slice(0, slash), name: path.slice(slash + 1) };
};

export class FixtureTree {
  /** The recursive listing of the whole repository: full paths, tree entries carry their SHA. */
  readonly entries: GitHubTreeEntry[] = [];
  private readonly shas = new Map<string, string>([['', fakeSha(1)]]);
  private readonly direct = new Map<string, GitHubTreeEntry[]>([['', []]]);

  constructor(specs: readonly FixtureEntry[]) {
    // Directories first, so every tree entry has its SHA before any listing is cut.
    let next = 2;
    for (const spec of specs) {
      if (spec.type === 'tree') {
        this.shas.set(spec.path, fakeSha(next));
        next += 1;
        this.direct.set(spec.path, []);
      }
    }
    for (const spec of specs) {
      const entry: GitHubTreeEntry = {
        path: spec.path,
        type: spec.type,
        mode: spec.mode ?? (spec.type === 'tree' ? '040000' : '100644'),
        sha: spec.type === 'tree' ? this.shas.get(spec.path) : fakeSha(next),
        ...(spec.size === undefined ? {} : { size: spec.size }),
      };
      next += 1;
      this.entries.push(entry);
      // A direct listing holds the entry under its parent, named relative to it.
      const { parent: directParent, name } = split(spec.path);
      this.direct.get(directParent)?.push({ ...entry, path: name });
    }
  }

  /** Every directory path, `''` (the root) included. */
  directories(): string[] {
    return [...this.direct.keys()];
  }

  shaOf(path: string): string {
    const sha = this.shas.get(path);
    if (sha === undefined) throw new Error(`No such directory in the fixture: ${path}`);
    return sha;
  }

  /** The non-recursive listing of a directory. */
  listing(path: string, overrides: Partial<StoreListing> = {}): StoreListing {
    return {
      sha: this.shaOf(path),
      recursive: false,
      entries: this.direct.get(path) ?? [],
      skipped: 0,
      truncated: false,
      ...overrides,
    };
  }

  /** The recursive listing of a directory (paths relative to it). */
  recursiveListing(path: string, overrides: Partial<StoreListing> = {}): StoreListing {
    const prefix = path === '' ? '' : `${path}/`;
    const entries =
      path === ''
        ? this.entries
        : this.entries
            .filter((entry) => entry.path.startsWith(prefix))
            .map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
    return {
      sha: this.shaOf(path),
      recursive: true,
      entries,
      skipped: 0,
      truncated: false,
      ...overrides,
    };
  }
}

/** A random but reproducible repository. */
export function randomFixture(
  seed: number,
  size: { directories: number; files: number; maxDepth?: number },
): FixtureTree {
  const random = seeded(seed);
  const maxDepth = size.maxDepth ?? 6;
  const directories: string[] = [''];
  const specs: FixtureEntry[] = [];
  const names = new Set<string>();

  const fresh = (parent: string, prefix: string): string => {
    for (;;) {
      const name = `${prefix}${String(Math.floor(random() * 100_000))}`;
      const path = parent === '' ? name : `${parent}/${name}`;
      if (!names.has(path.toLowerCase())) {
        names.add(path.toLowerCase());
        return path;
      }
    }
  };

  for (let index = 0; index < size.directories; index += 1) {
    const candidates = directories.filter((path) => path.split('/').length <= maxDepth);
    const parent = candidates[Math.floor(random() * candidates.length)] ?? '';
    const path = fresh(parent, 'dir');
    directories.push(path);
    specs.push(dirEntry(path));
  }

  const extensions = ['ts', 'md', 'json', 'css', 'TS', ''];
  for (let index = 0; index < size.files; index += 1) {
    const parent = directories[Math.floor(random() * directories.length)] ?? '';
    const extension = extensions[Math.floor(random() * extensions.length)] ?? '';
    const path = fresh(parent, 'file') + (extension === '' ? '' : `.${extension}`);
    const roll = random();
    if (roll < 0.04) specs.push(symlink(path));
    else if (roll < 0.08) specs.push(submodule(path));
    // About one file in ten has no reported size.
    else if (roll < 0.18) specs.push(blob(path));
    else specs.push(blob(path, Math.floor(random() * 10_000)));
  }
  return new FixtureTree(specs);
}

/** What `loadRepositoryTree` returns for a repository that fit in one recursive listing. */
export function completeTreeOf(fixture: FixtureTree): CompleteRepositoryTree {
  return {
    mode: 'complete',
    branch: 'main',
    commitSha: fakeSha(900),
    treeSha: fixture.shaOf(''),
    entries: fixture.entries,
    skipped: 0,
    truncated: false,
    rateLimit: null,
  };
}

/** What it returns when the recursive listing was cut off: the root's direct children only. */
export function lazyTreeOf(fixture: FixtureTree, rootTruncated = false): LazyRepositoryTree {
  return {
    mode: 'lazy',
    branch: 'main',
    commitSha: fakeSha(900),
    treeSha: fixture.shaOf(''),
    entries: fixture.listing('').entries,
    skipped: 0,
    truncated: true,
    rootTruncated,
    rateLimit: null,
  };
}
