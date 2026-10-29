import {
  parseBranchList,
  parseCommitList,
  type GitHubBranchListEntry,
  type GitHubCommit,
} from '@gvu/shared';
import { displayText } from '../architecture/names.ts';
import { GitHubApiError, githubGet, type GitHubRateLimit } from './client.ts';
import { assertSafeRepository, type RepositoryRef } from './tree.ts';

/**
 * Repository activity (read-only): recent commits on the default branch, and the branch list.
 *
 *   GET /repos/{owner}/{repo}/commits?per_page=100[&sha={branch}]
 *   GET /repos/{owner}/{repo}/branches?per_page=100
 *
 * Both are read a page at a time. The first page is requested by the caller; each further page is
 * requested only when asked for, by following the `Link: rel="next"` URL that GitHub gave (it is
 * checked to be on api.github.com by `githubGet`). At most {@link MAX_COMMIT_PAGES} and
 * {@link MAX_BRANCH_PAGES} pages are ever read, so nothing here can loop or fetch without bound.
 *
 * Only what the view shows is kept: for a commit, the first line of its message, the author's
 * name and GitHub login, a date and the parents' SHAs; for a branch, its name, head SHA and
 * protection flag. Email addresses are never read (the shared schema drops them). Every string
 * that comes from a repository is untrusted: it goes through `displayText` and is only ever shown
 * as text, never put in a URL.
 */

export const ACTIVITY_PAGE_SIZE = 100;
export const MAX_COMMIT_PAGES = 5;
export const MAX_BRANCH_PAGES = 5;

/** Where the next page is, and which page it is (the first page is 1, so a cursor starts at 2). */
export interface PageCursor {
  readonly nextUrl: string;
  readonly page: number;
}

/** What follows a page: nothing, a cursor to ask for more, or a stop at the page cap. */
export type PageNext =
  | { readonly kind: 'end' }
  | { readonly kind: 'more'; readonly cursor: PageCursor }
  | { readonly kind: 'capped' };

export interface ActivityPage<T> {
  readonly items: readonly T[];
  /** Entries in GitHub's response that could not be read and were left out. */
  readonly skipped: number;
  readonly next: PageNext;
  /** From this response; `null` when it carried no readable rate-limit headers. */
  readonly rateLimit: GitHubRateLimit | null;
}

export interface CommitItem {
  readonly sha: string;
  /** The first line of the message, display-safe. Empty when the commit has no message. */
  readonly subject: string;
  /** The name recorded in the commit (display-safe), or `null`. Never an email address. */
  readonly authorName: string | null;
  /** The matching GitHub account (display-safe), or `null` when GitHub found none. */
  readonly authorLogin: string | null;
  /** The author's date, else the committer's, as the ISO text GitHub sent; `null` if unusable. */
  readonly date: string | null;
  /** `null` when GitHub did not say. A merge has more than one. */
  readonly parentCount: number | null;
  /**
   * The parents' SHAs in GitHub's order (the first is the mainline), for the history graph.
   * `null` when GitHub did not say. A parent that could not be read keeps its place as `null`,
   * so the length always equals `parentCount`. An empty list is a root commit.
   */
  readonly parentShas: readonly (string | null)[] | null;
}

export interface BranchItem {
  /** Display-safe. */
  readonly name: string;
  readonly headSha: string;
  /** `null` when GitHub did not say. */
  readonly isProtected: boolean | null;
}

export interface CommitTarget extends RepositoryRef {
  /** The default branch from the repository list. `null` lets GitHub use the default branch. */
  readonly branch: string | null;
}

function validIsoDate(value: string | null | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The first line of a commit message; the rest of it is never kept. */
function subjectOf(message: string | null | undefined): string {
  const firstLine = (message ?? '').split(/\r\n|[\r\n]/, 1)[0] ?? '';
  return displayText(firstLine.trim());
}

export function toCommitItem(commit: GitHubCommit): CommitItem {
  const name = nonEmpty(commit.commit.author?.name);
  const login = nonEmpty(commit.author?.login);
  return {
    sha: commit.sha,
    subject: subjectOf(commit.commit.message),
    authorName: name === null ? null : displayText(name),
    authorLogin: login === null ? null : displayText(login),
    date: validIsoDate(commit.commit.author?.date) ?? validIsoDate(commit.commit.committer?.date),
    parentCount: commit.parents?.length ?? null,
    parentShas: commit.parents ?? null,
  };
}

export function toBranchItem(branch: GitHubBranchListEntry): BranchItem {
  return {
    name: displayText(branch.name),
    headSha: branch.commit.sha,
    isProtected: branch.protected ?? null,
  };
}

async function loadActivityPage<Raw, Item>(args: {
  readonly token: string;
  readonly target: RepositoryRef;
  /** The query part of the first page's URL, after `?`. */
  readonly query: URLSearchParams;
  readonly path: 'commits' | 'branches';
  readonly cursor: PageCursor | null;
  readonly maxPages: number;
  readonly parse: (json: unknown) => { readonly entries: readonly Raw[]; readonly skipped: number };
  readonly toItem: (entry: Raw) => Item;
  readonly signal?: AbortSignal | undefined;
}): Promise<ActivityPage<Item>> {
  const { cursor, maxPages } = args;
  // Repository names are checked before anything is sent; a failure is a rejected promise.
  const base = assertSafeRepository(args.target);
  const firstUrl = `${base}/${args.path}?${args.query.toString()}`;
  // A cursor only ever comes from a previous page of this same list, so anything else is a bug.
  if (cursor !== null && (cursor.page < 2 || cursor.page > maxPages)) {
    throw new GitHubApiError('invalid_response');
  }
  const page = cursor === null ? 1 : cursor.page;

  const result = await githubGet(
    cursor === null ? firstUrl : cursor.nextUrl,
    args.token,
    args.parse,
    args.signal,
  );

  let next: PageNext;
  if (result.nextUrl === null) next = { kind: 'end' };
  else if (page >= maxPages) next = { kind: 'capped' };
  else next = { kind: 'more', cursor: { nextUrl: result.nextUrl, page: page + 1 } };

  return {
    items: result.data.entries.map(args.toItem),
    skipped: result.data.skipped,
    next,
    rateLimit: result.rateLimit,
  };
}

/**
 * Loads one page of commits. Pass `null` to start; pass the previous page's cursor to continue.
 * Repository names are validated before anything is sent. With a branch, `sha` selects it (the
 * query string is encoded, so any branch name is safe); without one GitHub uses the default
 * branch.
 */
export function loadCommitPage(
  token: string,
  target: CommitTarget,
  cursor: PageCursor | null,
  signal?: AbortSignal,
): Promise<ActivityPage<CommitItem>> {
  const query = new URLSearchParams({ per_page: String(ACTIVITY_PAGE_SIZE) });
  if (target.branch !== null && target.branch !== '') query.set('sha', target.branch);
  return loadActivityPage({
    token,
    target,
    path: 'commits',
    query,
    cursor,
    maxPages: MAX_COMMIT_PAGES,
    parse: (json) => {
      const { commits, skipped } = parseCommitList(json);
      return { entries: commits, skipped };
    },
    toItem: toCommitItem,
    signal,
  });
}

/** Loads one page of branches. Pass `null` to start; pass the previous page's cursor to continue. */
export function loadBranchPage(
  token: string,
  target: RepositoryRef,
  cursor: PageCursor | null,
  signal?: AbortSignal,
): Promise<ActivityPage<BranchItem>> {
  return loadActivityPage({
    token,
    target,
    path: 'branches',
    query: new URLSearchParams({ per_page: String(ACTIVITY_PAGE_SIZE) }),
    cursor,
    maxPages: MAX_BRANCH_PAGES,
    parse: (json) => {
      const { branches, skipped } = parseBranchList(json);
      return { entries: branches, skipped };
    },
    toItem: toBranchItem,
    signal,
  });
}
