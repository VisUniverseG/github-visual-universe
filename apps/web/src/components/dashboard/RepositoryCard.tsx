import { formatCount, formatDate } from '../../dashboard/format.ts';
import type { RepositoryItem } from '../../github/repositories.ts';

export const VISIBILITY_LABELS = {
  public: 'Public',
  private: 'Private',
  internal: 'Internal',
} as const;

interface Props {
  readonly repo: RepositoryItem;
  readonly selected: boolean;
  readonly onSelect: (id: number) => void;
}

/** Only fields GitHub actually sent are shown; nothing is filled in for missing data. */
export function RepositoryCard({ repo, selected, onSelect }: Props) {
  const updated = formatDate(repo.updatedAt);

  return (
    <article className={selected ? 'card card-selected' : 'card'}>
      <div className="card-head">
        <button
          type="button"
          className="card-title"
          data-repo-id={repo.id}
          aria-pressed={selected}
          onClick={() => {
            onSelect(repo.id);
          }}
        >
          {repo.fullName}
        </button>
        <span className={`badge badge-${repo.visibility}`}>
          {VISIBILITY_LABELS[repo.visibility]}
        </span>
      </div>

      <div className="note">Owner: {repo.owner}</div>
      {repo.description && <p className="card-description">{repo.description}</p>}

      <div className="card-meta">
        {repo.language && <span className="meta-language">{repo.language}</span>}
        {repo.stars !== null && <span>★ {formatCount(repo.stars)}</span>}
        {updated && <span>Updated {updated}</span>}
        {repo.isArchived === true && <span className="badge">Archived</span>}
        {repo.isFork === true && <span className="badge">Fork</span>}
      </div>

      {repo.url && (
        <a
          className="card-link"
          href={repo.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${repo.fullName} on GitHub`}
        >
          View on GitHub ↗
        </a>
      )}
    </article>
  );
}
