import { useEffect, useState } from 'react';
import { GitHubApiError } from '../github/client.ts';
import {
  loadRepositoryPage,
  type RepositoryCursor,
  type RepositoryItem,
} from '../github/repositories.ts';

export const REPOSITORY_MESSAGES = {
  empty:
    'No repositories found. This app only lists repositories that you can access and that the GitHub App has been installed on. Install it on your account or organization (GitHub → Settings → Applications → Installed GitHub Apps) and grant it access to the repositories you want to explore.',
  rateLimited: 'GitHub rate limit reached. Please wait a bit and try again.',
  forbidden: 'GitHub refused this request. The App may not have the required access.',
  network: 'Could not reach GitHub. Check your connection and try again.',
  generic: 'GitHub returned an unexpected response. Please try again.',
} as const;

export function describeGitHubError(error: unknown, now: number = Date.now()): string {
  if (error instanceof GitHubApiError) {
    if (error.kind === 'rate_limited') {
      if (error.resetAt !== undefined && error.resetAt > now) {
        const minutes = Math.max(1, Math.ceil((error.resetAt - now) / 60_000));
        return `${REPOSITORY_MESSAGES.rateLimited} It resets in about ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
      }
      return REPOSITORY_MESSAGES.rateLimited;
    }
    if (error.kind === 'forbidden') return REPOSITORY_MESSAGES.forbidden;
    if (error.kind === 'network') return REPOSITORY_MESSAGES.network;
  }
  return REPOSITORY_MESSAGES.generic;
}

type Phase = 'loading' | 'ready' | 'loading_more' | 'error';

interface Props {
  readonly accessToken: string;
  /** Called when GitHub rejects the token (401). */
  readonly onUnauthorized: () => void;
}

interface LoadRequest {
  /** Where to continue from; `null` starts at the beginning. */
  readonly cursor: RepositoryCursor | null;
  /** True for the initial load, which replaces the list instead of extending it. */
  readonly isFirst: boolean;
  /** Changes on every request so that a retry of an identical request still re-runs the effect. */
  readonly attempt: number;
}

export function RepositoryBrowser({ accessToken, onUnauthorized }: Props) {
  const [items, setItems] = useState<readonly RepositoryItem[]>([]);
  const [cursor, setCursor] = useState<RepositoryCursor | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [request, setRequest] = useState<LoadRequest>({ cursor: null, isFirst: true, attempt: 0 });

  // State is set only from event handlers and from the async callbacks below, never
  // synchronously in the effect body. `onUnauthorized` must be referentially stable.
  useEffect(() => {
    const controller = new AbortController();
    loadRepositoryPage(accessToken, request.cursor, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setItems((current) => {
          if (request.isFirst) return page.items;
          const seen = new Set(current.map((item) => item.id));
          return [...current, ...page.items.filter((item) => !seen.has(item.id))];
        });
        setCursor(page.cursor);
        setStarted(true);
        setPhase('ready');
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setErrorText(describeGitHubError(error));
        setPhase('error');
      },
    );
    return () => controller.abort();
  }, [accessToken, request, onUnauthorized]);

  const loadMore = () => {
    setPhase('loading_more');
    setErrorText(null);
    setRequest((current) => ({ cursor, isFirst: false, attempt: current.attempt + 1 }));
  };

  const retry = () => {
    setPhase(started ? 'loading_more' : 'loading');
    setErrorText(null);
    setRequest((current) => ({
      cursor: started ? cursor : null,
      isFirst: !started,
      attempt: current.attempt + 1,
    }));
  };

  return (
    <section aria-labelledby="repos-heading">
      <h2 id="repos-heading">Your repositories</h2>

      {phase === 'loading' && <p role="status">Loading repositories…</p>}

      {phase === 'error' && (
        <div role="alert" className="notice notice-error">
          <p>{errorText}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}

      {started && items.length === 0 && phase !== 'error' && (
        <p className="note">{REPOSITORY_MESSAGES.empty}</p>
      )}

      {items.length > 0 && (
        <ul className="repo-list">
          {items.map((repo) => (
            <li key={repo.id} className="repo">
              <div className="repo-title">
                {repo.url ? (
                  <a href={repo.url} target="_blank" rel="noopener noreferrer">
                    {repo.fullName}
                  </a>
                ) : (
                  <span>{repo.fullName}</span>
                )}
                <span className="badge">{repo.isPrivate ? 'Private' : 'Public'}</span>
              </div>
              <div className="note">Owner: {repo.owner}</div>
              {repo.description && <p className="repo-description">{repo.description}</p>}
            </li>
          ))}
        </ul>
      )}

      {phase === 'loading_more' && <p role="status">Loading more…</p>}

      {cursor !== null && phase === 'ready' && (
        <button type="button" onClick={loadMore}>
          Load more
        </button>
      )}
    </section>
  );
}
