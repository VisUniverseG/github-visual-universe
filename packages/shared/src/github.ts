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
