import { REPOSITORY_MESSAGES, describeGitHubError } from '../dashboard/messages.ts';
import { GitHubApiError } from '../github/client.ts';
import { MAX_BRANCH_PAGES, MAX_COMMIT_PAGES, ACTIVITY_PAGE_SIZE } from '../github/activity.ts';
import type { PageNext } from '../github/activity.ts';
import { formatCount } from '../dashboard/format.ts';
import { MAX_GRAPH_LANES, type HistoryGraph } from './historyGraph.ts';

/** Fixed, user-facing strings. Nothing from GitHub's responses is ever echoed into them. */
export const ACTIVITY_MESSAGES = {
  commitsEmpty: 'This repository is empty: it has no commits yet.',
  noCommits: 'GitHub listed no commits for this branch.',
  noBranches: 'GitHub listed no branches for this repository.',
  commitsForbidden:
    "GitHub refused access to this repository's commits. The GitHub App needs read access to Contents and must be installed on this repository.",
  branchesForbidden:
    "GitHub refused access to this repository's branches. The GitHub App needs read access to Contents and must be installed on this repository.",
  commitsNotFound:
    'The commit history could not be found. The branch may no longer exist, or the GitHub App may not have access to this repository.',
  branchesNotFound:
    'The branch list could not be found. The GitHub App may not have access to this repository.',
  unusable: "GitHub's answer could not be used, so nothing was loaded from it.",
  unauthorized: 'Your GitHub session has ended. Please sign in again.',
  noUsableDates: 'None of the loaded commits has a usable date, so there is no timeline to draw.',
} as const;

export type ActivityScope = 'commits' | 'branches';

export type ActivityFailureKind =
  'empty' | 'forbidden' | 'not_found' | 'rate_limited' | 'network' | 'server' | 'unusable';

/** What went wrong with one list, in words that are safe to show, and what may be done about it. */
export interface ActivityFailure {
  readonly kind: ActivityFailureKind;
  readonly text: string;
  /** `true` only when asking again could help. */
  readonly retryable: boolean;
  /** When a rate limit ends, in epoch milliseconds, if GitHub said. */
  readonly resetAt: number | null;
}

export function describeActivityFailure(
  error: unknown,
  scope: ActivityScope,
  now: number = Date.now(),
): ActivityFailure {
  const unusable: ActivityFailure = {
    kind: 'unusable',
    text: ACTIVITY_MESSAGES.unusable,
    retryable: false,
    resetAt: null,
  };
  if (!(error instanceof GitHubApiError)) return unusable;

  switch (error.kind) {
    case 'rate_limited':
      return {
        kind: 'rate_limited',
        text: describeGitHubError(error, now),
        retryable: true,
        resetAt: error.resetAt ?? null,
      };
    case 'forbidden':
      return {
        kind: 'forbidden',
        text:
          scope === 'commits'
            ? ACTIVITY_MESSAGES.commitsForbidden
            : ACTIVITY_MESSAGES.branchesForbidden,
        retryable: false,
        resetAt: null,
      };
    case 'network':
      return { kind: 'network', text: REPOSITORY_MESSAGES.network, retryable: true, resetAt: null };
    case 'http': {
      const status = error.status;
      if (status === 404) {
        return {
          kind: 'not_found',
          text:
            scope === 'commits'
              ? ACTIVITY_MESSAGES.commitsNotFound
              : ACTIVITY_MESSAGES.branchesNotFound,
          retryable: false,
          resetAt: null,
        };
      }
      // GitHub answers 409 to a commit list when the repository has no commits.
      if (status === 409 && scope === 'commits') {
        return {
          kind: 'empty',
          text: ACTIVITY_MESSAGES.commitsEmpty,
          retryable: false,
          resetAt: null,
        };
      }
      if (status === 408 || (status !== undefined && status >= 500)) {
        return {
          kind: 'server',
          text: REPOSITORY_MESSAGES.generic,
          retryable: true,
          resetAt: null,
        };
      }
      return unusable;
    }
    default:
      return unusable;
  }
}

export const describeCommitFailure = (error: unknown, now?: number): ActivityFailure =>
  describeActivityFailure(error, 'commits', now);

export const describeBranchFailure = (error: unknown, now?: number): ActivityFailure =>
  describeActivityFailure(error, 'branches', now);

/** Shown while a rate limit blocks loading; the time is the reader's own. */
export function describeBlockedUntil(resetAt: number): string {
  const time = new Date(resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `GitHub's rate limit is used up. More can be loaded again after ${time}.`;
}

export function unreadableMessage(count: number, noun: 'commit' | 'branch'): string {
  const plural = noun === 'commit' ? 'commits' : 'branches';
  return `${formatCount(count)} ${count === 1 ? noun : plural} in GitHub's response could not be read and ${count === 1 ? 'was' : 'were'} left out.`;
}

export function undatedMessage(count: number): string {
  return `${formatCount(count)} loaded ${count === 1 ? 'commit has' : 'commits have'} no usable date (it is missing, unreadable, older than Git itself or in the future) and ${count === 1 ? 'is' : 'are'} not on the timeline.`;
}

/** Why a list is not known to be everything GitHub has, or `null` when nothing is missing. */
export function partialListMessage(args: {
  readonly noun: 'commits' | 'branches';
  readonly next: PageNext | null;
  readonly skipped: number;
}): string | null {
  const { noun, next, skipped } = args;
  const maxItems = formatCount(
    ACTIVITY_PAGE_SIZE * (noun === 'commits' ? MAX_COMMIT_PAGES : MAX_BRANCH_PAGES),
  );
  const reasons: string[] = [];
  if (next?.kind === 'more') {
    reasons.push(
      noun === 'commits'
        ? 'Older commits have not been loaded.'
        : 'More branches have not been loaded.',
    );
  }
  if (next?.kind === 'capped') {
    reasons.push(
      `Loading stops at ${maxItems} ${noun}, and GitHub has more. The rest cannot be loaded here.`,
    );
  }
  if (skipped > 0) {
    reasons.push(
      `${unreadableMessage(skipped, noun === 'commits' ? 'commit' : 'branch')} The list is incomplete.`,
    );
  }
  return reasons.length === 0 ? null : reasons.join(' ');
}

function counted(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}

/** The accessible name of the history graph: what it is, in a few facts. */
export function historyGraphLabel(graph: HistoryGraph): string {
  const commits = counted(graph.nodes.length, 'loaded commit', 'loaded commits');
  const lanes = counted(graph.laneCount, 'lane', 'lanes');
  const merges =
    graph.merges === 0 ? '' : `, with ${counted(graph.merges, 'merge commit', 'merge commits')}`;
  return `History graph of ${commits} on the default branch, newest first, drawn in ${lanes}${merges}. The Parents column of the table below lists the same links as text.`;
}

/**
 * What the drawing cannot show, in words. Each line is a distinct state of the data; nothing here
 * quotes GitHub. A graph with nothing unusual has no notes.
 */
export function historyGraphNotes(graph: HistoryGraph, next: PageNext | null): string[] {
  const notes: string[] = [];

  if (graph.openLinks > 0) {
    const lines = counted(graph.openLinks, 'dashed line leads', 'dashed lines lead');
    if (next?.kind === 'more') {
      notes.push(
        `${lines} to parent commits that are not loaded yet. They join up as older commits are loaded.`,
      );
    } else if (next?.kind === 'capped') {
      notes.push(
        `${lines} to parent commits beyond the loading limit, which cannot be loaded here.`,
      );
    } else {
      notes.push(`${lines} to parent commits that are not among the loaded commits.`);
    }
  }
  if (graph.droppedLinks > 0 || graph.overflowCommits > 0) {
    const parts: string[] = [];
    if (graph.droppedLinks > 0) {
      parts.push(
        `${counted(graph.droppedLinks, 'link is', 'links are')} not drawn because more than ${String(MAX_GRAPH_LANES)} lanes were needed`,
      );
    }
    if (graph.overflowCommits > 0) {
      parts.push(
        `${counted(graph.overflowCommits, 'commit is', 'commits are')} in the extra column on the right because no lane was free`,
      );
    }
    notes.push(`${parts.join(', and ')}. The Parents column still lists every link.`);
  }
  if (graph.unknownParents > 0) {
    notes.push(
      `GitHub did not say what the parents of ${counted(graph.unknownParents, 'commit', 'commits')} ${graph.unknownParents === 1 ? 'is' : 'are'}, so no line leaves ${graph.unknownParents === 1 ? 'it' : 'them'}.`,
    );
  }
  if (graph.invalidParentLinks > 0) {
    notes.push(
      `${counted(graph.invalidParentLinks, 'parent entry', 'parent entries')} could not be read and ${graph.invalidParentLinks === 1 ? 'has' : 'have'} no line.`,
    );
  }
  if (graph.outOfOrderLinks > 0) {
    notes.push(
      `${counted(graph.outOfOrderLinks, 'link leads', 'links lead')} to a commit listed above its child (commit dates can be out of order), so ${graph.outOfOrderLinks === 1 ? 'it is' : 'they are'} not drawn. The commit is marked with an up arrow.`,
    );
  }
  if (graph.duplicates > 0) {
    notes.push(
      `${counted(graph.duplicates, 'commit is', 'commits are')} listed twice. The second copy is drawn without lines.`,
    );
  }
  return notes;
}
