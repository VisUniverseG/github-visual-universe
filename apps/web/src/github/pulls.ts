import { parsePullRequestList, type GitHubPullRequest } from '@gvu/shared';
import { displayText } from '../architecture/names.ts';
import { loadActivityPage, type ActivityPage, type PageCursor } from './activity.ts';
import type { RepositoryRef } from './tree.ts';

/**
 * Pull requests of one repository (read-only):
 *
 *   GET /repos/{owner}/{repo}/pulls?state=all&sort=updated&direction=desc&per_page=100
 *
 * Read exactly like the commit and branch lists: the first page when the panel is opened, every
 * later page only when asked, by following GitHub's `Link: rel="next"` URL, at most
 * {@link MAX_PULL_PAGES} pages. Nothing is requested per pull request.
 *
 * Only what the panel shows is kept. Everything that comes from the repository (the title, the
 * branch names, the author's login) is untrusted: it goes through `displayText` and is only ever
 * shown as text, never put in a URL.
 */

export const PULL_PAGE_SIZE = 100;
export const MAX_PULL_PAGES = 5;

/**
 * - `open`, `draft`: not closed. `draft` only when GitHub said so.
 * - `merged`: closed, and GitHub gave a merge date.
 * - `closed`: closed without being merged.
 */
export type PullState = 'open' | 'draft' | 'merged' | 'closed';

export interface PullItem {
  readonly number: number;
  /** Display-safe. Empty when GitHub sent none. */
  readonly title: string;
  readonly state: PullState;
  /** An open PR whose draft flag GitHub did not state: it is shown as open, not as a draft. */
  readonly draftUnknown: boolean;
  /** Display-safe branch names, or `null` when GitHub did not give them. */
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  /** Display-safe, or `null` when GitHub gave no author. */
  readonly authorLogin: string | null;
  /** The dates as the ISO text GitHub sent; `null` if missing or unusable. */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
  readonly mergedAt: string | null;
  /**
   * The commit GitHub says the PR produced on its base branch: a merge commit, a squashed commit or
   * the last rebased commit. Present only for a `merged` PR whose SHA GitHub stated. For any other
   * PR GitHub's value is a throwaway test merge, so it is dropped here and can never be linked.
   */
  readonly mergeCommitSha: string | null;
}

function validIsoDate(value: string | null | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? displayText(trimmed) : null;
}

export function toPullItem(pull: GitHubPullRequest): PullItem {
  const merged = typeof pull.merged_at === 'string' && pull.merged_at !== '';
  let state: PullState;
  if (pull.state === 'closed') state = merged ? 'merged' : 'closed';
  else state = pull.draft === true ? 'draft' : 'open';
  return {
    number: pull.number,
    title: displayText((pull.title ?? '').trim()),
    state,
    draftUnknown: state === 'open' && typeof pull.draft !== 'boolean',
    headBranch: safeText(pull.head?.ref),
    baseBranch: safeText(pull.base?.ref),
    authorLogin: safeText(pull.user?.login),
    createdAt: validIsoDate(pull.created_at),
    updatedAt: validIsoDate(pull.updated_at),
    closedAt: validIsoDate(pull.closed_at),
    mergedAt: validIsoDate(pull.merged_at),
    mergeCommitSha: state === 'merged' ? (pull.merge_commit_sha ?? null) : null,
  };
}

/**
 * Loads one page of pull requests. Pass `null` to start; pass the previous page's cursor to
 * continue. Repository names are validated before anything is sent.
 */
export function loadPullPage(
  token: string,
  target: RepositoryRef,
  cursor: PageCursor | null,
  signal?: AbortSignal,
): Promise<ActivityPage<PullItem>> {
  return loadActivityPage({
    token,
    target,
    path: 'pulls',
    query: new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(PULL_PAGE_SIZE),
    }),
    cursor,
    maxPages: MAX_PULL_PAGES,
    parse: (json) => {
      const { pulls, skipped } = parsePullRequestList(json);
      return { entries: pulls, skipped };
    },
    toItem: toPullItem,
    signal,
  });
}
