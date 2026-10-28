import {
  githubBranchSchema,
  githubDefaultBranchSchema,
  parseGitTree,
  type GitHubTreeEntry,
} from '@gvu/shared';
import { GitHubApiError, githubGet } from './client.ts';

/**
 * Reads a repository's file tree (names, kinds and sizes: never file contents). Read-only GETs:
 *
 *   GET /repos/{owner}/{repo}                      only if the list did not give a default branch
 *   GET /repos/{owner}/{repo}/branches/{branch}    the branch head: commit SHA and tree SHA
 *   GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 *
 * GitHub caps a recursive listing at 100,000 entries / 7 MB and then sets `truncated`. This module
 * reports that honestly; it never presents a cut-off listing as the whole repository.
 */

/** GitHub account and repository names: letters, digits, `.`, `_`, `-`, and never `.` or `..`. */
const SAFE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export interface TreeTarget {
  readonly owner: string;
  readonly name: string;
  /** From the repository list; `null` when GitHub did not send it. */
  readonly defaultBranch: string | null;
}

export interface RepositoryTree {
  readonly branch: string;
  /** The commit the listing is a snapshot of. */
  readonly commitSha: string;
  readonly treeSha: string;
  readonly entries: readonly GitHubTreeEntry[];
  /** Entries GitHub sent that could not be read and were left out. */
  readonly skipped: number;
  /** GitHub cut the listing off, so `entries` is incomplete. */
  readonly truncated: boolean;
}

export async function loadRepositoryTree(
  token: string,
  target: TreeTarget,
  signal?: AbortSignal,
): Promise<RepositoryTree> {
  // These end up in a URL path, so only well-formed names are ever interpolated.
  if (!SAFE_NAME.test(target.owner) || !SAFE_NAME.test(target.name)) {
    throw new GitHubApiError('invalid_response');
  }
  const base = `/repos/${target.owner}/${target.name}`;

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

  // `treeSha` was validated as hex by the schema, so it is safe in the path.
  const tree = await githubGet(
    `${base}/git/trees/${treeSha}?recursive=1`,
    token,
    (json) => parseGitTree(json),
    signal,
  );

  return {
    branch,
    commitSha: head.data.commit.sha,
    treeSha,
    entries: tree.data.entries,
    skipped: tree.data.skipped,
    truncated: tree.data.truncated,
  };
}
