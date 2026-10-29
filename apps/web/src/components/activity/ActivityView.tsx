import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { displayText } from '../../architecture/names.ts';
import {
  ACTIVITY_MESSAGES,
  describeBlockedUntil,
  describeBranchFailure,
  describeCommitFailure,
  partialListMessage,
  undatedMessage,
  type ActivityFailure,
} from '../../activity/messages.ts';
import { buildHistoryGraph } from '../../activity/historyGraph.ts';
import { buildTimeline } from '../../activity/timeline.ts';
import {
  statusOf,
  usePagedList,
  type ListStatus,
  type PagedListState,
} from '../../activity/usePagedList.ts';
import { formatCount } from '../../dashboard/format.ts';
import { loadBranchPage, loadCommitPage, type PageCursor } from '../../github/activity.ts';
import type { RepositoryItem } from '../../github/repositories.ts';
import { HandoffButton } from '../HandoffButton.tsx';
import { BranchTable } from './BranchTable.tsx';
import { CommitTable } from './CommitTable.tsx';
import { CommitTimeline } from './CommitTimeline.tsx';
import { HistoryGraph } from './HistoryGraph.tsx';

interface Props {
  readonly repo: RepositoryItem;
  readonly accessToken: string;
  /** Called when GitHub rejects the token (401). Must be referentially stable. */
  readonly onUnauthorized: () => void;
  readonly onBack: () => void;
}

/**
 * Recent activity of one repository, read-only: the latest commits on its default branch and its
 * branches. The two lists load, fail and are retried independently, so one failing never hides the
 * other. Nothing is stored: everything lives in memory while the view is open.
 */
export function ActivityView({ repo, accessToken, onUnauthorized, onBack }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [ended, setEnded] = useState(false);
  const endedRef = useRef(false);

  // Land on the new view: keyboard and screen-reader users start at its heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Both lists can learn on the same tick that the token was rejected; the session ends once. The
  // lists are then removed, which cancels whatever they still have in flight.
  const endSession = useCallback(() => {
    if (endedRef.current) return;
    endedRef.current = true;
    setEnded(true);
    onUnauthorized();
  }, [onUnauthorized]);

  return (
    <section aria-labelledby="activity-heading" className="activity">
      <div className="activity-head">
        <button type="button" onClick={onBack}>
          ← Back to repositories
        </button>
        <h2 id="activity-heading" ref={headingRef} tabIndex={-1}>
          {repo.fullName} · Activity
        </h2>
      </div>

      <p className="note">
        Read-only. Your browser reads commit subjects (the first line of each message), author names
        and dates, and branch names directly from GitHub, and keeps them in memory only while this
        view is open. File contents are never read.
      </p>

      {ended ? (
        <p role="alert" className="notice notice-error">
          {ACTIVITY_MESSAGES.unauthorized}
        </p>
      ) : (
        <>
          <CommitsSection repo={repo} accessToken={accessToken} onUnauthorized={endSession} />
          <BranchesSection repo={repo} accessToken={accessToken} onUnauthorized={endSession} />
        </>
      )}
    </section>
  );
}

interface SectionProps {
  readonly repo: RepositoryItem;
  readonly accessToken: string;
  readonly onUnauthorized: () => void;
}

function noun(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The status of one list in a word, with what has been loaded. Failed lists have no count. */
function StatusChip({
  status,
  loaded,
  empty = false,
}: {
  readonly status: ListStatus;
  /** What has been loaded so far, e.g. "120 commits". */
  readonly loaded: string;
  readonly empty?: boolean;
}) {
  if (status === 'loading') return null;
  if (empty) return <span className="chip chip-warn">Empty</span>;
  switch (status) {
    case 'complete':
      return <span className="chip chip-ok">{`Complete · ${loaded} loaded`}</span>;
    case 'partial':
      return <span className="chip chip-warn">{`Partial · ${loaded} loaded`}</span>;
    case 'partial_error':
      return <span className="chip chip-error">{`Partial, with an error · ${loaded} loaded`}</span>;
    default:
      return <span className="chip chip-error">Failed</span>;
  }
}

/** A list whose first page did not arrive. */
function FirstPageFailure({
  error,
  blocked,
  focusTarget,
  onRetry,
}: {
  readonly error: ActivityFailure;
  readonly blocked: boolean;
  readonly focusTarget: RefObject<HTMLElement | null>;
  readonly onRetry: () => void;
}) {
  return (
    <div role="alert" className="notice notice-error">
      <p>{error.text}</p>
      {error.retryable && !blocked && (
        <HandoffButton focusTarget={focusTarget} onClick={onRetry}>
          Try again
        </HandoffButton>
      )}
    </div>
  );
}

/** What follows a list that has loaded: a later page that failed, or the way to load more. */
function MoreControls<T>({
  state,
  blocked,
  label,
  focusTarget,
  onLoadMore,
}: {
  readonly state: PagedListState<T>;
  readonly blocked: boolean;
  /** "older commits" or "more branches". */
  readonly label: string;
  readonly focusTarget: RefObject<HTMLElement | null>;
  readonly onLoadMore: () => void;
}) {
  const { error, next, loadingMore, blockedUntil } = state;
  return (
    <>
      {blockedUntil !== null && (
        <p role="status" className="notice notice-warning">
          {describeBlockedUntil(blockedUntil)}
        </p>
      )}
      {error !== null && (
        <div role="alert" className="notice notice-error">
          <p>{error.text} What was already loaded is still shown.</p>
          {error.retryable && !blocked && (
            <HandoffButton focusTarget={focusTarget} onClick={onLoadMore}>
              Try again
            </HandoffButton>
          )}
        </div>
      )}
      {error === null && next?.kind === 'more' && !blocked && (
        <p>
          <HandoffButton focusTarget={focusTarget} onClick={onLoadMore}>
            {loadingMore ? `Loading ${label}…` : `Load ${label}`}
          </HandoffButton>
        </p>
      )}
    </>
  );
}

function CommitsSection({ repo, accessToken, onUnauthorized }: SectionProps) {
  const { owner, name, defaultBranch } = repo;
  const loadPage = useCallback(
    (cursor: PageCursor | null, signal: AbortSignal) =>
      loadCommitPage(accessToken, { owner, name, branch: defaultBranch }, cursor, signal),
    [accessToken, owner, name, defaultBranch],
  );
  const { state, loadMore, retry, blocked } = usePagedList({
    loadPage,
    describe: describeCommitFailure,
    onUnauthorized,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);

  const { items, loadedAt } = state;
  const timeline = useMemo(() => buildTimeline(items, loadedAt ?? 0), [items, loadedAt]);
  const graph = useMemo(() => buildHistoryGraph(items), [items]);
  const status = statusOf(state);
  const isEmptyRepository = state.phase === 'failed' && state.error?.kind === 'empty';
  const partial = partialListMessage({ noun: 'commits', next: state.next, skipped: state.skipped });
  const first = timeline.buckets[0];
  const last = timeline.buckets[timeline.buckets.length - 1];
  const branch = defaultBranch === null ? null : displayText(defaultBranch);

  return (
    <section aria-labelledby="commits-heading" className="panel">
      <div className="panel-head">
        <h3 id="commits-heading" ref={headingRef} tabIndex={-1}>
          Commits
        </h3>
        <StatusChip
          status={status}
          loaded={noun(items.length, 'commit', 'commits')}
          empty={isEmptyRepository}
        />
      </div>
      <p className="note">
        The latest commits on the default branch
        {branch === null ? '' : ` (${branch})`}. This is only what has been loaded, never a count of
        the repository&apos;s commits. Dates are UTC and are whatever each commit says.
      </p>

      {state.phase === 'loading' && (
        <p role="status" className="loading">
          Loading commits…
        </p>
      )}

      {state.phase === 'failed' &&
        state.error !== null &&
        (isEmptyRepository ? (
          <p className="note empty">{state.error.text}</p>
        ) : (
          <FirstPageFailure
            error={state.error}
            blocked={blocked}
            focusTarget={headingRef}
            onRetry={retry}
          />
        ))}
      {state.phase === 'failed' && state.blockedUntil !== null && (
        <p role="status" className="notice notice-warning">
          {describeBlockedUntil(state.blockedUntil)}
        </p>
      )}

      {state.phase === 'ready' && (
        <>
          {partial !== null && (
            <p role="status" className="notice notice-warning">
              {partial}
            </p>
          )}

          {items.length === 0 ? (
            status === 'complete' && <p className="note empty">{ACTIVITY_MESSAGES.noCommits}</p>
          ) : (
            <>
              {first !== undefined && last !== undefined && timeline.granularity !== null ? (
                <>
                  <CommitTimeline timeline={timeline} />
                  <p className="note">
                    Commits per {timeline.granularity} (UTC), counting only the{' '}
                    {noun(timeline.plotted, 'loaded commit', 'loaded commits')} with a usable date,
                    from {first.label} to {last.label}.
                    {state.next?.kind === 'end'
                      ? ''
                      : ' Older commits are not loaded, so earlier activity is missing.'}
                  </p>
                </>
              ) : (
                <p className="note">{ACTIVITY_MESSAGES.noUsableDates}</p>
              )}
              {timeline.unusable > 0 && timeline.plotted > 0 && (
                <p className="note">{undatedMessage(timeline.unusable)}</p>
              )}
              <h4 className="graph-heading">History graph</h4>
              <p className="note">
                How the loaded commits are connected: each line joins a commit to its parents, and a
                merge has two. The Parents column of the table lists the same links as text.
              </p>
              <HistoryGraph graph={graph} commits={items} next={state.next} />
              <CommitTable commits={items} graph={graph} now={loadedAt ?? 0} />
            </>
          )}

          <MoreControls
            state={state}
            blocked={blocked}
            label="older commits"
            focusTarget={headingRef}
            onLoadMore={loadMore}
          />
        </>
      )}
    </section>
  );
}

function BranchesSection({ repo, accessToken, onUnauthorized }: SectionProps) {
  const { owner, name, defaultBranch } = repo;
  const loadPage = useCallback(
    (cursor: PageCursor | null, signal: AbortSignal) =>
      loadBranchPage(accessToken, { owner, name }, cursor, signal),
    [accessToken, owner, name],
  );
  const { state, loadMore, retry, blocked } = usePagedList({
    loadPage,
    describe: describeBranchFailure,
    onUnauthorized,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);

  const { items } = state;
  const status = statusOf(state);
  const partial = partialListMessage({
    noun: 'branches',
    next: state.next,
    skipped: state.skipped,
  });

  return (
    <section aria-labelledby="branches-heading" className="panel">
      <div className="panel-head">
        <h3 id="branches-heading" ref={headingRef} tabIndex={-1}>
          Branches
        </h3>
        <StatusChip status={status} loaded={noun(items.length, 'branch', 'branches')} />
      </div>
      <p className="note">
        The repository&apos;s branches as GitHub lists them. Only the ones loaded so far are shown.
      </p>

      {state.phase === 'loading' && (
        <p role="status" className="loading">
          Loading branches…
        </p>
      )}

      {state.phase === 'failed' && state.error !== null && (
        <FirstPageFailure
          error={state.error}
          blocked={blocked}
          focusTarget={headingRef}
          onRetry={retry}
        />
      )}
      {state.phase === 'failed' && state.blockedUntil !== null && (
        <p role="status" className="notice notice-warning">
          {describeBlockedUntil(state.blockedUntil)}
        </p>
      )}

      {state.phase === 'ready' && (
        <>
          {partial !== null && (
            <p role="status" className="notice notice-warning">
              {partial}
            </p>
          )}

          {items.length === 0 ? (
            status === 'complete' && <p className="note empty">{ACTIVITY_MESSAGES.noBranches}</p>
          ) : (
            <BranchTable
              branches={items}
              defaultBranch={defaultBranch === null ? null : displayText(defaultBranch)}
            />
          )}

          <MoreControls
            state={state}
            blocked={blocked}
            label="more branches"
            focusTarget={headingRef}
            onLoadMore={loadMore}
          />
        </>
      )}
    </section>
  );
}
