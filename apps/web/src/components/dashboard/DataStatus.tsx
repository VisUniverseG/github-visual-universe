import { MAX_AUTO_PAGES } from '../../dashboard/useRepositoryDataset.ts';
import type { DatasetState, ViewerState } from '../../dashboard/useRepositoryDataset.ts';
import { REPOSITORY_MESSAGES, skippedMessage } from '../../dashboard/messages.ts';
import { formatCount } from '../../dashboard/format.ts';

interface Props {
  readonly data: DatasetState;
  readonly viewer: ViewerState;
  readonly onRetry: () => void;
  readonly onLoadMore: () => void;
  readonly onRetryViewer: () => void;
}

/**
 * Explains, in words, whether what is on screen is the whole dataset. Every way the data can be
 * incomplete (still loading, page cap, request failure, unreadable entries, unknown username)
 * has its own message.
 */
export function DataStatus({ data, viewer, onRetry, onLoadMore, onRetryViewer }: Props) {
  const loaded = data.items.length;

  return (
    <div className="data-status">
      {data.phase === 'loading' && (
        <p role="status" className="loading">
          {loaded === 0
            ? 'Loading repositories…'
            : `Loading repositories… ${formatCount(loaded)} loaded so far`}
        </p>
      )}

      {data.phase === 'capped' && (
        <div role="status" className="notice notice-warning">
          <p>
            Loaded the first {formatCount(loaded)} repositories and stopped at the safety limit of{' '}
            {String(MAX_AUTO_PAGES)} pages. Statistics and the language chart are partial and cover
            only these repositories.
          </p>
          <button type="button" onClick={onLoadMore}>
            Load more
          </button>
        </div>
      )}

      {data.phase === 'error' && (
        <div role="alert" className="notice notice-error">
          <p>{data.errorText}</p>
          {loaded > 0 && (
            <p>
              Loading stopped after {formatCount(loaded)} repositories. Statistics and the language
              chart are partial.
            </p>
          )}
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}

      {data.skipped > 0 && (
        <p role="status" className="notice notice-warning">
          {skippedMessage(data.skipped)}
        </p>
      )}

      {viewer.kind === 'failed' && (
        <div role="status" className="notice notice-warning">
          <p>{REPOSITORY_MESSAGES.viewerFailed}</p>
          <button type="button" onClick={onRetryViewer}>
            Retry username lookup
          </button>
        </div>
      )}
    </div>
  );
}
