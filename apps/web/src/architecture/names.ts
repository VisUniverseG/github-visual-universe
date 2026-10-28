import type { GitHubTreeEntry } from '@gvu/shared';

/**
 * Display-safe names and entry classification, shared by the tree store and the batch model.
 *
 * Paths come from the repository and are untrusted. Every name is turned into display-safe text
 * (control and bidirectional-override characters replaced, length capped), and paths are only ever
 * used as map keys and text: never resolved, never put in a URL.
 */

export type NodeKind = 'directory' | 'file' | 'symlink' | 'submodule';

const MAX_NAME_LENGTH = 200;
const MAX_EXTENSION_LENGTH = 16;
const SYMLINK_MODE = '120000';

function isUnsafeCode(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) || // zero-width and directional marks
    (code >= 0x202a && code <= 0x202e) || // bidirectional embeddings and overrides
    (code >= 0x2066 && code <= 0x2069) || // bidirectional isolates
    code === 0xfeff
  );
}

/** Text that is safe to show: unsafe characters become U+FFFD and very long names are cut. */
export function displayText(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    out += isUnsafeCode(value.charCodeAt(index)) ? '\uFFFD' : (value[index] ?? '');
  }
  return out.length > MAX_NAME_LENGTH ? `${out.slice(0, MAX_NAME_LENGTH - 1)}…` : out;
}

export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const extension = name.slice(dot + 1);
  return extension.length > MAX_EXTENSION_LENGTH ? null : displayText(extension).toLowerCase();
}

/**
 * What a tree entry is. Only `tree` entries are directories: a `commit` (submodule) and a symlink
 * (a blob with mode `120000`) are leaves and are never followed.
 */
export function kindOf(entry: GitHubTreeEntry): NodeKind {
  if (entry.type === 'tree') return 'directory';
  if (entry.type === 'commit') return 'submodule';
  return entry.mode === SYMLINK_MODE ? 'symlink' : 'file';
}

export const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
