import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import {
  ACTIVITY_MESSAGES,
  describeBlockedUntil,
  describeIssueFailure,
  omittedPullRequestsMessage,
  partialListMessage,
} from '../../activity/messages.ts';
import { statusOf, usePagedList } from '../../activity/usePagedList.ts';
import type { PageCursor } from '../../github/activity.ts';
import { loadIssuePage } from '../../github/issues.ts';
import type { RepositoryItem } from '../../github/repositories.ts';
import { IssueTable } from './IssueTable.tsx';
import { FirstPageFailure, MoreControls, StatusChip, noun } from './ListParts.tsx';

interface Props {
  readonly repo: RepositoryItem;
  readonly accessToken: string;
  readonly onUnauthorized: () => void;
}

const INTRO =
  'The most recently updated issues, as GitHub lists them. GitHub lists pull requests together with issues; they are left out here and are in the Pull requests panel. This is only what has been loaded, never a count of the repository’s issues. Titles, label names and author logins are read from GitHub and kept in memory only while this view is open. Issue descriptions are not kept and comments are not read.';

/**
 * Issues of one repository, read-only. Nothing is requested until the reader asks: the panel
 * starts as a button, and the list (with its own paging, failures and rate-limit pause) exists
 * only once it has been pressed. Focus moves to the heading when the list appears.
 */
export function IssuesSection(props: Props) {
  const [requested, setRequested] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // The button is gone once pressed: put focus on the heading of the panel that replaces it.
  useEffect(() => {
    if (requested) headingRef.current?.focus();
  }, [requested]);

  if (!requested) {
    return (
      <section aria-labelledby="issues-heading" className="panel">
        <div className="panel-head">
          <h3 id="issues-heading" ref={headingRef} tabIndex={-1}>
            Issues
          </h3>
        </div>
        <p className="note">{INTRO}</p>
        <p className="note">Nothing is requested from GitHub until you load them.</p>
        <p>
          <button
            type="button"
            onClick={() => {
              setRequested(true);
            }}
          >
            Load issues
          </button>
        </p>
      </section>
    );
  }
  return <LoadedIssues {...props} headingRef={headingRef} />;
}

function LoadedIssues({
  repo,
  accessToken,
  onUnauthorized,
  headingRef,
}: Props & { readonly headingRef: RefObject<HTMLHeadingElement | null> }) {
  const { owner, name } = repo;
  const loadPage = useCallback(
    (cursor: PageCursor | null, signal: AbortSignal) =>
      loadIssuePage(accessToken, { owner, name }, cursor, signal),
    [accessToken, owner, name],
  );
  const { state, loadMore, retry, blocked } = usePagedList({
    loadPage,
    describe: describeIssueFailure,
    onUnauthorized,
  });

  const { items } = state;
  const status = statusOf(state);
  const partial = partialListMessage({
    noun: 'issues',
    next: state.next,
    skipped: state.skipped,
  });
  const omittedNote = omittedPullRequestsMessage(state.omitted);
  // Issues turned off: GitHub's answer is shown as an empty list, not as an error.
  const isDisabled = state.phase === 'failed' && state.error?.kind === 'empty';
  // Empty only when GitHub has nothing more to give. A page of pull requests alone is not that.
  const isEmpty =
    isDisabled || (state.phase === 'ready' && items.length === 0 && status === 'complete');
  const noneYet = state.phase === 'ready' && items.length === 0 && !isEmpty;

  return (
    <section aria-labelledby="issues-heading" className="panel">
      <div className="panel-head">
        <h3 id="issues-heading" ref={headingRef} tabIndex={-1}>
          Issues
        </h3>
        <StatusChip
          status={status}
          loaded={noun(items.length, 'issue', 'issues')}
          empty={isEmpty}
        />
      </div>
      <p className="note">{INTRO}</p>

      {state.phase === 'loading' && (
        <p role="status" className="loading">
          Loading issues…
        </p>
      )}

      {state.phase === 'failed' &&
        state.error !== null &&
        (isDisabled ? (
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
          {omittedNote !== null && <p className="note">{omittedNote}</p>}

          {items.length === 0 ? (
            <>
              {isEmpty && <p className="note empty">{ACTIVITY_MESSAGES.noIssues}</p>}
              {noneYet && <p className="note empty">{ACTIVITY_MESSAGES.noIssuesYet}</p>}
            </>
          ) : (
            <IssueTable issues={items} />
          )}

          <MoreControls
            state={state}
            blocked={blocked}
            label="older issues"
            focusTarget={headingRef}
            onLoadMore={loadMore}
          />
        </>
      )}
    </section>
  );
}
