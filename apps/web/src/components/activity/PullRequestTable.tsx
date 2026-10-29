import { linkMergeCommit, type CommitIndex } from '../../activity/pullLinks.ts';
import { PULLS_TABLE_CAPTION, ACTIVITY_MESSAGES, notLoadedText } from '../../activity/messages.ts';
import { formatDate } from '../../dashboard/format.ts';
import type { PullItem, PullState } from '../../github/pulls.ts';

interface Props {
  readonly pulls: readonly PullItem[];
  /** The commits already loaded for the history graph: the only thing merge commits are matched to. */
  readonly commits: CommitIndex;
  /** Takes the reader to the row of a loaded commit. Only called with a SHA that is loaded. */
  readonly onShowCommit: (sha: string) => void;
}

const STATE_LABEL: Record<PullState, string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed',
};

function StateCell({ pull }: { readonly pull: PullItem }) {
  return (
    <>
      <span className={`badge badge-pr-${pull.state}`}>{STATE_LABEL[pull.state]}</span>
      {pull.draftUnknown && <span className="note"> (draft status not stated)</span>}
    </>
  );
}

function BranchText({ name }: { readonly name: string | null }) {
  return name === null ? <span className="note">not stated</span> : <code>{name}</code>;
}

/** Base ← head, with words for screen readers: the arrow alone says nothing. */
function BranchesCell({ pull }: { readonly pull: PullItem }) {
  return (
    <>
      <span className="visually-hidden">Base branch </span>
      <BranchText name={pull.baseBranch} />
      <span aria-hidden="true"> ← </span>
      <span className="visually-hidden"> head branch </span>
      <BranchText name={pull.headBranch} />
    </>
  );
}

/** The date that matters for the state, labelled. A missing date is said to be unknown. */
function DateCell({ pull }: { readonly pull: PullItem }) {
  let label: string;
  let iso: string | null;
  if (pull.state === 'merged') {
    label = 'Merged';
    iso = pull.mergedAt;
  } else if (pull.state === 'closed') {
    label = 'Closed';
    iso = pull.closedAt;
  } else {
    label = 'Opened';
    iso = pull.createdAt;
  }
  const text = formatDate(iso, { timeZone: 'UTC' });
  if (iso === null || text === null) return <span className="note">{label}: date unknown</span>;
  return (
    <>
      <span className="note">{label} </span>
      <time dateTime={new Date(iso).toISOString()}>{text}</time>
    </>
  );
}

function MergeCommitCell({
  pull,
  commits,
  onShowCommit,
}: Pick<Props, 'commits' | 'onShowCommit'> & { readonly pull: PullItem }) {
  const link = linkMergeCommit(pull, commits);
  switch (link.kind) {
    case 'none':
      return null;
    case 'not_stated':
      return <span className="note">{ACTIVITY_MESSAGES.mergeNotStated}</span>;
    case 'not_loaded':
      return <span className="note">{notLoadedText(link.reason)}</span>;
    default:
      return (
        <>
          <button
            type="button"
            className="link-button"
            aria-label={`Show commit ${link.sha.slice(0, 7)} in the commit table`}
            onClick={() => {
              onShowCommit(link.sha);
            }}
          >
            <code>{link.sha.slice(0, 7)}</code>
          </button>
          {link.isMergeCommit === true && <span className="note"> (merge commit)</span>}
        </>
      );
  }
}

/**
 * The accessible view of the loaded pull requests. Every cell is plain text from the repository.
 * A merged pull request links to its commit only when that exact commit is among the loaded ones.
 */
export function PullRequestTable({ pulls, commits, onShowCommit }: Props) {
  return (
    <table className="activity-table">
      <caption className="visually-hidden">{PULLS_TABLE_CAPTION}</caption>
      <thead>
        <tr>
          <th scope="col">Pull request</th>
          <th scope="col">State</th>
          <th scope="col">Branches</th>
          <th scope="col">Author</th>
          <th scope="col">Date (UTC)</th>
          <th scope="col">Merge commit</th>
        </tr>
      </thead>
      <tbody>
        {pulls.map((pull, index) => (
          // A pull request pushed while later pages are being read can shift GitHub's paging, so
          // the same number may appear twice; the position keeps the rows apart.
          <tr key={`${String(pull.number)}:${String(index)}`}>
            <th scope="row" className="activity-subject">
              <span className="pr-number">#{pull.number}</span>{' '}
              {pull.title === '' ? <span className="note">(no title)</span> : pull.title}
            </th>
            <td>
              <StateCell pull={pull} />
            </td>
            <td className="pr-branches">
              <BranchesCell pull={pull} />
            </td>
            <td>{pull.authorLogin ?? <span className="note">Unknown</span>}</td>
            <td className="num">
              <DateCell pull={pull} />
            </td>
            <td>
              <MergeCommitCell pull={pull} commits={commits} onShowCommit={onShowCommit} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
