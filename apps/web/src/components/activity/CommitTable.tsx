import { usableTime } from '../../activity/timeline.ts';
import { formatDate } from '../../dashboard/format.ts';
import type { CommitItem } from '../../github/activity.ts';

interface Props {
  readonly commits: readonly CommitItem[];
  /** The moment the commits were loaded: a date is only believed up to the end of tomorrow. */
  readonly now: number;
}

function authorText(commit: CommitItem): string {
  if (commit.authorName !== null && commit.authorLogin !== null) {
    return `${commit.authorName} (${commit.authorLogin})`;
  }
  return commit.authorName ?? commit.authorLogin ?? 'Unknown';
}

/** The accessible view of the loaded commits. Every cell is plain text from the repository. */
export function CommitTable({ commits, now }: Props) {
  return (
    <table className="activity-table">
      <caption className="visually-hidden">Loaded commits, in the order GitHub listed them</caption>
      <thead>
        <tr>
          <th scope="col">Subject</th>
          <th scope="col">Author</th>
          <th scope="col">Date (UTC)</th>
          <th scope="col">Commit</th>
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
