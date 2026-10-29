import type { CommitItem, PageNext } from '../github/activity.ts';
import type { PullItem } from '../github/pulls.ts';

/**
 * Which loaded commit, if any, a merged pull request produced. The only evidence is GitHub's own
 * `merge_commit_sha` of the PR, compared as a whole with the SHAs of the commits that are already
 * loaded for the history graph. Nothing is guessed: branch names, titles, dates and abbreviated or
 * similar SHAs are never compared, and nothing is requested to look a commit up.
 *
 * GitHub's `merge_commit_sha` names a commit on the PR's base branch for every way of merging: the
 * merge commit itself, the single squashed commit, or the last of the rebased commits. So a match
 * is the same commit in all three cases, and this does not try to tell them apart.
 */

/** How far the list of commits the PRs are matched against has got. */
export interface CommitIndex {
  readonly phase: 'loading' | 'failed' | 'ready';
  /** What follows the loaded commits; `null` until the first page has arrived. */
  readonly next: PageNext | null;
  /** The loaded commits by full SHA. A SHA listed twice keeps its first row. */
  readonly bySha: ReadonlyMap<string, CommitItem>;
}

export function buildCommitIndex(
  commits: readonly CommitItem[],
  phase: CommitIndex['phase'],
  next: PageNext | null,
): CommitIndex {
  const bySha = new Map<string, CommitItem>();
  for (const commit of commits) {
    if (!bySha.has(commit.sha)) bySha.set(commit.sha, commit);
  }
  return { phase, next, bySha };
}

/** Why a merged PR's commit is not among the loaded ones. */
export type NotLoadedReason = 'loading' | 'failed' | 'more' | 'capped' | 'end';

export type MergeLink =
  /** Not merged: there is no merge commit to look for. */
  | { readonly kind: 'none' }
  /** Merged, but GitHub did not state which commit it produced. */
  | { readonly kind: 'not_stated' }
  /** Merged, and that exact commit is among the loaded commits. */
  | {
      readonly kind: 'linked';
      readonly sha: string;
      /** `true` for a commit with two or more parents; `null` if its parents are not stated. */
      readonly isMergeCommit: boolean | null;
    }
  /** Merged, and that commit is not (or not yet known to be) among the loaded commits. */
  | { readonly kind: 'not_loaded'; readonly sha: string; readonly reason: NotLoadedReason };

export function linkMergeCommit(pull: PullItem, commits: CommitIndex): MergeLink {
  if (pull.state !== 'merged') return { kind: 'none' };
  const sha = pull.mergeCommitSha;
  if (sha === null) return { kind: 'not_stated' };

  const commit = commits.bySha.get(sha);
  if (commit !== undefined) {
    return {
      kind: 'linked',
      sha,
      isMergeCommit: commit.parentCount === null ? null : commit.parentCount > 1,
    };
  }

  let reason: NotLoadedReason;
  if (commits.phase === 'loading') reason = 'loading';
  else if (commits.phase === 'failed') reason = 'failed';
  else if (commits.next?.kind === 'more') reason = 'more';
  else if (commits.next?.kind === 'capped') reason = 'capped';
  else reason = 'end';
  return { kind: 'not_loaded', sha, reason };
}
