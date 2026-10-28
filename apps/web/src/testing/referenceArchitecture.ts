import type { GitHubTreeEntry } from '@gvu/shared';
import {
  collator,
  displayText,
  extensionOf,
  kindOf,
  type NodeKind,
} from '../architecture/names.ts';

/**
 * TEST-ONLY. The original one-shot (Phase 5) batch implementation of the architecture model,
 * kept verbatim as an independent oracle: the incremental TreeStore must produce the same
 * hierarchy, totals and extension statistics as this when it is given the same entries.
 * Nothing in the application imports it.
 */

export interface ReferenceNode {
  /** Index into {@link ReferenceModel.nodes}. The root is `0`. */
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
  readonly children: readonly ReferenceNode[];
  /** Lower-case extension of a file, or `null` (none, dotfile, or implausibly long). */
  readonly extension: string | null;
}

export interface ReferenceTotals {
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

export interface ReferenceExtension {
  /** `null` is "no extension". */
  readonly extension: string | null;
  readonly files: number;
  readonly bytes: number;
}

export interface ReferenceModel {
  readonly root: ReferenceNode;
  /** Every node by `id`. */
  readonly nodes: readonly ReferenceNode[];
  readonly totals: ReferenceTotals;
  /** Files by extension, most files first. */
  readonly extensions: readonly ReferenceExtension[];
  /** Entries that contradicted the tree (empty path part, duplicate, file used as a directory). */
  readonly inconsistent: number;
}

interface Draft {
  id: number;
  parent: number | null;
  name: string;
  path: string;
  kind: NodeKind;
  depth: number;
  bytes: number | null;
  fileCount: number;
  directoryCount: number;
  children: Draft[];
  extension: string | null;
}

function compareDrafts(a: Draft, b: Draft): number {
  const aDir = a.kind === 'directory' ? 0 : 1;
  const bDir = b.kind === 'directory' ? 0 : 1;
  return aDir - bDir || collator.compare(a.name, b.name) || a.id - b.id;
}

export function buildReferenceArchitecture(entries: readonly GitHubTreeEntry[]): ReferenceModel {
  const root: Draft = {
    id: 0,
    parent: null,
    name: '',
    path: '',
    kind: 'directory',
    depth: 0,
    bytes: 0,
    fileCount: 0,
    directoryCount: 0,
    children: [],
    extension: null,
  };
  const drafts: Draft[] = [root];
  // Keyed by the raw path so two entries that differ only in unsafe characters stay distinct.
  const byPath = new Map<string, Draft>([['', root]]);
  let inconsistent = 0;
  let maxDepth = 0;
  let symlinks = 0;
  let submodules = 0;
  let filesWithoutSize = 0;
  const extensionStats = new Map<string | null, { files: number; bytes: number }>();

  const create = (parent: Draft, rawName: string, kind: NodeKind, size: number | null): Draft => {
    const name = displayText(rawName);
    const node: Draft = {
      id: drafts.length,
      parent: parent.id,
      name,
      path: parent.path === '' ? name : `${parent.path}/${name}`,
      kind,
      depth: parent.depth + 1,
      bytes: kind === 'directory' ? 0 : size,
      fileCount: 0,
      directoryCount: 0,
      children: [],
      extension: kind === 'file' ? extensionOf(rawName) : null,
    };
    drafts.push(node);
    parent.children.push(node);
    if (node.depth > maxDepth) maxDepth = node.depth;
    return node;
  };

  for (const entry of entries) {
    const segments = entry.path.split('/');
    if (segments.includes('')) {
      inconsistent += 1;
      continue;
    }

    // Walk (and create, if the tree did not list them) the parent directories.
    let parent = root;
    let prefix = '';
    let usable = true;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] ?? '';
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      let directory = byPath.get(prefix);
      if (directory === undefined) {
        directory = create(parent, segment, 'directory', null);
        byPath.set(prefix, directory);
      } else if (directory.kind !== 'directory') {
        usable = false;
        break;
      }
      parent = directory;
    }
    if (!usable) {
      inconsistent += 1;
      continue;
    }

    const leaf = segments[segments.length - 1] ?? '';
    const key = prefix === '' ? leaf : `${prefix}/${leaf}`;
    const kind = kindOf(entry);
    const existing = byPath.get(key);
    if (existing !== undefined) {
      // A directory may legitimately be created implicitly before its own entry shows up.
      if (!(existing.kind === 'directory' && kind === 'directory')) inconsistent += 1;
      continue;
    }

    const node = create(parent, leaf, kind, entry.size ?? null);
    byPath.set(key, node);

    if (kind === 'symlink') symlinks += 1;
    else if (kind === 'submodule') submodules += 1;
    if ((kind === 'file' || kind === 'symlink') && node.bytes === null) filesWithoutSize += 1;
    if (kind === 'file') {
      const stat = extensionStats.get(node.extension) ?? { files: 0, bytes: 0 };
      stat.files += 1;
      stat.bytes += node.bytes ?? 0;
      extensionStats.set(node.extension, stat);
    }
  }

  // Parents are always created before their children, so a reverse pass sees every child before
  // its parent: a bottom-up aggregation with no recursion (deep trees cannot overflow the stack).
  for (let index = drafts.length - 1; index > 0; index -= 1) {
    const node = drafts[index];
    if (node?.parent === null || node?.parent === undefined) continue;
    const parent = drafts[node.parent];
    if (parent === undefined) continue;
    if (node.kind === 'directory') {
      parent.fileCount += node.fileCount;
      parent.directoryCount += node.directoryCount + 1;
      parent.bytes = (parent.bytes ?? 0) + (node.bytes ?? 0);
    } else if (node.kind === 'file' || node.kind === 'symlink') {
      parent.fileCount += 1;
      parent.bytes = (parent.bytes ?? 0) + (node.bytes ?? 0);
    }
  }
  for (const node of drafts) node.children.sort(compareDrafts);

  const extensions: ReferenceExtension[] = [...extensionStats.entries()]
    .map(([extension, stat]) => ({ extension, ...stat }))
    .sort(
      (a, b) =>
        b.files - a.files ||
        b.bytes - a.bytes ||
        collator.compare(a.extension ?? '', b.extension ?? ''),
    );

  return {
    root,
    nodes: drafts,
    totals: {
      files: root.fileCount - symlinks,
      directories: root.directoryCount,
      symlinks,
      submodules,
      bytes: root.bytes ?? 0,
      filesWithoutSize,
      maxDepth,
    },
    extensions,
    inconsistent,
  };
}
