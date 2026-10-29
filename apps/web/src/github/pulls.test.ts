import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import type { PageCursor } from './activity.ts';
import { GitHubApiError } from './client.ts';
import { MAX_PULL_PAGES, PULL_PAGE_SIZE, loadPullPage, toPullItem } from './pulls.ts';
import { parsePullRequestList } from '@gvu/shared';

const GH = 'https://api.github.com';
const SHA = 'a'.repeat(40);
const TARGET = { owner: 'octo', name: 'alpha' };
const PULLS = `GET ${GH}/repos/octo/alpha/pulls`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNetwork(routes: Record<string, Handler>) {
  const net = createFakeFetch(routes);
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

const rawPull = (extra: Record<string, unknown> = {}) => ({
  number: 12,
  state: 'closed',
  title: 'Add the thing',
  draft: false,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-03T10:00:00Z',
  closed_at: '2026-10-03T10:00:00Z',
  merged_at: '2026-10-03T10:00:00Z',
  merge_commit_sha: SHA,
  head: { ref: 'feat/thing', sha: 'c'.repeat(40), repo: { full_name: 'octo/alpha' } },
  base: { ref: 'main', sha: 'd'.repeat(40) },
  user: { login: 'ada', id: 3, email: 'ada@example.test' },
  body: 'A long description that must not be kept.',
  ...extra,
});

/** A pull request as the mapping sees it after the shared schema has read it. */
function item(extra: Record<string, unknown> = {}) {
  const { pulls } = parsePullRequestList([rawPull(extra)]);
  const [pull] = pulls;
  if (pull === undefined) throw new Error('the fixture was rejected');
  return toPullItem(pull);
}

/** A Link header pointing at another page of the same collection. */
const link = (page: number) =>
  `<${GH}/repositories/1/pulls?per_page=100&page=${String(page)}>; rel="next"`;

describe('toPullItem: states', () => {
  it('maps an open pull request', () => {
    const pull = item({ state: 'open', draft: false, closed_at: null, merged_at: null });
    expect(pull.state).toBe('open');
    expect(pull.draftUnknown).toBe(false);
  });

  it('maps an open pull request that GitHub marks as a draft', () => {
    const pull = item({ state: 'open', draft: true, closed_at: null, merged_at: null });
    expect(pull.state).toBe('draft');
  });

  it('does not call an open pull request a draft when the flag is missing, and says so', () => {
    const pull = item({ state: 'open', draft: undefined, closed_at: null, merged_at: null });
    expect(pull.state).toBe('open');
    expect(pull.draftUnknown).toBe(true);
  });

  it('does not assume a pull request is not a draft when the flag is null or unreadable', () => {
    // `null` is what GitHub sends for "no value"; a wrong type is dropped by the schema.
    for (const draft of [null, 'yes', 0, {}]) {
      const pull = item({ state: 'open', draft, closed_at: null, merged_at: null });
      expect(pull.state).toBe('open');
      expect(pull.draftUnknown).toBe(true);
    }
  });

  it('treats a draft flag as known only when it is a boolean', () => {
    for (const draft of [true, false]) {
      expect(item({ state: 'open', draft, closed_at: null, merged_at: null }).draftUnknown).toBe(
        false,
      );
    }
    // The flag says nothing about a pull request that is already closed or merged.
    expect(item({ draft: null }).draftUnknown).toBe(false);
    expect(item({ draft: null, merged_at: null }).draftUnknown).toBe(false);
  });

  it('maps a closed pull request with a merge date as merged', () => {
    const pull = item();
    expect(pull.state).toBe('merged');
    expect(pull.mergedAt).toBe('2026-10-03T10:00:00Z');
    expect(pull.mergeCommitSha).toBe(SHA);
  });

  it('maps a closed pull request without a merge date as closed', () => {
    const pull = item({ merged_at: null });
    expect(pull.state).toBe('closed');
    expect(pull.mergedAt).toBeNull();
    expect(pull.closedAt).toBe('2026-10-03T10:00:00Z');
  });

  it('shows a closed draft as closed, not as a draft', () => {
    expect(item({ draft: true, merged_at: null }).state).toBe('closed');
  });

  it('calls a closed pull request merged even when the merge date is unreadable, without a date', () => {
    const pull = item({ merged_at: 'not a date' });
    expect(pull.state).toBe('merged');
    expect(pull.mergedAt).toBeNull();
  });
});

describe('toPullItem: the merge commit', () => {
  it('keeps the merge commit SHA only for a merged pull request', () => {
    expect(item().mergeCommitSha).toBe(SHA);
    // For these, GitHub's value is a throwaway test merge, which must never be linked.
    expect(item({ state: 'open', merged_at: null }).mergeCommitSha).toBeNull();
    expect(item({ state: 'open', draft: true, merged_at: null }).mergeCommitSha).toBeNull();
    expect(item({ merged_at: null }).mergeCommitSha).toBeNull();
  });

  it('has none when GitHub did not state a well-formed one', () => {
    expect(item({ merge_commit_sha: null }).mergeCommitSha).toBeNull();
    expect(item({ merge_commit_sha: undefined }).mergeCommitSha).toBeNull();
    expect(item({ merge_commit_sha: SHA.slice(0, 7) }).mergeCommitSha).toBeNull();
  });
});

describe('toPullItem: fields', () => {
  it('keeps the number, title, branches, author and dates', () => {
    expect(item()).toEqual({
      number: 12,
      title: 'Add the thing',
      state: 'merged',
      draftUnknown: false,
      headBranch: 'feat/thing',
      baseBranch: 'main',
      authorLogin: 'ada',
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-03T10:00:00Z',
      closedAt: '2026-10-03T10:00:00Z',
      mergedAt: '2026-10-03T10:00:00Z',
      mergeCommitSha: SHA,
    });
  });

  it('never keeps an email address, the description or the head repository', () => {
    const text = JSON.stringify(item());
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('long description');
    expect(text).not.toContain('full_name');
  });

  it('copes with a head repository that was deleted: the branch name is still there', () => {
    const pull = item({ head: { ref: 'feat/thing', sha: 'c'.repeat(40), repo: null } });
    expect(pull.headBranch).toBe('feat/thing');
  });

  it('shows missing head, base and author as absent, never as an invented value', () => {
    const pull = item({ head: null, base: { ref: '' }, user: null, title: undefined });
    expect(pull.headBranch).toBeNull();
    expect(pull.baseBranch).toBeNull();
    expect(pull.authorLogin).toBeNull();
    expect(pull.title).toBe('');
  });

  it('shows missing or unreadable dates as absent', () => {
    const pull = item({ created_at: 'yesterday', updated_at: null, closed_at: undefined });
    expect(pull.createdAt).toBeNull();
    expect(pull.updatedAt).toBeNull();
    expect(pull.closedAt).toBeNull();
  });

  it('makes untrusted text display-safe', () => {
    const pull = item({
      title: 'Fix\u202Eevil\u0000 <b>title</b>',
      head: { ref: 'feat/\u200Bhidden\u202Ename' },
      base: { ref: 'ma\u0007in' },
      user: { login: 'ev\u2066il' },
    });
    expect(pull.title).toBe('Fix\uFFFDevil\uFFFD <b>title</b>');
    expect(pull.headBranch).toBe('feat/\uFFFDhidden\uFFFDname');
    expect(pull.baseBranch).toBe('ma\uFFFDin');
    expect(pull.authorLogin).toBe('ev\uFFFDil');
  });

  it('cuts a very long title', () => {
    expect(item({ title: 'x'.repeat(5000) }).title.length).toBeLessThanOrEqual(200);
  });
});

describe('loadPullPage', () => {
  it('asks for 100 pull requests of every state, most recently updated first, with a GET', async () => {
    const net = stubNetwork({ [PULLS]: () => Response.json([]) });

    await loadPullPage(TEST_TOKEN, TARGET, null);

    expect(net.requests).toHaveLength(1);
    const request = net.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url.origin).toBe(GH);
    expect(request?.url.pathname).toBe('/repos/octo/alpha/pulls');
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(PULL_PAGE_SIZE),
    });
    expect(request?.init.credentials).toBe('omit');
  });

  it('returns the readable pull requests and counts the ones it could not read', async () => {
    stubNetwork({
      [PULLS]: () =>
        Response.json([rawPull(), rawPull({ number: 'x' }), 'junk', rawPull({ number: 13 })]),
    });
    const page = await loadPullPage(TEST_TOKEN, TARGET, null);
    expect(page.items.map((pull) => pull.number)).toEqual([12, 13]);
    expect(page.skipped).toBe(2);
    expect(page.next).toEqual({ kind: 'end' });
  });

  it('reports the rate-limit headers of the response', async () => {
    stubNetwork({
      [PULLS]: () =>
        Response.json([], {
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        }),
    });
    const page = await loadPullPage(TEST_TOKEN, TARGET, null);
    expect(page.rateLimit).toEqual({ remaining: 0, resetAt: 1_800_000_000_000 });
  });

  it('refuses unsafe repository names without sending anything', async () => {
    const net = stubNetwork({});
    await expect(
      loadPullPage(TEST_TOKEN, { owner: '../etc', name: 'alpha' }, null),
    ).rejects.toBeInstanceOf(Error);
    expect(net.requests).toHaveLength(0);
  });
});

describe('loadPullPage: paging', () => {
  it('returns a cursor while GitHub offers a next page, and follows exactly that URL', async () => {
    const net = stubNetwork({
      [PULLS]: () => Response.json([rawPull()], { headers: { Link: link(2) } }),
      [`GET ${GH}/repositories/1/pulls`]: () => Response.json([rawPull({ number: 5 })]),
    });

    const first = await loadPullPage(TEST_TOKEN, TARGET, null);
    expect(first.next.kind).toBe('more');
    if (first.next.kind !== 'more') throw new Error('expected a cursor');

    const second = await loadPullPage(TEST_TOKEN, TARGET, first.next.cursor);
    expect(second.items.map((pull) => pull.number)).toEqual([5]);
    expect(second.next).toEqual({ kind: 'end' });
    expect(net.requests[1]?.url.href).toBe(`${GH}/repositories/1/pulls?per_page=100&page=2`);
  });

  it(`stops at ${String(MAX_PULL_PAGES)} pages even though GitHub offers more`, async () => {
    stubNetwork({
      [`GET ${GH}/repositories/1/pulls`]: () =>
        Response.json([rawPull()], { headers: { Link: link(MAX_PULL_PAGES + 1) } }),
    });
    const cursor: PageCursor = {
      nextUrl: `${GH}/repositories/1/pulls?per_page=100&page=${String(MAX_PULL_PAGES)}`,
      page: MAX_PULL_PAGES,
    };
    const page = await loadPullPage(TEST_TOKEN, TARGET, cursor);
    expect(page.next).toEqual({ kind: 'capped' });
  });

  it('refuses a cursor past the cap, without sending anything', async () => {
    const net = stubNetwork({});
    await expect(
      loadPullPage(TEST_TOKEN, TARGET, {
        nextUrl: `${GH}/repositories/1/pulls?page=${String(MAX_PULL_PAGES + 1)}`,
        page: MAX_PULL_PAGES + 1,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(net.requests).toHaveLength(0);
  });

  it('never follows a next link that leaves api.github.com', async () => {
    stubNetwork({
      [PULLS]: () =>
        Response.json([rawPull()], {
          headers: { Link: '<https://evil.example/pulls?page=2>; rel="next"' },
        }),
    });
    const page = await loadPullPage(TEST_TOKEN, TARGET, null);
    expect(page.next).toEqual({ kind: 'end' });
  });
});

describe('loadPullPage: failures', () => {
  const failWith = (status: number, headers: Record<string, string> = {}) => {
    stubNetwork({
      [PULLS]: () => new Response('{"message":"secret detail"}', { status, headers }),
    });
    return loadPullPage(TEST_TOKEN, TARGET, null);
  };

  it('reports a 401 as unauthorized', async () => {
    await expect(failWith(401)).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it('reports a 403 as forbidden', async () => {
    await expect(failWith(403)).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('reports an exhausted rate limit with its reset time', async () => {
    await expect(
      failWith(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', resetAt: 1_800_000_000_000 });
  });

  it('reports a response that is not a list as invalid', async () => {
    stubNetwork({ [PULLS]: () => Response.json({ pulls: [] }) });
    await expect(loadPullPage(TEST_TOKEN, TARGET, null)).rejects.toBeInstanceOf(GitHubApiError);
  });
});
