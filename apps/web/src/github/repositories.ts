import {
  githubInstallationsResponseSchema,
  parseInstallationRepositories,
  type GitHubInstallationsResponse,
  type GitHubRepository,
} from '@gvu/shared';
import { githubGet, type GitHubPage } from './client.ts';

/**
 * Repository discovery through the GitHub App installation endpoints:
 *   GET /user/installations
 *   GET /user/installations/{installation_id}/repositories
 * GitHub returns only repositories that both the signed-in user can access and the App has been
 * granted, so nothing the user cannot see is ever listed. Read-only.
 */

const PAGE_SIZE = 100;
const MAX_INSTALLATION_PAGES = 10;
/** Guards against an endless loop of empty pages. */
const MAX_EMPTY_HOPS = 50;

export type Visibility = 'public' | 'private' | 'internal';

/**
 * A repository as the UI sees it. Only the first group is guaranteed; every other field is
 * `null` (or empty) when GitHub did not send a usable value, and the UI shows nothing for it.
 */
export interface RepositoryItem {
  readonly id: number;
  readonly name: string;
  readonly fullName: string;
  readonly owner: string;
  readonly isPrivate: boolean;
  readonly description: string | null;
  /** A validated https://github.com link, or `null` if GitHub sent anything else. */
  readonly url: string | null;

  /** `"User"`, `"Organization"` or whatever GitHub sent; `null` if absent. */
  readonly ownerType: string | null;
  readonly visibility: Visibility;
  /** GitHub's primary language; `null` when none was detected or reported. */
  readonly language: string | null;
  readonly stars: number | null;
  readonly forks: number | null;
  /** GitHub counts open pull requests in this number. */
  readonly openIssues: number | null;
  /** ISO timestamps, validated; `null` if absent or unparseable. */
  readonly updatedAt: string | null;
  readonly pushedAt: string | null;
  readonly isFork: boolean | null;
  readonly isArchived: boolean | null;
  readonly defaultBranch: string | null;
  readonly topics: readonly string[];
}

/** Opaque position in the list: which installations remain and where the current one stands. */
export interface RepositoryCursor {
  readonly remainingInstallations: readonly number[];
  readonly nextUrl: string | null;
}

export interface RepositoryPage {
  readonly items: readonly RepositoryItem[];
  /** Entries in GitHub's response that could not be read and were left out. */
  readonly skipped: number;
  /** `null` when there is nothing more to load. */
  readonly cursor: RepositoryCursor | null;
}

export function safeGitHubHtmlUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function validIsoDate(value: string | null | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function toVisibility(repo: GitHubRepository): Visibility {
  if (repo.visibility === 'internal') return 'internal';
  // `private` is required and authoritative; `visibility` only adds the "internal" case.
  return repo.private ? 'private' : 'public';
}

export function toRepositoryItem(repo: GitHubRepository): RepositoryItem {
  return {
    id: repo.id,
    name: repo.name,
    fullName: repo.full_name,
    owner: repo.owner.login,
    isPrivate: repo.private,
    description: repo.description ?? null,
    url: safeGitHubHtmlUrl(repo.html_url),
    ownerType: repo.owner.type ?? null,
    visibility: toVisibility(repo),
    language: repo.language?.trim() ? repo.language : null,
    stars: repo.stargazers_count ?? null,
    forks: repo.forks_count ?? null,
    openIssues: repo.open_issues_count ?? null,
    updatedAt: validIsoDate(repo.updated_at),
    pushedAt: validIsoDate(repo.pushed_at),
    isFork: repo.fork ?? null,
    isArchived: repo.archived ?? null,
    defaultBranch: repo.default_branch ?? null,
    topics: repo.topics ?? [],
  };
}

async function listInstallationIds(token: string, signal?: AbortSignal): Promise<number[]> {
  const ids: number[] = [];
  let next: string | null = `/user/installations?per_page=${String(PAGE_SIZE)}`;
  for (let page = 0; next !== null && page < MAX_INSTALLATION_PAGES; page += 1) {
    const result: GitHubPage<GitHubInstallationsResponse> = await githubGet(
      next,
      token,
      (json) => githubInstallationsResponseSchema.parse(json),
      signal,
    );
    ids.push(...result.data.installations.map((installation) => installation.id));
    next = result.nextUrl;
  }
  return ids;
}

/**
 * Loads one page of repositories. Pass `null` to start; pass the previous page's `cursor` to
 * continue. Skips installations that contribute nothing so a page is never empty unless the
 * list is.
 */
export async function loadRepositoryPage(
  token: string,
  cursor: RepositoryCursor | null,
  signal?: AbortSignal,
): Promise<RepositoryPage> {
  let position: RepositoryCursor = cursor ?? {
    remainingInstallations: await listInstallationIds(token, signal),
    nextUrl: null,
  };

  let skipped = 0;
  for (let hop = 0; hop < MAX_EMPTY_HOPS; hop += 1) {
    const [current, ...rest] = position.remainingInstallations;
    if (current === undefined) return { items: [], skipped, cursor: null };

    const result: GitHubPage<ReturnType<typeof parseInstallationRepositories>> = await githubGet(
      position.nextUrl ??
        `/user/installations/${String(current)}/repositories?per_page=${String(PAGE_SIZE)}`,
      token,
      (json) => parseInstallationRepositories(json),
      signal,
    );

    position = result.nextUrl
      ? { remainingInstallations: position.remainingInstallations, nextUrl: result.nextUrl }
      : { remainingInstallations: rest, nextUrl: null };

    const items = result.data.repositories.map(toRepositoryItem);
    const finished = position.nextUrl === null && position.remainingInstallations.length === 0;
    skipped += result.data.skipped;
    if (items.length > 0 || skipped > 0 || finished) {
      return { items, skipped, cursor: finished ? null : position };
    }
  }
  // The hop limit was reached with installations still unread. Hand back the current position
  // (never `null`, which would mean "finished") so the caller can show partial progress and resume.
  return { items: [], skipped, cursor: position };
}
