import { useEffect, useState } from 'react';
import { GitHubApiError } from '../github/client.ts';
import { loadRepositoryTree, type RepositoryTree } from '../github/tree.ts';
import { describeTreeError } from './messages.ts';

export type TreeState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly tree: RepositoryTree }
  | { readonly phase: 'error'; readonly errorText: string };

const LOADING: TreeState = { phase: 'loading' };

/** Everything a tree was requested with: a result belongs to exactly these inputs. */
const identityOf = (
  accessToken: string,
  owner: string,
  name: string,
  defaultBranch: string | null,
): string => JSON.stringify([accessToken, owner, name, defaultBranch]);

/**
 * Loads one repository's file tree (read-only). State is set only from event handlers and async
 * callbacks. A result is remembered together with what it was requested for, and only shown while
 * those inputs are still current: when the repository, branch or token changes, the hook reports
 * `loading` at once, so a tree can never be read as another repository's, whether or not the
 * caller remounts it. `onUnauthorized` must be referentially stable.
 */
export function useRepositoryTree(
  accessToken: string,
  owner: string,
  name: string,
  defaultBranch: string | null,
  onUnauthorized: () => void,
) {
  const identity = identityOf(accessToken, owner, name, defaultBranch);
  const [stored, setStored] = useState<{ readonly identity: string; readonly state: TreeState }>({
    identity,
    state: LOADING,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestedFor = identityOf(accessToken, owner, name, defaultBranch);
    loadRepositoryTree(accessToken, { owner, name, defaultBranch }, controller.signal).then(
      (tree) => {
        if (!controller.signal.aborted) {
          setStored({ identity: requestedFor, state: { phase: 'ready', tree } });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          onUnauthorized();
          return;
        }
        setStored({
          identity: requestedFor,
          state: { phase: 'error', errorText: describeTreeError(error) },
        });
      },
    );
    return () => controller.abort();
  }, [accessToken, owner, name, defaultBranch, attempt, onUnauthorized]);

  const retry = () => {
    setStored({ identity, state: LOADING });
    setAttempt((current) => current + 1);
  };

  // What was stored for other inputs is not an answer for these.
  const state = stored.identity === identity ? stored.state : LOADING;
  return { state, retry };
}
