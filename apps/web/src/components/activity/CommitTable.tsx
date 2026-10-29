import { useMemo } from 'react';
import type { HistoryGraph, ParentLinkOutcome } from '../../activity/historyGraph.ts';
import { usableTime } from '../../activity/timeline.ts';
import { formatDate } from '../../dashboard/format.ts';
import type { CommitItem } from '../../github/activity.ts';

interface Props {
  readonly commits: readonly CommitItem[];
  /** The layout of `commits`: it says which parents are listed above their child. */
  readonly graph: HistoryGraph;
  /** The moment the commits were loaded: a date is only believed up to the end of tomorrow. */
  readonly now: number;
}

function authorText(commit: CommitItem): string {
  if (commit.authorName !== null && commit.authorLogin !== null) {
    return `${commit.authorName} (${commit.authorLogin})`;
  }
  return commit.authorName ?? commit.authorLogin ?? 'Unknown';
}

/**
 * The parents of one commit, as text: the accessible equivalent of the history graph. A parent that
 * is not among the loaded commits says so, a parent that is listed above its child says so (the
 * graph draws no line to it), and a parent that could not be read is not confused with a root
 * commit or with parents that GitHub did not state.
 */
function ParentsCell({
  commit,
  loaded,
  links,
}: {
  readonly commit: CommitItem;
  readonly loaded: ReadonlySet<string>;
  /** The graph's outcome for each parent entry; empty when the graph did not examine them. */
  readonly links: readonly ParentLinkOutcome[];
}) {
  const parents = commit.parentShas;
  if (parents === null) return <span className="note">Not stated</span>;
  if (parents.length === 0) return <span className="note">None (root commit)</span>;
  return (
    <>
      {parents.map((parent, index) => (
        // The position is the identity: the same SHA could be listed twice, and one is unreadable.
        <span key={`${parent ?? 'unreadable'}:${String(index)}`} className="parent">
          {index > 0 && ', '}
          {parent === null ? (
            <span className="note">unreadable</span>
          ) : (
            <>
              <code>{parent.slice(0, 7)}</code>
              {links[index] === 'above' ? (
                <span className="note">
                  {parent === commit.sha ? ' (itself)' : ' (listed above)'}
                </span>
              ) : (
                !loaded.has(parent) && <span className="note"> (not loaded)</span>
              )}
            </>
          )}
        </span>
      ))}
    </>
  );
}

/** The accessible view of the loaded commits. Every cell is plain text from the repository. */
export function CommitTable({ commits, graph, now }: Props) {
  const loaded = useMemo(() => new Set(commits.map((commit) => commit.sha)), [commits]);
  return (
    <table className="activity-table">
      <caption className="visually-hidden">Loaded commits, in the order GitHub listed them</caption>
      <thead>
        <tr>
          <th scope="col">Subject</th>
          <th scope="col">Author</th>
          <th scope="col">Date (UTC)</th>
          <th scope="col">Commit</th>
          <th scope="col">Parents</th>
          <th scope="col">Merge</th>
        </tr>
      </thead>
      <tbody>
        {commits.map((commit, index) => {
          const time = usableTime(commit.date, now);
          // A commit pushed while older pages are being read can shift GitHub's paging, so the
          // same SHA may appear twice; the position keeps the rows apart.
          return (
            <tr key={`${commit.sha}:${String(index)}`}>
              <th scope="row" className="activity-subject">
                {commit.subject === '' ? (
                  <span className="note">(no message)</span>
                ) : (
                  commit.subject
                )}
              </th>
              <td>{authorText(commit)}</td>
              <td className="num">
                {time === null ? (
                  <span className="note">Date unknown</span>
                ) : (
                  <time dateTime={new Date(time).toISOString()}>
                    {formatDate(new Date(time).toISOString(), { timeZone: 'UTC' })}
                  </time>
                )}
              </td>
              <td>
                <code>{commit.sha.slice(0, 7)}</code>
              </td>
              <td>
                <ParentsCell
                  commit={commit}
                  loaded={loaded}
                  links={graph.nodes[index]?.links ?? []}
                />
              </td>
              <td>
                {commit.parentCount !== null && commit.parentCount > 1 ? (
                  <span className="badge">Merge</span>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
