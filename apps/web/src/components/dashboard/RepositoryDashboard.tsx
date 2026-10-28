import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCount } from '../../dashboard/format.ts';
import {
  DEFAULT_FILTERS,
  NO_LANGUAGE,
  applyFilters,
  hasActiveFilters,
  type Filters,
} from '../../dashboard/filters.ts';
import { REPOSITORY_MESSAGES } from '../../dashboard/messages.ts';
import { computeStats, languageDistribution } from '../../dashboard/stats.ts';
import { useRepositoryDataset } from '../../dashboard/useRepositoryDataset.ts';
import { ArchitectureView } from '../architecture/ArchitectureView.tsx';
import { DataStatus } from './DataStatus.tsx';
import { FilterBar, type LanguageOption } from './FilterBar.tsx';
import { LanguageChart } from './LanguageChart.tsx';
import { RepositoryCard } from './RepositoryCard.tsx';
import { RepositoryDetail } from './RepositoryDetail.tsx';
import { StatsGrid } from './StatsGrid.tsx';

interface Props {
  readonly accessToken: string;
  /** Called when GitHub rejects the token (401). Must be referentially stable. */
  readonly onUnauthorized: () => void;
}

export function RepositoryDashboard({ accessToken, onUnauthorized }: Props) {
  const { data, viewer, retry, loadMore, retryViewer } = useRepositoryDataset(
    accessToken,
    onUnauthorized,
  );
  const viewerLogin = viewer.kind === 'ok' ? viewer.login : null;
  const complete = data.phase === 'complete';
  // Figures are only final when every page loaded AND every entry was readable.
  const exact = complete && data.skipped === 0;

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const returnFocusId = useRef<number | null>(null);
  // The repository whose architecture is open. The dashboard stays mounted (just hidden) so its
  // loaded data, filters and selection survive going there and back.
  const [architectureId, setArchitectureId] = useState<number | null>(null);
  const returnToArchitectureButton = useRef(false);

  // Statistics and the chart always describe the whole loaded dataset, never the filtered view
  // and never just the latest page.
  const stats = useMemo(() => computeStats(data.items, viewerLogin), [data.items, viewerLogin]);
  const distribution = useMemo(() => languageDistribution(data.items), [data.items]);
  const visible = useMemo(
    () => applyFilters(data.items, filters, viewerLogin),
    [data.items, filters, viewerLogin],
  );
  const languageOptions = useMemo<LanguageOption[]>(
    () =>
      distribution.entries.map((entry) => ({
        value: entry.language ?? NO_LANGUAGE,
        label: `${entry.language ?? 'No language detected'} (${formatCount(entry.count)})`,
      })),
    [distribution],
  );

  const selected = useMemo(
    () =>
      selectedId === null ? null : (data.items.find((item) => item.id === selectedId) ?? null),
    [data.items, selectedId],
  );

  // After the detail panel closes, return focus to the card that opened it.
  useEffect(() => {
    if (selectedId === null && returnFocusId.current !== null) {
      document
        .querySelector<HTMLElement>(`[data-repo-id="${String(returnFocusId.current)}"]`)
        ?.focus();
      returnFocusId.current = null;
    }
  }, [selectedId]);

  const architectureRepo =
    architectureId === null
      ? null
      : (data.items.find((item) => item.id === architectureId) ?? null);

  // Back from the architecture view: focus the button that opened it.
  useEffect(() => {
    if (architectureId === null && returnToArchitectureButton.current) {
      returnToArchitectureButton.current = false;
      document.querySelector<HTMLElement>('[data-architecture-button]')?.focus();
    }
  }, [architectureId]);

  const closeArchitecture = () => {
    returnToArchitectureButton.current = true;
    setArchitectureId(null);
  };

  const closeDetail = () => {
    returnFocusId.current = selectedId;
    setSelectedId(null);
  };

  const hasItems = data.items.length > 0;
  const showEmpty = complete && !hasItems;
  const filtersActive = hasActiveFilters(filters);
  const reset = () => {
    setFilters((current) => ({ ...DEFAULT_FILTERS, sort: current.sort }));
  };

  return (
    <>
      <div className="dashboard" hidden={architectureRepo !== null}>
        <DataStatus
          data={data}
          viewer={viewer}
          onRetry={retry}
          onLoadMore={loadMore}
          onRetryViewer={retryViewer}
        />

        {showEmpty && <p className="note empty">{REPOSITORY_MESSAGES.empty}</p>}

        {hasItems && (
          <>
            <div className="insights">
              <StatsGrid stats={stats} viewer={viewer} complete={exact} />
              <LanguageChart distribution={distribution} complete={exact} />
            </div>

            <section aria-labelledby="repos-heading" className="panel">
              <div className="panel-head">
                <h2 id="repos-heading">Repositories</h2>
                <span className="note" aria-live="polite">
                  Showing {formatCount(visible.length)} of {formatCount(data.items.length)}
                  {exact ? '' : ' (partial)'}
                </span>
              </div>

              <FilterBar
                filters={filters}
                onChange={setFilters}
                onReset={reset}
                canReset={filtersActive}
                languageOptions={languageOptions}
                ownershipAvailable={viewerLogin !== null}
                showOther={stats.other !== null && stats.other > 0}
              />

              <div className={selected ? 'repo-layout repo-layout-split' : 'repo-layout'}>
                {visible.length === 0 ? (
                  <div className="empty">
                    <p>{REPOSITORY_MESSAGES.noResults}</p>
                    <button type="button" onClick={reset}>
                      Reset filters
                    </button>
                  </div>
                ) : (
                  <div className="repo-grid">
                    {visible.map((repo) => (
                      <RepositoryCard
                        key={repo.id}
                        repo={repo}
                        selected={repo.id === selectedId}
                        onSelect={setSelectedId}
                      />
                    ))}
                  </div>
                )}
                {selected && (
                  <RepositoryDetail
                    repo={selected}
                    onClose={closeDetail}
                    onOpenArchitecture={() => {
                      setArchitectureId(selected.id);
                    }}
                  />
                )}
              </div>
            </section>
          </>
        )}
      </div>

      {architectureRepo && (
        <ArchitectureView
          key={architectureRepo.id}
          repo={architectureRepo}
          accessToken={accessToken}
          onUnauthorized={onUnauthorized}
          onBack={closeArchitecture}
        />
      )}
    </>
  );
}
