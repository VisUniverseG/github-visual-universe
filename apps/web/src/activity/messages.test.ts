import { describe, expect, it } from 'vitest';
import { GitHubApiError } from '../github/client.ts';
import {
  describeActivityFailure,
  describeIssueFailure,
  omittedPullRequestsMessage,
  partialListMessage,
} from './messages.ts';

describe('describeIssueFailure', () => {
  it('names the Issues permission for a 403, and does not offer a retry', () => {
    const failure = describeIssueFailure(new GitHubApiError('forbidden', { status: 403 }));
    expect(failure.kind).toBe('forbidden');
    expect(failure.text).toContain('read access to Issues');
    expect(failure.retryable).toBe(false);
  });

  it('explains a 404 for the issue list', () => {
    const failure = describeIssueFailure(new GitHubApiError('http', { status: 404 }));
    expect(failure.text).toContain('issue list could not be found');
    expect(failure.retryable).toBe(false);
  });

  it('treats a 410 (issues turned off) as an empty list, not a failure to retry', () => {
    const failure = describeIssueFailure(new GitHubApiError('http', { status: 410 }));
    expect(failure).toMatchObject({ kind: 'empty', retryable: false });
    expect(failure.text).toBe('Issues are turned off for this repository.');
  });

  it('does not treat a 410 as empty for the other lists', () => {
    for (const scope of ['commits', 'branches', 'pulls'] as const) {
      const failure = describeActivityFailure(new GitHubApiError('http', { status: 410 }), scope);
      expect(failure.kind).not.toBe('empty');
    }
  });
});

describe('partialListMessage for issues', () => {
  it('says nothing when the list is complete', () => {
    expect(partialListMessage({ noun: 'issues', next: { kind: 'end' }, skipped: 0 })).toBeNull();
  });

  it('says older issues have not been loaded while GitHub has more', () => {
    const next = {
      kind: 'more',
      cursor: { nextUrl: 'https://api.github.com/x?page=2', page: 2 },
    } as const;
    expect(partialListMessage({ noun: 'issues', next, skipped: 0 })).toContain(
      'Older issues have not been loaded.',
    );
  });

  it('counts entries, not issues, when the cap is reached', () => {
    const text = partialListMessage({ noun: 'issues', next: { kind: 'capped' }, skipped: 0 });
    expect(text).toContain('500 entries');
    expect(text).toContain('issues and pull requests together');
  });

  it('counts the issues that could not be read', () => {
    expect(partialListMessage({ noun: 'issues', next: { kind: 'end' }, skipped: 2 })).toContain(
      '2 issues',
    );
  });
});

describe('omittedPullRequestsMessage', () => {
  it('is absent when nothing was left out', () => {
    expect(omittedPullRequestsMessage(0)).toBeNull();
  });

  it('uses the singular and the plural, and points to the Pull requests panel', () => {
    expect(omittedPullRequestsMessage(1)).toContain('1 pull request in GitHub');
    expect(omittedPullRequestsMessage(1)).toContain('was left out');
    expect(omittedPullRequestsMessage(1200)).toContain('1,200 pull requests');
    expect(omittedPullRequestsMessage(2)).toContain('were left out');
    expect(omittedPullRequestsMessage(2)).toContain('Pull requests panel');
  });
});
