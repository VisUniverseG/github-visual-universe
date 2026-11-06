import { parseIssueList, type GitHubIssue } from '@gvu/shared';
import { displayText } from '../architecture/names.ts';
import { loadActivityPage, type ActivityPage, type PageCursor } from './activity.ts';
import type { RepositoryRef } from './tree.ts';

/**
 * Issues of one repository (read-only):
 *
 *   GET /repos/{owner}/{repo}/issues?state=all&sort=updated&direction=desc&per_page=100
 *
 * Read exactly like the commit, pull request and branch lists: the first page when the panel is
 * opened, every later page only when asked, by following GitHub's `Link: rel="next"` URL, at most
 * {@link MAX_ISSUE_PAGES} pages. Nothing is requested per issue.
 *
 * GitHub lists pull requests in this answer too. They are told apart from issues in the shared
 * parser, from the raw entry, and are only counted (see `ActivityPage.omitted`): the cap of pages
 * therefore limits the entries examined, not the issues found.
 *
 * Only what the panel shows is kept. The description and the comments are never read. Everything
 * that comes from the repository (the title, the label names, the author's login) is untrusted: it
 * goes through `displayText` and is only ever shown as text, never put in a URL.
 */

export const ISSUE_PAGE_SIZE = 100;
export const MAX_ISSUE_PAGES = 5;
/** Label names kept per issue; the rest is only counted. */
export const MAX_LABELS_SHOWN = 5;

export type IssueState = 'open' | 'closed';
export type IssueStateReason = 'completed' | 'reopened' | 'not_planned' | 'duplicate';

export interface IssueItem {
  readonly number: number;
  /** Display-safe. Empty when GitHub sent none. */
  readonly title: string;
  readonly state: IssueState;
  /** GitHub's reason for the state, `null` when it gave none (or one this app does not know). */
  readonly stateReason: IssueStateReason | null;
  /** Display-safe label names (at most {@link MAX_LABELS_SHOWN}), or `null` when GitHub gave none. */
  readonly labels: readonly string[] | null;
  /** Labels beyond the ones kept. */
  readonly labelsNotShown: number;
  /** Display-safe, or `null` when GitHub gave no author (a deleted account). */
  readonly authorLogin: string | null;
  /** Comments on the issue, `null` when GitHub did not say. Their text is never read. */
  readonly comments: number | null;
  /** The dates as the ISO text GitHub sent; `null` if missing or unusable. */
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly closedAt: string | null;
}

function validIsoDate(value: string | null | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? displayText(trimmed) : null;
}

/** The names of the labels GitHub sent (as strings or as objects), in order, with no blanks. */
function labelNames(labels: GitHubIssue['labels']): string[] | null {
  if (labels === null || labels === undefined) return null;
  const names: string[] = [];
  for (const label of labels) {
    const name = safeText(typeof label === 'string' ? label : label?.name);
    if (name !== null) names.push(name);
  }
  return names;
}

export function toIssueItem(issue: GitHubIssue): IssueItem {
  const names = labelNames(issue.labels);
  return {
    number: issue.number,
    title: displayText((issue.title ?? '').trim()),
    state: issue.state,
    stateReason: issue.state_reason ?? null,
    labels: names === null ? null : names.slice(0, MAX_LABELS_SHOWN),
    labelsNotShown: names === null ? 0 : Math.max(names.length - MAX_LABELS_SHOWN, 0),
    authorLogin: safeText(issue.user?.login),
    comments: issue.comments ?? null,
    createdAt: validIsoDate(issue.created_at),
    updatedAt: validIsoDate(issue.updated_at),
    closedAt: validIsoDate(issue.closed_at),
  };
}

/**
 * Loads one page of issues. Pass `null` to start; pass the previous page's cursor to continue.
 * Repository names are validated before anything is sent.
 */
export function loadIssuePage(
  token: string,
  target: RepositoryRef,
  cursor: PageCursor | null,
  signal?: AbortSignal,
): Promise<ActivityPage<IssueItem>> {
  return loadActivityPage({
    token,
    target,
    path: 'issues',
    query: new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(ISSUE_PAGE_SIZE),
    }),
    cursor,
    maxPages: MAX_ISSUE_PAGES,
    parse: (json) => {
      const { issues, omittedPullRequests, skipped } = parseIssueList(json);
      return { entries: issues, skipped, omitted: omittedPullRequests };
    },
    toItem: toIssueItem,
    signal,
  });
}
