import { describeGitHubError } from '../dashboard/messages.ts';
import { GitHubApiError } from '../github/client.ts';

/** Fixed, user-facing strings. Nothing from GitHub's responses is ever echoed into them. */
export const ARCHITECTURE_MESSAGES = {
  forbidden:
    "GitHub refused access to this repository's files. The GitHub App needs read access to Contents and must be installed on this repository.",
  notFound:
    'The default branch could not be found. The repository may be empty, or the GitHub App may not have access to its files.',
  empty: 'This repository is empty: it has no commits yet, so there is no file tree to show.',
  noFiles: 'This branch has no files to show.',
} as const;

export function describeTreeError(error: unknown, now: number = Date.now()): string {
  if (error instanceof GitHubApiError) {
    if (error.kind === 'forbidden') return ARCHITECTURE_MESSAGES.forbidden;
    if (error.kind === 'http' && error.status === 404) return ARCHITECTURE_MESSAGES.notFound;
    if (error.kind === 'http' && error.status === 409) return ARCHITECTURE_MESSAGES.empty;
  }
  return describeGitHubError(error, now);
}

export interface Completeness {
  readonly truncated: boolean;
  readonly skipped: number;
  readonly inconsistent: number;
}

/** `null` when the listing is the whole repository; otherwise says, in words, what is missing. */
export function partialTreeMessage({
  truncated,
  skipped,
  inconsistent,
}: Completeness): string | null {
  const reasons: string[] = [];
  if (truncated) {
    reasons.push(
      'GitHub cut this listing off because the repository is very large (over 100,000 entries or 7 MB), so some files and folders are missing.',
    );
  }
  const unreadable = skipped + inconsistent;
  if (unreadable > 0) {
    reasons.push(
      `${String(unreadable)} ${unreadable === 1 ? 'entry' : 'entries'} in GitHub's response could not be read and ${unreadable === 1 ? 'was' : 'were'} left out.`,
    );
  }
  if (reasons.length === 0) return null;
  return `${reasons.join(' ')} Counts and sizes below are lower bounds, not totals.`;
}
