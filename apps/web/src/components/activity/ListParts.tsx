import type { RefObject } from 'react';
import { describeBlockedUntil, type ActivityFailure } from '../../activity/messages.ts';
import type { ListStatus, PagedListState } from '../../activity/usePagedList.ts';
import { formatCount } from '../../dashboard/format.ts';
import { HandoffButton } from '../HandoffButton.tsx';

// Pieces shared by the lists of the Activity view (commits, pull requests, branches).

export function noun(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The status of one list in a word, with what has been loaded. Failed lists have no count. */
export function StatusChip({
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
export function FirstPageFailure({
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
export function MoreControls<T>({
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
