import {
  githubBranchSchema,
  githubDefaultBranchSchema,
  gitShaSchema,
  parseGitTree,
  type GitHubTreeEntry,
} from '@gvu/shared';
import { GitHubApiError, githubGet, type GitHubRateLimit } from './client.ts';

/**
 * Reads a repository's file tree (names, kinds and sizes: never file contents). Read-only GETs:
 *
 *   GET /repos/{owner}/{repo}                      only if the list did not give a default branch
 *   GET /repos/{owner}/{repo}/branches/{branch}    the branch head: commit SHA and tree SHA
 *   GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 *   GET /repos/{owner}/{repo}/git/trees/{sha}      only if the recursive listing was truncated
 *
 * GitHub caps a recursive listing at 100,000 entries / 7 MB and then sets `truncated`. A cut-off
 * listing is never used: it is discarded, and the repository is opened in `lazy` mode from a
 * non-recursive listing of its root, so folders can be listed one at a time by tree SHA.
 */

/** GitHub account and repository names: letters, digits, `.`, `_`, `-`, and never `.` or `..`. */
const SAFE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** The repository a listing belongs to. Both parts end up in a URL path. */
export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export interface TreeTarget extends RepositoryRef {
  /** From the repository list; `null` when GitHub did not send it. */
  readonly defaultBranch: string | null;
}

/** Throws before any request unless both names are well-formed. */
export function assertSafeRepository(repository: RepositoryRef): string {
  if (!SAFE_NAME.test(repository.owner) || !SAFE_NAME.test(repository.name)) {
    throw new GitHubApiError('invalid_response');
  }
  return `/repos/${repository.owner}/${repository.name}`;
}

/** One Git tree listing, from either a recursive or a non-recursive request. */
export interface TreeListing {
  /** The tree SHA that was asked for (and that GitHub confirmed). */
  readonly sha: string;
  readonly recursive: boolean;
  readonly entries: readonly GitHubTreeEntry[];
  /** Entries that could not be read, or that contradicted the request, and were left out. */
  readonly skipped: number;
  /**
   * GitHub cut the listing off (over 100,000 entries or 7 MB), so `entries` is incomplete. For a
   * non-recursive listing this means the one folder is too large to list completely.
   */
  readonly truncated: boolean;
  readonly rateLimit: GitHubRateLimit | null;
}

export interface TreeListingOptions {
  /** `true` lists the whole subtree (`?recursive=1`); `false` lists direct children only. */
  readonly recursive: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Lists one Git tree by its SHA: `GET /repos/{owner}/{repo}/git/trees/{sha}`, with `?recursive=1`
 * only when asked. (Non-recursive requests carry no `recursive` parameter at all, because GitHub
 * treats any value of it, `0` included, as true.)
 *
 * The SHA and repository are validated before anything is sent, so an invalid one makes no
 * request. Only tree SHAs that GitHub itself returned should be passed in; never a submodule's.
 * GitHub's answer must be for the SHA that was asked for.
 */
export async function loadTreeListing(
  token: string,
  repository: RepositoryRef,
  sha: string,
  options: TreeListingOptions,
): Promise<TreeListing> {
  const base = assertSafeRepository(repository);
  // Hex only, so the SHA is safe to put in the path.
  if (!gitShaSchema.safeParse(sha).success) throw new GitHubApiError('invalid_response');

  const { recursive } = options;
  const page = await githubGet(
    `${base}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`,
    token,
    (json) => {
      const tree = parseGitTree(json);
      if (tree.sha !== sha) throw new GitHubApiError('invalid_response');
      return tree;
    },
    options.signal,
  );

  let entries = page.data.entries;
  let skipped = page.data.skipped;
  if (!recursive) {
    // A direct-children listing has no `/` in any path. One that does contradicts itself (and
    // would corrupt the folder hierarchy), so it is left out and counted.
    const direct = entries.filter((entry) => !entry.path.includes('/'));
    skipped += entries.length - direct.length;
    entries = direct;
  }

  return {
    sha,
    recursive,
    entries,
    skipped,
    truncated: page.data.truncated,
    rateLimit: page.rateLimit,
  };
}

interface RepositoryTreeBase {
  readonly branch: string;
  /** The commit the listing is a snapshot of. */
  readonly commitSha: string;
  readonly treeSha: string;
  readonly entries: readonly GitHubTreeEntry[];
  /** Entries GitHub sent that could not be read and were left out. */
  readonly skipped: number;
  /** From the last request made. */
  readonly rateLimit: GitHubRateLimit | null;
}

/** The whole repository came back in one recursive listing. */
export interface CompleteRepositoryTree extends RepositoryTreeBase {
  readonly mode: 'complete';
  readonly truncated: false;
}

/**
 * The repository is too large for one recursive listing. `entries` holds only the root's direct
 * children (the cut-off recursive listing was discarded), so it is not the whole repository:
 * `truncated` is always `true`. Each `tree` entry with a `sha` can be listed with
 * `loadTreeListing`.
 */
export interface LazyRepositoryTree extends RepositoryTreeBase {
  readonly mode: 'lazy';
  readonly truncated: true;
  /** Even the root's own listing was cut off, so some top-level entries are missing. */
  readonly rootTruncated: boolean;
}

export type RepositoryTree = CompleteRepositoryTree | LazyRepositoryTree;

export async function loadRepositoryTree(
  token: string,
  target: TreeTarget,
  signal?: AbortSignal,
): Promise<RepositoryTree> {
  // These end up in a URL path, so only well-formed names are ever interpolated.
  const base = assertSafeRepository(target);

  let branch = target.defaultBranch?.trim() ?? '';
  if (branch === '') {
    const repository = await githubGet(
      base,
      token,
      (json) => githubDefaultBranchSchema.parse(json),
      signal,
    );
    branch = repository.data.default_branch;
  }

  const head = await githubGet(
    `${base}/branches/${encodeURIComponent(branch)}`,
    token,
    (json) => githubBranchSchema.parse(json),
    signal,
  );
  const treeSha = head.data.commit.commit.tree.sha;
  const commitSha = head.data.commit.sha;
  const signalOption = signal ? { signal } : {};

  const everything = await loadTreeListing(token, target, treeSha, {
    recursive: true,
    ...signalOption,
  });
  if (!everything.truncated) {
    return {
      mode: 'complete',
      branch,
      commitSha,
      treeSha,
      entries: everything.entries,
      skipped: everything.skipped,
      truncated: false,
      rateLimit: everything.rateLimit,
    };
  }

  // Too large for one request. Nothing from the cut-off listing is kept: it is not guaranteed to
  // be a clean prefix of the tree. List just the root, and let folders be opened one by one.
  const root = await loadTreeListing(token, target, treeSha, { recursive: false, ...signalOption });
  return {
    mode: 'lazy',
    branch,
    commitSha,
    treeSha,
    entries: root.entries,
    skipped: root.skipped,
    truncated: true,
    rootTruncated: root.truncated,
    rateLimit: root.rateLimit,
  };
}
