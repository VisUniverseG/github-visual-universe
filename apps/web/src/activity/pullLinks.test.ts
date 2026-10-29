import { describe, expect, it } from 'vitest';
import type { CommitItem, PageNext } from '../github/activity.ts';
import type { PullItem } from '../github/pulls.ts';
import { buildCommitIndex, linkMergeCommit, type CommitIndex } from './pullLinks.ts';

const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20);
const END: PageNext = { kind: 'end' };
const MORE: PageNext = {
  kind: 'more',
  cursor: { nextUrl: 'https://api.github.com/x?page=2', page: 2 },
};
const CAPPED: PageNext = { kind: 'capped' };

function commit(n: number, parents: readonly number[] | null): CommitItem {
  return {
    sha: sha(n),
    subject: `Commit ${String(n)}`,
    authorName: null,
    authorLogin: null,
    date: null,
    parentCount: parents === null ? null : parents.length,
    parentShas: parents === null ? null : parents.map(sha),
  };
}

function pull(over: Partial<PullItem> = {}): PullItem {
  return {
    number: 1,
    title: 'A change',
    state: 'merged',
    draftUnknown: false,
    headBranch: 'feat/a',
    baseBranch: 'main',
    authorLogin: 'ada',
    createdAt: null,
    updatedAt: null,
    closedAt: null,
    mergedAt: '2026-10-03T10:00:00Z',
    mergeCommitSha: sha(1),
    ...over,
  };
}

/**
 * The three ways a pull request can be merged, as the commit list shows them. In every case
 * GitHub's `merge_commit_sha` names the commit on the base branch.
 *
 *   merge:  commit 1 has two parents (the base's tip and the PR's last commit)
 *   squash: commit 2 is a single new commit on the base
 *   rebase: commit 3 is the last of the PR's commits, replayed onto the base
 */
const HISTORY = [
  commit(1, [2, 5]), // merge commit of PR A
  commit(2, [3]), // squashed commit of PR B
  commit(3, [4]), // last rebased commit of PR C
  commit(4, []),
  commit(5, [4]),
];

const ready = (next: PageNext = END): CommitIndex => buildCommitIndex(HISTORY, 'ready', next);

describe('buildCommitIndex', () => {
  it('indexes the loaded commits by full SHA, keeping the first of a repeated one', () => {
    const first = commit(1, [2]);
    const again = { ...commit(1, []), subject: 'the second copy' };
    const index = buildCommitIndex([first, again], 'ready', END);
    expect(index.bySha.size).toBe(1);
    expect(index.bySha.get(sha(1))).toBe(first);
  });
});

describe('linkMergeCommit: a merged pull request whose commit is loaded', () => {
  it('links a merge-commit merge, and says the commit has two parents', () => {
    expect(linkMergeCommit(pull({ mergeCommitSha: sha(1) }), ready())).toEqual({
      kind: 'linked',
      sha: sha(1),
      isMergeCommit: true,
    });
  });

  it('links a squash merge to its single commit', () => {
    expect(linkMergeCommit(pull({ mergeCommitSha: sha(2) }), ready())).toEqual({
      kind: 'linked',
      sha: sha(2),
      isMergeCommit: false,
    });
  });

  it('links a rebase merge to the last rebased commit', () => {
    expect(linkMergeCommit(pull({ mergeCommitSha: sha(3) }), ready())).toEqual({
      kind: 'linked',
      sha: sha(3),
      isMergeCommit: false,
    });
  });

  it('does not claim a commit is or is not a merge when its parents are not stated', () => {
    const index = buildCommitIndex([commit(1, null)], 'ready', END);
    expect(linkMergeCommit(pull(), index)).toEqual({
      kind: 'linked',
      sha: sha(1),
      isMergeCommit: null,
    });
  });

  it('still links while more commits can be loaded', () => {
    expect(linkMergeCommit(pull({ mergeCommitSha: sha(2) }), ready(MORE)).kind).toBe('linked');
  });
});

describe('linkMergeCommit: no guessing', () => {
  it('does not link a merge commit that is not loaded, and says why', () => {
    const missing = pull({ mergeCommitSha: sha(99) });
    expect(linkMergeCommit(missing, ready(END))).toEqual({
      kind: 'not_loaded',
      sha: sha(99),
      reason: 'end',
    });
    expect(linkMergeCommit(missing, ready(MORE))).toMatchObject({ reason: 'more' });
    expect(linkMergeCommit(missing, ready(CAPPED))).toMatchObject({ reason: 'capped' });
    expect(linkMergeCommit(missing, buildCommitIndex([], 'loading', null))).toMatchObject({
      reason: 'loading',
    });
    expect(linkMergeCommit(missing, buildCommitIndex([], 'failed', null))).toMatchObject({
      reason: 'failed',
    });
  });

  it('does not match an abbreviated SHA, a SHA that differs in one character, or a prefix', () => {
    // A SHA with letters in it, so that upper case is a different string.
    const loaded = sha(0xab);
    const index = buildCommitIndex([commit(0xab, [])], 'ready', END);
    expect(linkMergeCommit(pull({ mergeCommitSha: loaded }), index).kind).toBe('linked');
    const oneOff = `${loaded.slice(0, 39)}c`;
    for (const mergeCommitSha of [loaded.slice(0, 7), oneOff, `${loaded}0`, loaded.toUpperCase()]) {
      expect(linkMergeCommit(pull({ mergeCommitSha }), index).kind).toBe('not_loaded');
    }
  });

  it('never matches by branch name, title or date', () => {
    const lookalike: CommitItem = {
      ...commit(7, [4]),
      subject: 'Merge pull request #1 from octo/feat/a',
      date: '2026-10-03T10:00:00Z',
    };
    const index = buildCommitIndex([lookalike], 'ready', END);
    // The title, branches and merge date of the pull request all "fit" this commit.
    const result = linkMergeCommit(
      pull({ title: 'Merge pull request #1', mergeCommitSha: sha(99) }),
      index,
    );
    expect(result.kind).toBe('not_loaded');
  });

  it('has nothing to link when GitHub did not state the merge commit', () => {
    expect(linkMergeCommit(pull({ mergeCommitSha: null }), ready())).toEqual({
      kind: 'not_stated',
    });
  });

  it('never links a pull request that is not merged, even with a SHA that is loaded', () => {
    for (const state of ['open', 'draft', 'closed'] as const) {
      expect(linkMergeCommit(pull({ state, mergeCommitSha: sha(1) }), ready())).toEqual({
        kind: 'none',
      });
    }
  });
});
