import { GitHubApiError } from '../github/client.ts';

/** Fixed, user-facing strings. Nothing from GitHub's responses is ever echoed into them. */
export const REPOSITORY_MESSAGES = {
  empty:
    'No repositories found. This app only lists repositories that you can access and that the GitHub App has been installed on. Install it on your account or organization (GitHub → Settings → Applications → Installed GitHub Apps) and grant it access to the repositories you want to explore.',
  noResults: 'No repositories match your search and filters.',
  rateLimited: 'GitHub rate limit reached. Please wait a bit and try again.',
  forbidden: 'GitHub refused this request. The App may not have the required access.',
  network: 'Could not reach GitHub. Check your connection and try again.',
  generic: 'GitHub returned an unexpected response. Please try again.',
  viewerFailed:
    'Could not determine your GitHub username, so personal repositories cannot be counted or filtered. Organization and visibility figures are unaffected.',
} as const;

export function describeGitHubError(error: unknown, now: number = Date.now()): string {
  if (error instanceof GitHubApiError) {
    if (error.kind === 'rate_limited') {
      if (error.resetAt !== undefined && error.resetAt > now) {
        const minutes = Math.max(1, Math.ceil((error.resetAt - now) / 60_000));
        return `${REPOSITORY_MESSAGES.rateLimited} It resets in about ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`;
      }
      return REPOSITORY_MESSAGES.rateLimited;
    }
    if (error.kind === 'forbidden') return REPOSITORY_MESSAGES.forbidden;
    if (error.kind === 'network') return REPOSITORY_MESSAGES.network;
  }
  return REPOSITORY_MESSAGES.generic;
}

export function skippedMessage(skipped: number): string {
  return `${String(skipped)} ${skipped === 1 ? 'repository' : 'repositories'} in GitHub's response could not be read and ${skipped === 1 ? 'was' : 'were'} left out, so the totals are incomplete.`;
}
