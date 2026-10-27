import { formatCount } from '../../dashboard/format.ts';
import type { RepositoryStats } from '../../dashboard/stats.ts';
import type { ViewerState } from '../../dashboard/useRepositoryDataset.ts';

interface Props {
  readonly stats: RepositoryStats;
  readonly viewer: ViewerState;
  /** True once every page has been loaded; otherwise every figure is a partial count. */
  readonly complete: boolean;
}

interface Stat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

export function StatsGrid({ stats, viewer, complete }: Props) {
  const cards: Stat[] = [
    { key: 'total', label: 'Total', value: formatCount(stats.total) },
    { key: 'public', label: 'Public', value: formatCount(stats.public) },
    { key: 'private', label: 'Private', value: formatCount(stats.private) },
  ];

  // Personal and "other accounts" depend on knowing who is signed in; hide them when unknown.
  if (viewer.kind === 'loading') {
    cards.push({
      key: 'personal',
      label: 'Personal',
      value: '…',
      hint: 'Looking up your username',
    });
  } else if (stats.personal !== null) {
    cards.push({ key: 'personal', label: 'Personal', value: formatCount(stats.personal) });
  }
  cards.push({
    key: 'organization',
    label: 'Organization',
    value: formatCount(stats.organization),
  });
  if (stats.other !== null && stats.other > 0) {
    cards.push({
      key: 'other',
      label: 'Other accounts',
      value: formatCount(stats.other),
      hint: 'Owned by other users',
    });
  }

  const unknown = stats.unknownOwnership;

  return (
    <section aria-labelledby="overview-heading" className="panel">
      <div className="panel-head">
        <h2 id="overview-heading">Overview</h2>
        <span className={`chip ${complete ? 'chip-ok' : 'chip-warn'}`}>
          {complete
            ? `Complete · ${formatCount(stats.total)} ${stats.total === 1 ? 'repository' : 'repositories'}`
            : `Partial · ${formatCount(stats.total)} ${stats.total === 1 ? 'repository' : 'repositories'} counted`}
        </span>
      </div>
      <dl className="stats">
        {cards.map((card) => (
          <div key={card.key} className="stat">
            <dt>{card.label}</dt>
            <dd>{card.value}</dd>
            {card.hint && <span className="note">{card.hint}</span>}
          </div>
        ))}
      </dl>
      {unknown > 0 && (
        <p className="note">
          {formatCount(unknown)} {unknown === 1 ? 'repository has' : 'repositories have'} an owner
          type that could not be determined and {unknown === 1 ? 'is' : 'are'} not counted as
          personal, organization or other.
        </p>
      )}
      {!complete && (
        <p className="note">
          These figures cover only the repositories that were loaded and readable, not necessarily
          your whole account.
        </p>
      )}
    </section>
  );
}
