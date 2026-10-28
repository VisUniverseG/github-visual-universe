import type { GitHubTreeEntry } from '@gvu/shared';
import { displayText, extensionOf, type NodeKind } from './names.ts';
import { TreeStore, type ExtensionStat, type TreeSnapshot } from './store.ts';

/**
 * The one-shot view of a whole Git tree: a directory hierarchy with totals, built from a flat
 * list of entries. It is a thin wrapper over {@link TreeStore}: every directory it describes is
 * covered by the listing, so every figure here is exact for the entries it was given. A file whose
 * size GitHub did not report counts as a file but adds nothing to byte totals, and is counted in
 * `filesWithoutSize`.
 *
 * Use the store directly when a tree arrives in pieces; its snapshots say which figures are
 * lower bounds.
 */

export { displayText, extensionOf };
export type { ExtensionStat, NodeKind };

export interface ArchNode {
  /** Index into {@link ArchitectureModel.nodes}. The root is `0`. */
  readonly id: number;
  readonly parent: number | null;
  /** Display-safe name. Empty for the root. */
  readonly name: string;
  /** Display-safe path from the repository root. Empty for the root. */
  readonly path: string;
  readonly kind: NodeKind;
  /** Root is `0`; top-level entries are `1`. */
  readonly depth: number;
  /** A file's size, or a directory's total. `null` only for a file/symlink with no reported size. */
  readonly bytes: number | null;
  /** Files and symlinks at any depth below a directory; `0` for other kinds. */
  readonly fileCount: number;
  /** Directories at any depth below a directory; `0` for other kinds. */
  readonly directoryCount: number;
  /** Directories first, then names in natural order. Empty for anything but a directory. */
  readonly children: readonly ArchNode[];
  /** Lower-case extension of a file, or `null` (none, dotfile, or implausibly long). */
  readonly extension: string | null;
}

export interface ArchitectureTotals {
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly submodules: number;
  readonly bytes: number;
  /** Files and symlinks whose size was not reported; they add `0` bytes. */
  readonly filesWithoutSize: number;
  /** Depth of the deepest entry (`1` = everything is at the top level; `0` = empty). */
  readonly maxDepth: number;
}

export interface ArchitectureModel {
  readonly root: ArchNode;
  /** Every node by `id`. */
  readonly nodes: readonly ArchNode[];
  readonly totals: ArchitectureTotals;
  /** Files by extension, most files first. */
  readonly extensions: readonly ExtensionStat[];
  /** Entries that contradicted the tree (empty path part, duplicate, file used as a directory). */
  readonly inconsistent: number;
}

/** The legacy, all-exact shape of a snapshot whose every directory is listed. */
function toArchitectureModel(snapshot: TreeSnapshot): ArchitectureModel {
  const legacy: ArchNode[] = [];
  // A child's id is above its parent's, so going down from the last id builds children first.
  for (let id = snapshot.nodes.length - 1; id >= 0; id -= 1) {
    const node = snapshot.nodes[id];
    if (node === undefined) throw new Error('The snapshot has a gap.');
    legacy[id] = {
      id: node.id,
      parent: node.parent,
      name: node.name,
      path: node.path,
      kind: node.kind,
      depth: node.depth,
      bytes: node.kind === 'directory' ? (node.bytes ?? 0) : node.bytes,
      fileCount: node.fileCount ?? 0,
      directoryCount: node.directoryCount ?? 0,
      children: node.children.map((child) => {
        const converted = legacy[child.id];
        if (converted === undefined) throw new Error('A child was not converted first.');
        return converted;
      }),
      extension: node.extension,
    };
  }
  const root = legacy[0];
  if (root === undefined) throw new Error('The snapshot has no root.');
  const { totals } = snapshot;
  return {
    root,
    nodes: legacy,
    totals: {
      files: totals.files,
      directories: totals.directories,
      symlinks: totals.symlinks,
      submodules: totals.submodules,
      bytes: totals.bytes,
      filesWithoutSize: totals.filesWithoutSize,
      maxDepth: totals.maxDepth,
    },
    extensions: snapshot.extensions,
    inconsistent: snapshot.inconsistent,
  };
}

export function buildArchitecture(entries: readonly GitHubTreeEntry[]): ArchitectureModel {
  const store = TreeStore.fromRootListing({
    sha: null,
    recursive: true,
    entries,
    skipped: 0,
    truncated: false,
  });
  return toArchitectureModel(store.snapshot());
}

/** The chain from the root down to `id`, inclusive. Works on a model or a store snapshot. */
export function ancestors<N extends { readonly parent: number | null }>(
  model: { readonly nodes: readonly N[] },
  id: number,
): N[] {
  const chain: N[] = [];
  let current: N | undefined = model.nodes[id];
  while (current !== undefined) {
    chain.push(current);
    current = current.parent === null ? undefined : model.nodes[current.parent];
  }
  return chain.reverse();
}
