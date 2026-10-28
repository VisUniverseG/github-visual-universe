import { boundedFigure, formatBytes, formatCount } from '../../dashboard/format.ts';
import type { NodeKind } from '../../architecture/names.ts';
import type { TreeNode } from '../../architecture/store.ts';

/** Rows drawn before the rest are folded behind "Show all". */
export const MAX_ROWS = 300;

const KIND_LABELS: Record<NodeKind, string> = {
  directory: 'Folder',
  file: 'File',
  symlink: 'Symlink',
  submodule: 'Submodule',
};

/** What to add to "Folder" for a folder whose contents are not (all) known. */
function folderState(node: TreeNode): string {
  if (node.status === 'unloaded') return node.loadable ? ' · not loaded' : ' · cannot be loaded';
  if (node.status === 'loading') return ' · loading…';
  if (node.status === 'failed') return ' · failed to load';
  return '';
}

interface Props {
  readonly directory: TreeNode;
  readonly showAll: boolean;
  readonly onShowAll: () => void;
  readonly onOpen: (id: number) => void;
}

/** The accessible view of a directory: every entry, with folders that can be opened. */
export function DirectoryTable({ directory, showAll, onShowAll, onOpen }: Props) {
  const total = directory.children.length;
  const rows = showAll ? directory.children : directory.children.slice(0, MAX_ROWS);

  if (total === 0) return <p className="note">This folder is empty.</p>;

  return (
    <>
      <table className="entries">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Type</th>
            <th scope="col" className="num">
              Size
            </th>
            <th scope="col" className="num">
              Files
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((node) => (
            <tr key={node.id}>
              <th scope="row" className="entry-name">
                {node.kind === 'directory' ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      onOpen(node.id);
                    }}
                    aria-label={`Open folder ${node.name}`}
                  >
                    {node.name}/
                  </button>
                ) : (
                  node.name
                )}
              </th>
              <td>
                {KIND_LABELS[node.kind]}
                {node.kind === 'directory' ? folderState(node) : ''}
              </td>
              <td className="num">
                {node.bytes === null
                  ? '—'
                  : boundedFigure(node.bytes, formatBytes, node.bytesExact)}
              </td>
              <td className="num">
                {node.kind === 'directory' && node.fileCount !== null
                  ? boundedFigure(node.fileCount, formatCount, node.exact)
                  : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!showAll && total > MAX_ROWS && (
        <p className="note">
          Showing {formatCount(MAX_ROWS)} of {formatCount(total)} entries.{' '}
          <button type="button" onClick={onShowAll}>
            Show all {formatCount(total)}
          </button>
        </p>
      )}
    </>
  );
}
