import { useEffect, useState } from 'react';
import { GitHubApiError } from '../github/client.ts';
import { loadRepositoryTree, type RepositoryTree } from '../github/tree.ts';
import { describeTreeError } from './messages.ts';

export type TreeState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly tree: RepositoryTree }
  | { readonly phase: 'error'; readonly errorText: string };

/**
 * Loads one repository's file tree (read-only). State is set only from event handlers and async
 * callbacks. The caller should remount (`key`) it per repository, so a new repository always
 * starts in `loading`. `onUnauthorized` must be referentially stable.
 */
export function useRepositoryTree(
  accessToken: string,
  owner: string,
  name: string,
  defaultBranch: string | null,
  onUnauthorized: () => void,
) {
  const [state, setState] = useState<TreeState>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    loadRepositoryTree(accessToken, { owner, name, defaultBranch }, controller.signal).then(
      (tree) => {
        if (!controller.signal.aborted) setState({ phase: 'ready', tree });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setState({ phase: 'error', errorText: describeTreeError(error) });
      },
    );
    return () => controller.abort();
  }, [accessToken, owner, name, defaultBranch, attempt, onUnauthorized]);

  const retry = () => {
    setState({ phase: 'loading' });
    setAttempt((current) => current + 1);
  };

  return { state, retry };
}
