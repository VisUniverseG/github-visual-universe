import { useEffect, useRef, type ReactNode } from 'react';
import { formatCount, formatDate } from '../../dashboard/format.ts';
import type { RepositoryItem } from '../../github/repositories.ts';
import { VISIBILITY_LABELS } from './RepositoryCard.tsx';

interface Props {
  readonly repo: RepositoryItem;
  readonly onClose: () => void;
  readonly onOpenArchitecture: () => void;
  readonly onOpenActivity: () => void;
}

interface Row {
  readonly label: string;
  readonly value: ReactNode;
}

/**
 * Details for one repository, limited to what the repository list already returned. Rows for
 * missing values are omitted rather than shown as zero or "unknown".
 */
export function RepositoryDetail({ repo, onClose, onOpenArchitecture, onOpenActivity }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus to the panel when a repository is selected, so keyboard and screen-reader users
  // land on it (it can sit below the list on narrow screens).
  useEffect(() => {
    headingRef.current?.focus();
  }, [repo.id]);

  const rows: Row[] = [
    {
      label: 'Owner',
      value: repo.ownerType ? `${repo.owner} (${repo.ownerType})` : repo.owner,
    },
    { label: 'Visibility', value: VISIBILITY_LABELS[repo.visibility] },
  ];
  const optional: readonly (readonly [string, ReactNode | null])[] = [
    ['Primary language', repo.language],
    ['Updated', formatDate(repo.updatedAt)],
    ['Last pushed', formatDate(repo.pushedAt)],
    ['Stars', repo.stars === null ? null : formatCount(repo.stars)],
    ['Forks', repo.forks === null ? null : formatCount(repo.forks)],
    // GitHub's count includes open pull requests.
    ['Open issues and PRs', repo.openIssues === null ? null : formatCount(repo.openIssues)],
    ['Default branch', repo.defaultBranch],
    ['Archived', repo.isArchived === true ? 'Yes' : null],
    ['Fork', repo.isFork === true ? 'Yes' : null],
  ];
  for (const [label, value] of optional) {
    if (value !== null) rows.push({ label, value });
  }

  return (
    <aside className="detail" aria-labelledby="detail-heading">
      <div className="detail-head">
        <h2 id="detail-heading" ref={headingRef} tabIndex={-1}>
          {repo.fullName}
        </h2>
        <button type="button" onClick={onClose}>
          Close details
        </button>
      </div>

      {repo.description && <p>{repo.description}</p>}

      <div className="detail-actions">
        <button
          type="button"
          className="primary"
          data-architecture-button
          onClick={onOpenArchitecture}
        >
          View architecture
        </button>
        <button type="button" className="primary" data-activity-button onClick={onOpenActivity}>
          View activity
        </button>
      </div>

      <dl className="detail-list">
        {rows.map((row) => (
          <div key={row.label} className="detail-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {repo.topics.length > 0 && (
        <ul className="topics" aria-label="Topics">
          {repo.topics.map((topic) => (
            <li key={topic} className="badge">
              {topic}
            </li>
          ))}
        </ul>
      )}

      {repo.url && (
        <a href={repo.url} target="_blank" rel="noopener noreferrer">
          Open on GitHub ↗
        </a>
      )}

      <p className="note">
        Pull requests are in the activity view. Issues and more will have their own views in later
        phases.
      </p>
    </aside>
  );
}
