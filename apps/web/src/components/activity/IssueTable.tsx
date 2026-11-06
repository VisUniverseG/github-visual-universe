import { ISSUES_TABLE_CAPTION } from '../../activity/messages.ts';
import { formatCount, formatDate } from '../../dashboard/format.ts';
import type { IssueItem } from '../../github/issues.ts';

interface Props {
  readonly issues: readonly IssueItem[];
}

/** The words after the state, when GitHub gave a reason that fits it. */
function reasonText(issue: IssueItem): string | null {
  if (issue.state === 'open') return issue.stateReason === 'reopened' ? 'reopened' : null;
  switch (issue.stateReason) {
    case 'completed':
      return 'completed';
    case 'not_planned':
      return 'not planned';
    case 'duplicate':
      return 'duplicate';
    default:
      return null;
  }
}

function StateCell({ issue }: { readonly issue: IssueItem }) {
  const reason = reasonText(issue);
  return (
    <>
      <span className={`badge badge-issue-${issue.state}`}>
        {issue.state === 'open' ? 'Open' : 'Closed'}
      </span>
      {reason !== null && <span className="note"> ({reason})</span>}
    </>
  );
}

/** Label names are plain text from the repository. Their colours are never used. */
function LabelsCell({ issue }: { readonly issue: IssueItem }) {
  const { labels } = issue;
  if (labels === null) return <span className="note">not stated</span>;
  if (labels.length === 0) return <span className="note">None</span>;
  return (
    <ul className="label-list">
      {labels.map((label, index) => (
        // Display-safe names can coincide (they differ only in characters that were replaced).
        <li key={`${label}:${String(index)}`} className="label-chip">
          {label}
        </li>
      ))}
      {issue.labelsNotShown > 0 && (
        <li className="note">{`+${formatCount(issue.labelsNotShown)} more`}</li>
      )}
    </ul>
  );
}

function DateLine({ label, iso }: { readonly label: string; readonly iso: string | null }) {
  const text = formatDate(iso, { timeZone: 'UTC' });
  if (iso === null || text === null) {
    return <div className="note">{label}: date unknown</div>;
  }
  return (
    <div>
      <span className="note">{label} </span>
      <time dateTime={new Date(iso).toISOString()}>{text}</time>
    </div>
  );
}

/**
 * The accessible view of the loaded issues. Every cell is plain text from the repository: titles,
 * label names and logins are never rendered as HTML and never become links.
 */
export function IssueTable({ issues }: Props) {
  return (
    <div
      className="activity-table-scroll"
      role="region"
      aria-label="Scrollable issues table"
      tabIndex={0}
    >
      <table className="activity-table">
        <caption className="visually-hidden">{ISSUES_TABLE_CAPTION}</caption>
        <thead>
          <tr>
            <th scope="col">Issue</th>
            <th scope="col">State</th>
            <th scope="col">Labels</th>
            <th scope="col">Author</th>
            <th scope="col">Dates (UTC)</th>
            <th scope="col">Comments</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            // An issue updated while later pages are being read can shift GitHub's paging, so the
            // same number may appear twice; the position keeps the rows apart.
            <tr key={`${String(issue.number)}:${String(index)}`}>
              <th scope="row" className="activity-subject">
                <span className="issue-number">#{issue.number}</span>{' '}
                {issue.title === '' ? <span className="note">(no title)</span> : issue.title}
              </th>
              <td>
                <StateCell issue={issue} />
              </td>
              <td>
                <LabelsCell issue={issue} />
              </td>
              <td>{issue.authorLogin ?? <span className="note">Unknown</span>}</td>
              <td className="num">
                <DateLine label="Opened" iso={issue.createdAt} />
                <DateLine label="Updated" iso={issue.updatedAt} />
                {issue.state === 'closed' && <DateLine label="Closed" iso={issue.closedAt} />}
              </td>
              <td className="num">
                {issue.comments === null ? (
                  <span className="note">Unknown</span>
                ) : (
                  formatCount(issue.comments)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
