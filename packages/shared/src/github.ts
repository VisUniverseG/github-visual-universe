import { z } from 'zod';

// The subset of GitHub REST responses the app reads. Schemas strip unknown fields, so
// nothing beyond what is listed here ever reaches the UI.

export const githubOwnerSchema = z.object({
  login: z.string().min(1),
});

/** A repository the signed-in user can reach through the GitHub App installation. */
export const githubRepositorySchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  description: z.string().nullish(),
  html_url: z.string().min(1),
  owner: githubOwnerSchema,
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
