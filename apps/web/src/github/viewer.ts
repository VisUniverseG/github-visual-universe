import { githubUserSchema } from '@gvu/shared';
import { githubGet } from './client.ts';

/**
 * `GET /user` (read-only): the signed-in user's login. It is the only reliable way to tell which
 * repositories are personal, because a repository owned by another user (where you collaborate)
 * is not the same as one you own. Only the login is read and kept, in memory.
 */
export async function loadViewerLogin(token: string, signal?: AbortSignal): Promise<string> {
  const result = await githubGet('/user', token, (json) => githubUserSchema.parse(json), signal);
  return result.data.login;
}
