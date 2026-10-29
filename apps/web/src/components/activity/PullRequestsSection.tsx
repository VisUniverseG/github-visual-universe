import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  ACTIVITY_MESSAGES,
  describeBlockedUntil,
  describePullFailure,
  partialListMessage,
} from '../../activity/messages.ts';
import type { CommitIndex } from '../../activity/pullLinks.ts';
import { statusOf, usePagedList } from '../../activity/usePagedList.ts';
import type { PageCursor } from '../../github/activity.ts';
import { loadPullPage } from '../../github/pulls.ts';
import type { RepositoryItem } from '../../github/repositories.ts';
import { FirstPageFailure, MoreControls, StatusChip, noun } from './ListParts.tsx';
import { PullRequestTable } from './PullRequestTable.tsx';

interface Props {
  readonly repo: RepositoryItem;
  readonly accessToken: string;
  readonly onUnauthorized: () => void;
  /** The commits loaded for the history graph: merged pull requests are matched to them. */
  readonly commits: CommitIndex;
  readonly onShowCommit: (sha: string) => void;
}

const INTRO =
  'The most recently updated pull requests, as GitHub lists them. This is only what has been loaded, never a count of the repository’s pull requests. Titles, branch names and author logins are read from GitHub and kept in memory only while this view is open.';

/**
 * Pull requests of one repository, read-only. Nothing is requested until the reader asks: the
 * panel starts as a button, and the list (with its own paging, failures and rate-limit pause)
 * exists only once it has been pressed. Focus moves to the heading when the list appears.
 */
export function PullRequestsSection(props: Props) {
  const [requested, setRequested] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The button is gone once pressed: put focus on the heading of the panel that replaces it.
  useEffect(() => {
    if (requested) headingRef.current?.focus();
  }, [requested]);

  if (!requested) {
    return (
      <section aria-labelledby="pulls-heading" className="panel">
        <div className="panel-head">
          <h3 id="pulls-heading" ref={headingRef} tabIndex={-1}>
            Pull requests
          </h3>
        </div>
        <p className="note">{INTRO}</p>
        <p className="note">
          Nothing is requested from GitHub until you load them. A merged pull request gets a button
          that takes you to its commit in the commit table, only when that exact commit is among the
          loaded commits.
        </p>
        <p>
          <button
            type="button"
            onClick={() => {
              setRequested(true);
            }}
          >
            Load pull requests
          </button>
        </p>
      </section>
    );
  }
  return <LoadedPullRequests {...props} headingRef={headingRef} />;
}

function LoadedPullRequests({
  repo,
  accessToken,
  onUnauthorized,
  commits,
  onShowCommit,
  headingRef,
}: Props & { readonly headingRef: RefObject<HTMLHeadingElement | null> }) {
  const { owner, name } = repo;
  const loadPage = useCallback(
    (cursor: PageCursor | null, signal: AbortSignal) =>
      loadPullPage(accessToken, { owner, name }, cursor, signal),
    [accessToken, owner, name],
  );
  const { state, loadMore, retry, blocked } = usePagedList({
    loadPage,
    describe: describePullFailure,
    onUnauthorized,
  });

  const { items } = state;
  const status = statusOf(state);
  const partial = partialListMessage({
    noun: 'pull requests',
    next: state.next,
    skipped: state.skipped,
  });
  const isEmpty = state.phase === 'ready' && items.length === 0 && status === 'complete';

  return (
    <section aria-labelledby="pulls-heading" className="panel">
      <div className="panel-head">
        <h3 id="pulls-heading" ref={headingRef} tabIndex={-1}>
          Pull requests
        </h3>
        <StatusChip
          status={status}
          loaded={noun(items.length, 'pull request', 'pull requests')}
          empty={isEmpty}
        />
      </div>
      <p className="note">{INTRO}</p>

      {state.phase === 'loading' && (
        <p role="status" className="loading">
          Loading pull requests…
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
            isEmpty && <p className="note empty">{ACTIVITY_MESSAGES.noPulls}</p>
          ) : (
            <PullRequestTable pulls={items} commits={commits} onShowCommit={onShowCommit} />
          )}

          <MoreControls
            state={state}
            blocked={blocked}
            label="older pull requests"
            focusTarget={headingRef}
            onLoadMore={loadMore}
          />
        </>
      )}
    </section>
  );
}
