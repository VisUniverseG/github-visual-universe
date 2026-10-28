import { useEffect, useState } from 'react';
import { GitHubApiError } from '../github/client.ts';
import {
  loadRepositoryPage,
  type RepositoryCursor,
  type RepositoryItem,
} from '../github/repositories.ts';
import { loadViewerLogin } from '../github/viewer.ts';
import { describeGitHubError } from './messages.ts';

/** Safety cap: at most this many repository pages (100 each) are loaded per batch. */
export const MAX_AUTO_PAGES = 30;

/**
 * - `loading`:  pages are being fetched (items so far are partial).
 * - `complete`: every page has been loaded; statistics are final.
 * - `capped`:   the safety cap was reached with more pages remaining; statistics are partial.
 * - `error`:    a request failed part-way; what was loaded is kept and statistics are partial.
 */
export type DatasetPhase = 'loading' | 'complete' | 'capped' | 'error';

export interface DatasetState {
  readonly items: readonly RepositoryItem[];
  readonly cursor: RepositoryCursor | null;
  /** Entries GitHub sent that could not be read. */
  readonly skipped: number;
  /** Repository pages loaded so far. */
  readonly pages: number;
  readonly phase: DatasetPhase;
  readonly errorText: string | null;
}

export type ViewerState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ok'; readonly login: string }
  | { readonly kind: 'failed' };

const INITIAL: DatasetState = {
  items: [],
  cursor: null,
  skipped: 0,
  pages: 0,
  phase: 'loading',
  errorText: null,
};

interface LoadRequest {
  readonly cursor: RepositoryCursor | null;
  /** Start over (drop what was loaded) instead of continuing. */
  readonly reset: boolean;
  /** Changes on every request so an identical retry still re-runs the effect. */
  readonly attempt: number;
}

function mergeItems(
  current: readonly RepositoryItem[],
  incoming: readonly RepositoryItem[],
): readonly RepositoryItem[] {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...incoming.filter((item) => !seen.has(item.id))];
}

/**
 * Loads every accessible repository (read-only), page after page, plus the signed-in user's
 * login. State is set only from event handlers and async callbacks, never synchronously in an
 * effect. `onUnauthorized` must be referentially stable.
 */
export function useRepositoryDataset(accessToken: string, onUnauthorized: () => void) {
  const [data, setData] = useState<DatasetState>(INITIAL);
  const [request, setRequest] = useState<LoadRequest>({ cursor: null, reset: true, attempt: 0 });
  const [viewer, setViewer] = useState<ViewerState>({ kind: 'loading' });
  const [viewerAttempt, setViewerAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;

    void (async () => {
      let cursor = request.cursor;
      let reset = request.reset;
      try {
        for (let page = 0; page < MAX_AUTO_PAGES; page += 1) {
          const result = await loadRepositoryPage(accessToken, cursor, signal);
          if (signal.aborted) return;
          const startFresh = reset;
          reset = false;
          cursor = result.cursor;
          setData((previous) => {
            const base = startFresh ? INITIAL : previous;
            return {
              items: mergeItems(base.items, result.items),
              cursor: result.cursor,
              skipped: base.skipped + result.skipped,
              pages: base.pages + 1,
              phase: result.cursor === null ? 'complete' : 'loading',
              errorText: null,
            };
          });
          if (result.cursor === null) return;
        }
        if (!signal.aborted) setData((previous) => ({ ...previous, phase: 'capped' }));
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setData((previous) => ({
          ...previous,
          phase: 'error',
          errorText: describeGitHubError(error),
        }));
      }
    })();

    return () => controller.abort();
  }, [accessToken, request, onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();
    loadViewerLogin(accessToken, controller.signal).then(
      (login) => {
        if (!controller.signal.aborted) setViewer({ kind: 'ok', login });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setViewer({ kind: 'failed' });
      },
    );
    return () => controller.abort();
  }, [accessToken, viewerAttempt, onUnauthorized]);

  /** Continue after an error: keeps what was loaded, or starts over if nothing was. */
  const retry = () => {
    setData((previous) => ({ ...previous, phase: 'loading', errorText: null }));
    setRequest((current) => ({
      cursor: data.cursor,
      reset: data.pages === 0,
      attempt: current.attempt + 1,
    }));
  };

  /** Continue after the safety cap: loads up to another batch of pages. */
  const loadMore = () => {
    setData((previous) => ({ ...previous, phase: 'loading' }));
    setRequest((current) => ({ cursor: data.cursor, reset: false, attempt: current.attempt + 1 }));
  };

  const retryViewer = () => {
    setViewer({ kind: 'loading' });
    setViewerAttempt((attempt) => attempt + 1);
  };

  return { data, viewer, retry, loadMore, retryViewer };
}
