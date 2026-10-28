import { z } from 'zod';

// The subset of GitHub REST responses the app reads. Schemas strip unknown fields, so
// nothing beyond what is listed here ever reaches the UI.

/**
 * Wraps an optional field so that a missing, null or malformed value becomes `undefined`
 * instead of failing the whole response. Used for everything the dashboard shows but does not
 * strictly need: absent data is shown as absent, never guessed.
 */
const lenient = <T extends z.ZodType>(schema: T) => schema.nullish().catch(undefined);

export const githubOwnerSchema = z.object({
  login: z.string().min(1),
  /** `"User"` or `"Organization"`. */
  type: lenient(z.string()),
});

/** The signed-in user, from `GET /user`. Only the login is read. */
export const githubUserSchema = z.object({
  login: z.string().min(1),
});
export type GitHubUser = z.infer<typeof githubUserSchema>;

/**
 * A repository the signed-in user can reach through the GitHub App installation.
 * The first six fields are required; everything after them is optional.
 */
export const githubRepositorySchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  description: z.string().nullish(),
  html_url: z.string().min(1),
  owner: githubOwnerSchema,

  /** Primary language as detected by GitHub; `null` when GitHub detects none. */
  language: lenient(z.string()),
  stargazers_count: lenient(z.number().int().nonnegative()),
  forks_count: lenient(z.number().int().nonnegative()),
  /** Includes open pull requests, as GitHub counts them. */
  open_issues_count: lenient(z.number().int().nonnegative()),
  updated_at: lenient(z.string()),
  pushed_at: lenient(z.string()),
  visibility: lenient(z.string()),
  fork: lenient(z.boolean()),
  archived: lenient(z.boolean()),
  default_branch: lenient(z.string()),
  topics: lenient(z.array(z.string())),
});
export type GitHubRepository = z.infer<typeof githubRepositorySchema>;

/** One installation of our GitHub App on a user or organization account. */
export const githubInstallationSchema = z.object({
  id: z.number().int(),
  account: z
    .object({
      login: z.string().min(1),
      type: z.string().optional(),
    })
    .nullish(),
});
export type GitHubInstallation = z.infer<typeof githubInstallationSchema>;

/** `GET /user/installations` */
export const githubInstallationsResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
  installations: z.array(githubInstallationSchema),
});
export type GitHubInstallationsResponse = z.infer<typeof githubInstallationsResponseSchema>;

/** `GET /user/installations/{installation_id}/repositories` */
export const githubInstallationRepositoriesResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(githubRepositorySchema),
});
export type GitHubInstallationRepositoriesResponse = z.infer<
  typeof githubInstallationRepositoriesResponseSchema
>;

/**
 * Parses a repositories response one repository at a time, so a single unreadable entry does not
 * discard the rest. `skipped` counts entries that could not be read; callers must surface it.
 * Throws if the envelope itself is not a repositories response.
 */
const repositoriesEnvelopeSchema = z.object({
  total_count: z.number().int().nonnegative(),
  repositories: z.array(z.unknown()),
});

export function parseInstallationRepositories(json: unknown): {
  readonly repositories: GitHubRepository[];
  readonly skipped: number;
} {
  const envelope = repositoriesEnvelopeSchema.parse(json);
  const repositories: GitHubRepository[] = [];
  let skipped = 0;
  for (const entry of envelope.repositories) {
    const parsed = githubRepositorySchema.safeParse(entry);
    if (parsed.success) repositories.push(parsed.data);
    else skipped += 1;
  }
  return { repositories, skipped };
}

// ---------------------------------------------------------------------------------------------
// Repository architecture (Phase 5): default branch, branch head and Git tree.
// ---------------------------------------------------------------------------------------------

/** A Git object id: 40 hex characters (SHA-1) or 64 (SHA-256 repositories). */
export const gitShaSchema = z.string().regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/);

/** `GET /repos/{owner}/{repo}`: only the default branch is read. */
export const githubDefaultBranchSchema = z.object({
  default_branch: z.string().min(1),
});
export type GitHubDefaultBranch = z.infer<typeof githubDefaultBranchSchema>;

/** `GET /repos/{owner}/{repo}/branches/{branch}`: the head commit and its tree. */
export const githubBranchSchema = z.object({
  commit: z.object({
    sha: gitShaSchema,
    commit: z.object({
      tree: z.object({ sha: gitShaSchema }),
    }),
  }),
});
export type GitHubBranch = z.infer<typeof githubBranchSchema>;

/**
 * One entry of a Git tree. `blob` is a file (or a symlink, mode `120000`), `tree` a directory and
 * `commit` a submodule. Only blobs carry a `size`.
 *
 * `sha` is the object id. For a `tree` entry it is what a later request uses to list that folder,
 * so it is only kept when it is a well-formed Git SHA: anything else is absent (`undefined`, or
 * `null` if GitHub sent `null`: callers must treat both as "no SHA"), and a folder without a usable
 * `sha` can never be loaded. (For a `commit` entry it names a commit in
 * another repository and must never be requested.)
 */
export const githubTreeEntrySchema = z.object({
  path: z.string().min(1).max(4096),
  mode: lenient(z.string()),
  type: z.enum(['blob', 'tree', 'commit']),
  sha: lenient(gitShaSchema),
  size: lenient(z.number().int().nonnegative()),
});
export type GitHubTreeEntry = z.infer<typeof githubTreeEntrySchema>;

const gitTreeEnvelopeSchema = z.object({
  sha: gitShaSchema,
  // Required on purpose: without it we could not tell a complete tree from a cut-off one.
  truncated: z.boolean(),
  tree: z.array(z.unknown()),
});

export interface ParsedGitTree {
  readonly sha: string;
  /** GitHub cut the listing off (more than 100,000 entries or 7 MB): the entries are incomplete. */
  readonly truncated: boolean;
  readonly entries: GitHubTreeEntry[];
  /** Entries that could not be read (unknown type, bad path…) and were left out. */
  readonly skipped: number;
}

/**
 * Parses `GET /repos/{owner}/{repo}/git/trees/{sha}` one entry at a time, so a single unreadable
 * entry does not discard the rest. Callers must surface `skipped` and `truncated`: either one means
 * the listing is not the whole repository. Throws if the envelope itself is not a Git tree.
 */
export function parseGitTree(json: unknown): ParsedGitTree {
  const envelope = gitTreeEnvelopeSchema.parse(json);
  const entries: GitHubTreeEntry[] = [];
  let skipped = 0;
  for (const raw of envelope.tree) {
    const parsed = githubTreeEntrySchema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else skipped += 1;
  }
  return { sha: envelope.sha, truncated: envelope.truncated, entries, skipped };
}
