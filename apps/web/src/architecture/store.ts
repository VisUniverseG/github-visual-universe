import { gitShaSchema, type GitHubTreeEntry } from '@gvu/shared';
import { collator, displayText, extensionOf, kindOf, type NodeKind } from './names.ts';

/**
 * An incrementally built directory hierarchy.
 *
 * A repository is read one Git tree listing at a time. The store starts from the root's listing
 * and lets further listings be attached to directories that are already known, keeping every
 * aggregate (file counts, bytes, directory counts, extension statistics, completeness) correct
 * after each step, so that all views can be drawn from one consistent {@link TreeSnapshot}.
 *
 * Rules that make the figures honest:
 *
 * - A directory nobody has listed yet is `unloaded`. Its size and counts are `null`, never `0`.
 * - A listed directory's size and counts cover only what has been listed below it. They are
 *   exact only when `exact` is true: this directory and everything below it was listed, with
 *   nothing cut off, unreadable or contradictory. Otherwise they are lower bounds.
 * - Only `tree` entries are directories, and only a directory with a well-formed SHA can be
 *   loaded. Files, symlinks and submodules are leaves and are never followed.
 * - Listings only ever add information. Attaching the same listing again changes nothing, and a
 *   later, more informative listing (a recursive one after a direct one, or one with fewer
 *   unreadable entries) upgrades what was there; a worse one never downgrades it.
 *
 * It never fetches anything. Paths are untrusted: they are only used as map keys and display
 * text, are never resolved, and nothing here recurses over the depth of the tree.
 */

/**
 * What can be shown about a directory.
 *
 * - `unloaded`: never listed.
 * - `loading` / `failed`: not listed yet, and a request is in flight / the last one failed.
 * - `shallow`: listed, but something at or below it is not known: unloaded folders below it,
 *   entries GitHub could not return, or its own listing was cut off.
 * - `complete`: listed, and everything below it is known too.
 *
 * A listed directory that is being refreshed keeps its `shallow`/`complete` status: its data is
 * still valid. See {@link TreeNode.activity}.
 */
export type DirectoryStatus = 'unloaded' | 'loading' | 'failed' | 'shallow' | 'complete';

/** The state of the latest request for a directory. */
export type DirectoryActivity = 'idle' | 'loading' | 'failed';

export interface ExtensionStat {
  /** `null` is "no extension". */
  readonly extension: string | null;
  readonly files: number;
  readonly bytes: number;
}

/** One node of a {@link TreeSnapshot}. Immutable: a change produces new objects. */
export interface TreeNode {
  /** Index into {@link TreeSnapshot.nodes}. The root is `0`; a parent always has a lower id. */
  readonly id: number;
  readonly parent: number | null;
  /** Display-safe name. Empty for the root. */
  readonly name: string;
  /** Display-safe path from the repository root. Empty for the root. */
  readonly path: string;
  readonly kind: NodeKind;
  /** Root is `0`; top-level entries are `1`. */
  readonly depth: number;
  /** Lower-case extension of a file, or `null` (none, dotfile, or implausibly long). */
  readonly extension: string | null;
  /** Directories first, then names in natural order. Empty for anything but a directory. */
  readonly children: readonly TreeNode[];

  /** The Git tree SHA of a directory GitHub gave a well-formed one for; otherwise `null`. */
  readonly sha: string | null;
  /** Directories only (`null` otherwise). */
  readonly status: DirectoryStatus | null;
  /** Directories only (`null` otherwise). */
  readonly activity: DirectoryActivity | null;
  /** A directory that has a usable SHA, so a listing for it can be requested. */
  readonly loadable: boolean;
  /** This directory's own listing was cut off by GitHub (the folder is too large to list). */
  readonly truncated: boolean;
  /** Entries in this directory's own listing that could not be read or contradicted the tree. */
  readonly unreadable: number;

  /**
   * A file's reported size (`null` if GitHub reported none), or a directory's total over what has
   * been listed (`null` if the directory has not been listed). Lower bound unless `bytesExact`.
   */
  readonly bytes: number | null;
  /** Files and symlinks below a directory; `null` if not listed, and for non-directories. */
  readonly fileCount: number | null;
  /** Directories below a directory; `null` if not listed, and for non-directories. */
  readonly directoryCount: number | null;
  /** Files and symlinks with no reported size below this node. They add `0` to `bytes`. */
  readonly filesWithoutSize: number;
  /** Directories at or below this one (itself included) that have not been listed. */
  readonly unloadedDirectories: number;
  /** The counts and the shape below this node are exact, not lower bounds. */
  readonly exact: boolean;
  /** `bytes` is exact: `exact`, and every file below has a reported size. */
  readonly bytesExact: boolean;
}

export interface TreeTotals {
  /** Over what has been listed: lower bounds unless `exact`. */
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly submodules: number;
  readonly bytes: number;
  readonly filesWithoutSize: number;
  /** Depth of the deepest known entry (`1` = everything is at the top level; `0` = empty). */
  readonly maxDepth: number;
  readonly unloadedDirectories: number;
  readonly exact: boolean;
  readonly bytesExact: boolean;
}

export interface TreeSnapshot {
  /** Increases whenever the store changed; equal versions are the very same snapshot object. */
  readonly version: number;
  readonly root: TreeNode;
  /** Every node by `id`. */
  readonly nodes: readonly TreeNode[];
  readonly totals: TreeTotals;
  /** Files by extension, most files first. */
  readonly extensions: readonly ExtensionStat[];
  /** Entries that contradicted the tree (empty path part, duplicate, file used as a directory…). */
  readonly inconsistent: number;
  /** Entries GitHub sent that could not be read, as reported with the attached listings. */
  readonly skipped: number;
}

/** One Git tree listing, as read from GitHub. */
export interface StoreListing {
  /** The tree SHA the listing is for; `null` skips the check against the directory's own SHA. */
  readonly sha: string | null;
  /** `true`: the whole subtree (paths relative to the directory). `false`: direct children only. */
  readonly recursive: boolean;
  readonly entries: readonly GitHubTreeEntry[];
  /** Entries that could not be read and were left out before the listing reached the store. */
  readonly skipped: number;
  /** GitHub cut the listing off. */
  readonly truncated: boolean;
}

export type AttachResult =
  | { readonly applied: true; /** Nodes this listing added. */ readonly added: number }
  | {
      readonly applied: false;
      readonly reason:
        | 'unknown-directory'
        | 'not-a-directory'
        /** The listing is for a different tree than the directory's own SHA. */
        | 'sha-mismatch'
        /** A cut-off recursive listing is not a clean prefix, so none of it is used. */
        | 'truncated-recursive';
    };

interface Delta {
  files: number;
  bytes: number;
  directories: number;
  unlisted: number;
  defective: number;
  unsized: number;
}

type Rank = 0 | 1 | 2;

/** Mutable directory state. `files`…`unsized` aggregate the whole subtree, the directory included. */
interface DirState {
  children: number[];
  /** Child ids by raw (unsanitised) name. */
  byName: Map<string, number>;
  sorted: boolean;
  files: number;
  bytes: number;
  directories: number;
  /** Directories in the subtree (itself included) never listed. */
  unlisted: number;
  /** Directories in the subtree (itself included) that are listed but not known to be whole. */
  defective: number;
  unsized: number;
  /** 0 never listed, 1 listed directly, 2 covered by a recursive listing. */
  rank: Rank;
  /** The listing that produced `rank` had problems, so nothing below can be called complete. */
  defect: boolean;
  truncated: boolean;
  skipped: number;
  inconsistent: number;
  activity: DirectoryActivity;
}

interface MutableNode {
  readonly id: number;
  readonly parent: number | null;
  readonly name: string;
  readonly path: string;
  readonly kind: NodeKind;
  readonly depth: number;
  readonly extension: string | null;
  /** A file's or symlink's size; `null` when not reported (and for the other kinds). */
  size: number | null;
  sha: string | null;
  readonly dir: DirState | null;
}

const NO_CHILDREN: readonly TreeNode[] = Object.freeze([]);
const TRUNCATED_PENALTY = 2_000_000_000;
const DEFECT_PENALTY = 1_000_000_000;

/**
 * A fresh, never-listed directory. Its own "unlisted" mark is not set here: it reaches the
 * directory (and its ancestors) as a delta when the node is created.
 */
function newDirState(): DirState {
  return {
    children: [],
    byName: new Map(),
    sorted: true,
    files: 0,
    bytes: 0,
    directories: 0,
    unlisted: 0,
    defective: 0,
    unsized: 0,
    rank: 0,
    defect: false,
    truncated: false,
    skipped: 0,
    inconsistent: 0,
    activity: 'idle',
  };
}

const zeroDelta = (): Delta => ({
  files: 0,
  bytes: 0,
  directories: 0,
  unlisted: 0,
  defective: 0,
  unsized: 0,
});

/** How bad a listing's problems are; a lower score is a better listing. */
function problemScore(
  truncated: boolean,
  defect: boolean,
  skipped: number,
  inconsistent: number,
): number {
  return (
    (truncated ? TRUNCATED_PENALTY : 0) + (defect ? DEFECT_PENALTY : 0) + skipped + inconsistent
  );
}

function wellFormedSha(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return gitShaSchema.safeParse(value).success ? value : null;
}

function dirOf(node: MutableNode): DirState {
  if (node.dir === null) throw new Error('Expected a directory node.');
  return node.dir;
}

export class TreeStore {
  private readonly nodes: MutableNode[] = [];
  /** The latest immutable form of every node. Always the same length as `nodes` once settled. */
  private frozen: TreeNode[] = [];
  /** Nodes whose immutable form is out of date. Always closed under "has a parent". */
  private readonly dirty = new Set<number>();
  private cached: TreeSnapshot | null = null;
  private version = 0;

  private symlinks = 0;
  private submodules = 0;
  private maxDepth = 0;
  private skippedTotal = 0;
  private inconsistentTotal = 0;
  private readonly extensionStats = new Map<string | null, { files: number; bytes: number }>();
  private extensionList: readonly ExtensionStat[] = [];
  private extensionsStale = false;

  private constructor(rootSha: string | null) {
    const rootDir = newDirState();
    rootDir.unlisted = 1; // the root itself, until its listing is attached
    this.nodes.push({
      id: 0,
      parent: null,
      name: '',
      path: '',
      kind: 'directory',
      depth: 0,
      extension: null,
      size: null,
      sha: rootSha,
      dir: rootDir,
    });
    this.dirty.add(0);
  }

  /**
   * Starts a store from the root's listing: a recursive one (the whole repository) or a direct
   * one (the root's children only, everything below not yet loaded). A cut-off recursive listing
   * cannot start a store: it is discarded by the caller before it gets here.
   */
  static fromRootListing(listing: StoreListing): TreeStore {
    const store = new TreeStore(listing.sha);
    const result = store.attach(0, listing);
    if (!result.applied) {
      throw new Error(`The root listing cannot be used (${result.reason}).`);
    }
    return store;
  }

  /**
   * Attaches a directory's listing to that directory. Returns what happened; it never throws for
   * bad input (a listing that cannot be used changes nothing).
   *
   * Entries already present are merged, not duplicated, so attaching a listing twice is a no-op,
   * and loading directories in any order gives the same result.
   */
  attach(directoryId: number, listing: StoreListing): AttachResult {
    const target = this.nodes[directoryId];
    if (target === undefined) return { applied: false, reason: 'unknown-directory' };
    if (target.dir === null) return { applied: false, reason: 'not-a-directory' };
    if (listing.recursive && listing.truncated) {
      return { applied: false, reason: 'truncated-recursive' };
    }
    if (listing.sha !== null && listing.sha !== target.sha) {
      return { applied: false, reason: 'sha-mismatch' };
    }

    const deltas = new Map<number, Delta>();
    /** The delta of a node, registering it and all its ancestors for the propagation pass. */
    const deltaOf = (id: number): Delta => {
      let current: number | null = id;
      while (current !== null && !deltas.has(current)) {
        deltas.set(current, zeroDelta());
        current = this.nodes[current]?.parent ?? null;
      }
      const delta = deltas.get(id);
      if (delta === undefined) throw new Error('Unreachable.');
      return delta;
    };

    const before = this.nodes.length;
    /** Directories this listing describes completely (recursive listings only). */
    const covered = new Set<number>();
    /** Leaves seen in this listing, to tell a repeated entry from one attached earlier. */
    const seenLeaves = new Set<number>();
    let inconsistent = 0;

    for (const entry of listing.entries) {
      const segments = entry.path.split('/');
      // A direct listing has no nested paths; an empty segment is never a valid path.
      if (segments.includes('') || (!listing.recursive && segments.length > 1)) {
        inconsistent += 1;
        continue;
      }

      // Walk (and create, if the listing did not mention them) the parent directories.
      let parent = target;
      let usable = true;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index] ?? '';
        const existingId = dirOf(parent).byName.get(segment);
        let directory = existingId === undefined ? undefined : this.nodes[existingId];
        if (directory === undefined) {
          directory = this.createNode(parent, segment, 'directory', null, null, deltaOf);
        } else if (directory.kind !== 'directory') {
          usable = false;
          break;
        }
        covered.add(directory.id);
        parent = directory;
      }
      if (!usable) {
        inconsistent += 1;
        continue;
      }

      const leaf = segments[segments.length - 1] ?? '';
      const kind = kindOf(entry);
      const size = entry.size ?? null;
      const existingId = dirOf(parent).byName.get(leaf);
      const existing = existingId === undefined ? undefined : this.nodes[existingId];

      if (existing === undefined) {
        const node = this.createNode(
          parent,
          leaf,
          kind,
          size,
          kind === 'directory' ? wellFormedSha(entry.sha) : null,
          deltaOf,
        );
        if (kind === 'directory') {
          if (listing.recursive) covered.add(node.id);
        } else {
          seenLeaves.add(node.id);
        }
        continue;
      }

      if (existing.kind !== kind) {
        inconsistent += 1;
        continue;
      }
      if (kind === 'directory') {
        // A directory may legitimately exist before its own entry shows up (or be repeated).
        // A SHA that was missing is filled in; one that is already known is kept. (A tree SHA
        // names immutable content, so two listings of one snapshot cannot disagree about it.)
        const sha = wellFormedSha(entry.sha);
        if (sha !== null && existing.sha === null) {
          existing.sha = sha;
          this.markDirty(existing.id);
        }
        if (listing.recursive) covered.add(existing.id);
        continue;
      }
      // A leaf: the first sighting in this listing merges with what is known; a repeat is a
      // contradiction.
      if (seenLeaves.has(existing.id)) {
        inconsistent += 1;
        continue;
      }
      seenLeaves.add(existing.id);
      // A size that was missing is filled in; one that is already known is kept, for the same
      // reason as the SHA above.
      if (size !== null && existing.size === null && (kind === 'file' || kind === 'symlink')) {
        this.fillSize(existing, size, deltaOf);
      }
    }

    // What this listing says about the directory itself, and (if recursive) everything it covers.
    const defect = listing.truncated || listing.skipped > 0 || inconsistent > 0;
    const rank: Rank = listing.recursive ? 2 : 1;
    this.recordListing(
      target,
      rank,
      defect,
      listing.truncated,
      listing.skipped,
      inconsistent,
      deltaOf,
    );
    for (const id of covered) {
      const node = this.nodes[id];
      if (node !== undefined && id !== target.id) {
        this.recordListing(node, 2, defect, false, 0, 0, deltaOf);
      }
    }
    this.setActivity(target, 'idle');

    this.propagate(deltas);
    return { applied: true, added: this.nodes.length - before };
  }

  /** Marks a directory as being requested. `false` if it is not a directory with a usable SHA. */
  markLoading(directoryId: number): boolean {
    const node = this.nodes[directoryId];
    if (node === undefined || node.dir === null || node.sha === null) return false;
    this.setActivity(node, 'loading');
    return true;
  }

  /** Marks a directory's latest request as failed. `false` if it is not a directory. */
  markFailed(directoryId: number): boolean {
    const node = this.nodes[directoryId];
    if (node === undefined || node.dir === null) return false;
    this.setActivity(node, 'failed');
    return true;
  }

  /** Clears a loading or failed marker (for example after a cancelled request). */
  markIdle(directoryId: number): boolean {
    const node = this.nodes[directoryId];
    if (node === undefined || node.dir === null) return false;
    this.setActivity(node, 'idle');
    return true;
  }

  /**
   * The current state as an immutable snapshot. Nodes that did not change keep their identity
   * between snapshots, and calling it again without changes returns the same object.
   */
  snapshot(): TreeSnapshot {
    if (this.cached !== null && this.dirty.size === 0) return this.cached;

    // Ancestors have lower ids than their descendants, so going from the highest id down
    // rebuilds every child before its parent.
    const ids = [...this.dirty].sort((a, b) => b - a);
    const next = this.frozen.slice();
    for (const id of ids) {
      const node = this.nodes[id];
      if (node !== undefined) next[id] = this.freezeNode(node, next);
    }
    this.dirty.clear();
    this.frozen = next;

    const root = next[0];
    const rootDir = this.nodes[0]?.dir;
    if (root === undefined || rootDir === undefined || rootDir === null) {
      throw new Error('The tree has no root.');
    }

    if (this.extensionsStale) {
      this.extensionList = [...this.extensionStats.entries()]
        .map(([extension, stat]) => ({ extension, ...stat }))
        .sort(
          (a, b) =>
            b.files - a.files ||
            b.bytes - a.bytes ||
            collator.compare(a.extension ?? '', b.extension ?? ''),
        );
      this.extensionsStale = false;
    }

    this.version += 1;
    this.cached = {
      version: this.version,
      root,
      nodes: next,
      totals: {
        files: rootDir.files - this.symlinks,
        directories: rootDir.directories,
        symlinks: this.symlinks,
        submodules: this.submodules,
        bytes: rootDir.bytes,
        filesWithoutSize: rootDir.unsized,
        maxDepth: this.maxDepth,
        unloadedDirectories: rootDir.unlisted,
        exact: root.exact,
        bytesExact: root.bytesExact,
      },
      extensions: this.extensionList,
      inconsistent: this.inconsistentTotal,
      skipped: this.skippedTotal,
    };
    return this.cached;
  }

  // ---------------------------------------------------------------------------------------------

  /** Flags a node and all its ancestors for rebuilding (a parent holds its children). */
  private markDirty(id: number): void {
    let current: number | null = id;
    while (current !== null && !this.dirty.has(current)) {
      this.dirty.add(current);
      current = this.nodes[current]?.parent ?? null;
    }
  }

  private createNode(
    parent: MutableNode,
    rawName: string,
    kind: NodeKind,
    size: number | null,
    sha: string | null,
    deltaOf: (id: number) => Delta,
  ): MutableNode {
    const parentDir = dirOf(parent);
    const name = displayText(rawName);
    const node: MutableNode = {
      id: this.nodes.length,
      parent: parent.id,
      name,
      path: parent.path === '' ? name : `${parent.path}/${name}`,
      kind,
      depth: parent.depth + 1,
      extension: kind === 'file' ? extensionOf(rawName) : null,
      size: kind === 'file' || kind === 'symlink' ? size : null,
      sha,
      dir: kind === 'directory' ? newDirState() : null,
    };
    this.nodes.push(node);
    parentDir.children.push(node.id);
    parentDir.byName.set(rawName, node.id);
    parentDir.sorted = false;
    if (node.depth > this.maxDepth) this.maxDepth = node.depth;

    const delta = deltaOf(parent.id);
    if (kind === 'directory') {
      delta.directories += 1;
      // A new directory starts out unlisted; its own state flows up from its own delta.
      deltaOf(node.id).unlisted += 1;
    } else if (kind === 'file' || kind === 'symlink') {
      delta.files += 1;
      delta.bytes += node.size ?? 0;
      if (node.size === null) delta.unsized += 1;
      if (kind === 'symlink') {
        this.symlinks += 1;
      } else {
        const stat = this.extensionStats.get(node.extension) ?? { files: 0, bytes: 0 };
        stat.files += 1;
        stat.bytes += node.size ?? 0;
        this.extensionStats.set(node.extension, stat);
        this.extensionsStale = true;
      }
    } else {
      this.submodules += 1;
    }
    this.markDirty(node.id);
    return node;
  }

  /** A later listing reported the size of a file that was known without one. */
  private fillSize(node: MutableNode, size: number, deltaOf: (id: number) => Delta): void {
    node.size = size;
    if (node.parent !== null) {
      const delta = deltaOf(node.parent);
      delta.bytes += size;
      delta.unsized -= 1;
    }
    if (node.kind === 'file') {
      const stat = this.extensionStats.get(node.extension);
      if (stat !== undefined) stat.bytes += size;
      this.extensionsStale = true;
    }
    this.markDirty(node.id);
  }

  /**
   * Records that a directory was listed, unless it already holds a better listing. A directory
   * is upgraded by a higher rank, or by an equal rank with no more problems; the same listing
   * again changes nothing.
   */
  private recordListing(
    node: MutableNode,
    rank: Rank,
    defect: boolean,
    truncated: boolean,
    skipped: number,
    inconsistent: number,
    deltaOf: (id: number) => Delta,
  ): void {
    const dir = dirOf(node);
    if (rank < dir.rank) return;
    if (
      rank === dir.rank &&
      problemScore(truncated, defect, skipped, inconsistent) >
        problemScore(dir.truncated, dir.defect, dir.skipped, dir.inconsistent)
    ) {
      return;
    }
    if (
      rank === dir.rank &&
      defect === dir.defect &&
      truncated === dir.truncated &&
      skipped === dir.skipped &&
      inconsistent === dir.inconsistent
    ) {
      return;
    }

    const wasUnlisted = dir.rank === 0 ? 1 : 0;
    const wasDefective = dir.rank > 0 && dir.defect ? 1 : 0;
    this.skippedTotal += skipped - dir.skipped;
    this.inconsistentTotal += inconsistent - dir.inconsistent;
    dir.rank = rank;
    dir.defect = defect;
    dir.truncated = truncated;
    dir.skipped = skipped;
    dir.inconsistent = inconsistent;

    const delta = deltaOf(node.id);
    delta.unlisted -= wasUnlisted;
    delta.defective += (defect ? 1 : 0) - wasDefective;
    this.markDirty(node.id);
  }

  private setActivity(node: MutableNode, activity: DirectoryActivity): void {
    const dir = dirOf(node);
    if (dir.activity === activity) return;
    dir.activity = activity;
    this.markDirty(node.id);
  }

  /**
   * Applies the accumulated deltas bottom-up: every node takes its own delta and hands it on to
   * its parent. A node's id is always above its parent's, so one pass in descending id order
   * visits every child before its parent (no recursion, whatever the depth).
   */
  private propagate(deltas: Map<number, Delta>): void {
    const ids = [...deltas.keys()].sort((a, b) => b - a);
    for (const id of ids) {
      const node = this.nodes[id];
      const delta = deltas.get(id);
      if (node === undefined || delta === undefined) continue;
      const dir = dirOf(node);
      dir.files += delta.files;
      dir.bytes += delta.bytes;
      dir.directories += delta.directories;
      dir.unlisted += delta.unlisted;
      dir.defective += delta.defective;
      dir.unsized += delta.unsized;
      this.markDirty(id);

      if (node.parent !== null) {
        const up = deltas.get(node.parent);
        if (up !== undefined) {
          up.files += delta.files;
          up.bytes += delta.bytes;
          up.directories += delta.directories;
          up.unlisted += delta.unlisted;
          up.defective += delta.defective;
          up.unsized += delta.unsized;
        }
      }
    }
  }

  private compare = (aId: number, bId: number): number => {
    const a = this.nodes[aId];
    const b = this.nodes[bId];
    if (a === undefined || b === undefined) return aId - bId;
    const aDirectory = a.kind === 'directory' ? 0 : 1;
    const bDirectory = b.kind === 'directory' ? 0 : 1;
    return aDirectory - bDirectory || collator.compare(a.name, b.name) || a.id - b.id;
  };

  private freezeNode(node: MutableNode, frozen: TreeNode[]): TreeNode {
    const dir = node.dir;
    if (dir === null) {
      const isFile = node.kind === 'file' || node.kind === 'symlink';
      const unsized = isFile && node.size === null ? 1 : 0;
      return {
        id: node.id,
        parent: node.parent,
        name: node.name,
        path: node.path,
        kind: node.kind,
        depth: node.depth,
        extension: node.extension,
        children: NO_CHILDREN,
        sha: null,
        status: null,
        activity: null,
        loadable: false,
        truncated: false,
        unreadable: 0,
        bytes: node.size,
        fileCount: null,
        directoryCount: null,
        filesWithoutSize: unsized,
        unloadedDirectories: 0,
        exact: true,
        bytesExact: unsized === 0,
      };
    }

    if (!dir.sorted) {
      dir.children.sort(this.compare);
      dir.sorted = true;
    }
    const children = dir.children.map((id) => {
      const child = frozen[id];
      if (child === undefined) throw new Error('A child was not rebuilt before its parent.');
      return child;
    });

    const listed = dir.rank > 0;
    const exact = listed && dir.unlisted === 0 && dir.defective === 0;
    const status: DirectoryStatus = listed
      ? exact
        ? 'complete'
        : 'shallow'
      : dir.activity === 'loading'
        ? 'loading'
        : dir.activity === 'failed'
          ? 'failed'
          : 'unloaded';
    return {
      id: node.id,
      parent: node.parent,
      name: node.name,
      path: node.path,
      kind: node.kind,
      depth: node.depth,
      extension: null,
      children,
      sha: node.sha,
      status,
      activity: dir.activity,
      loadable: node.sha !== null,
      truncated: dir.truncated,
      unreadable: dir.skipped + dir.inconsistent,
      bytes: listed ? dir.bytes : null,
      fileCount: listed ? dir.files : null,
      directoryCount: listed ? dir.directories : null,
      filesWithoutSize: dir.unsized,
      unloadedDirectories: dir.unlisted,
      exact,
      bytesExact: exact && dir.unsized === 0,
    };
  }
}
