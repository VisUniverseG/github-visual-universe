import { REPOSITORY_MESSAGES, describeGitHubError } from '../dashboard/messages.ts';
import { GitHubApiError } from '../github/client.ts';
import type { DirectoryFailure } from './loader.ts';

/** Fixed, user-facing strings. Nothing from GitHub's responses is ever echoed into them. */
export const ARCHITECTURE_MESSAGES = {
  forbidden:
    "GitHub refused access to this repository's files. The GitHub App needs read access to Contents and must be installed on this repository.",
  notFound:
    'The default branch could not be found. The repository may be empty, or the GitHub App may not have access to its files.',
  empty: 'This repository is empty: it has no commits yet, so there is no file tree to show.',
  noFiles: 'This branch has no files to show.',
  folderNotLoaded: 'This folder has not been loaded yet.',
  folderNoSha:
    'GitHub did not give a usable identifier for this folder, so its contents cannot be loaded.',
  folderLoading: 'Loading this folder…',
  folderNotFound:
    "GitHub could not find this folder's listing. The GitHub App may not have access to it.",
  folderForbidden:
    "GitHub refused to list this folder. The GitHub App needs read access to the repository's Contents.",
  folderUnusable: "GitHub's answer for this folder could not be used, so it was not loaded.",
  unusableTree: "GitHub's file listing for this repository could not be used.",
  unauthorized: 'Your GitHub session has ended. Please sign in again.',
} as const;

/** What went wrong with one folder. Fixed strings only: nothing from GitHub is echoed. */
export function describeDirectoryFailure(failure: DirectoryFailure): string {
  switch (failure.kind) {
    case 'rate_limited':
      return REPOSITORY_MESSAGES.rateLimited;
    case 'network':
      return REPOSITORY_MESSAGES.network;
    case 'forbidden':
      return ARCHITECTURE_MESSAGES.folderForbidden;
    case 'http':
      if (failure.status === 404) return ARCHITECTURE_MESSAGES.folderNotFound;
      return failure.retryable ? REPOSITORY_MESSAGES.generic : ARCHITECTURE_MESSAGES.folderUnusable;
    default:
      return ARCHITECTURE_MESSAGES.folderUnusable;
  }
}

/** When GitHub's rate limit resets, in the reader's own time. */
export function describeRateLimitReset(resetAt: number): string {
  const time = new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `GitHub's rate limit is used up. Folders can be loaded again after ${time}.`;
}

export function describeTreeError(error: unknown, now: number = Date.now()): string {
  if (error instanceof GitHubApiError) {
    if (error.kind === 'forbidden') return ARCHITECTURE_MESSAGES.forbidden;
    if (error.kind === 'http' && error.status === 404) return ARCHITECTURE_MESSAGES.notFound;
    if (error.kind === 'http' && error.status === 409) return ARCHITECTURE_MESSAGES.empty;
  }
  return describeGitHubError(error, now);
}

export interface Completeness {
  /** GitHub cut the repository's whole listing off, so it is being read folder by folder. */
  readonly truncated: boolean;
  readonly skipped: number;
  readonly inconsistent: number;
  /**
   * Folders nobody has listed yet that can still be loaded by opening them (only meaningful
   * together with `truncated`).
   */
  readonly unloadedDirectories?: number;
  /** Folders nobody has listed that cannot be: GitHub gave no usable SHA to ask for them by. */
  readonly unloadableDirectories?: number;
  /** Folders whose own listing GitHub cut off: asking again cannot bring the rest back. */
  readonly cutOffFolders?: number;
}

/** `null` when the listing is the whole repository; otherwise says, in words, what is missing. */
export function partialTreeMessage({
  truncated,
  skipped,
  inconsistent,
  unloadedDirectories = 0,
  unloadableDirectories = 0,
  cutOffFolders = 0,
}: Completeness): string | null {
  const reasons: string[] = [];
  if (truncated) {
    reasons.push(
      'GitHub cut this listing off because the repository is very large (over 100,000 entries or 7 MB), so some files and folders are missing.',
    );
    if (unloadedDirectories > 0) {
      reasons.push(
        `Folders are loaded one at a time when you open them: ${String(unloadedDirectories)} ${unloadedDirectories === 1 ? 'has' : 'have'} not been loaded yet.`,
      );
    }
  }
  if (unloadableDirectories > 0) {
    reasons.push(
      `${String(unloadableDirectories)} ${unloadableDirectories === 1 ? 'folder' : 'folders'} cannot be loaded at all, because GitHub did not give a usable identifier for ${unloadableDirectories === 1 ? 'it' : 'them'}. Opening ${unloadableDirectories === 1 ? 'it' : 'them'} will not change that.`,
    );
  }
  if (cutOffFolders > 0) {
    reasons.push(
      `GitHub cut off the listing of ${String(cutOffFolders)} ${cutOffFolders === 1 ? 'folder' : 'folders'} because ${cutOffFolders === 1 ? 'it is' : 'they are'} too large. The missing entries cannot be loaded, and asking again will not bring them back.`,
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
