import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIssueList } from '@gvu/shared';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import type { PageCursor } from './activity.ts';
import { GitHubApiError } from './client.ts';
import {
  ISSUE_PAGE_SIZE,
  MAX_ISSUE_PAGES,
  MAX_LABELS_SHOWN,
  loadIssuePage,
  toIssueItem,
} from './issues.ts';

const GH = 'https://api.github.com';
const TARGET = { owner: 'octo', name: 'alpha' };
const ISSUES = `GET ${GH}/repos/octo/alpha/issues`;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubNetwork(routes: Record<string, Handler>) {
  const net = createFakeFetch(routes);
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

const rawIssue = (extra: Record<string, unknown> = {}) => ({
  number: 21,
  state: 'closed',
  title: 'Crash on start',
  state_reason: 'completed',
  user: { login: 'ada', id: 3, email: 'ada@example.test' },
  labels: [{ name: 'bug', color: 'ff0000', description: 'Something is broken' }, 'help wanted'],
  comments: 4,
  created_at: '2026-10-01T10:00:00Z',
  updated_at: '2026-10-03T10:00:00Z',
  closed_at: '2026-10-03T10:00:00Z',
  body: 'A long description that must not be kept.',
  html_url: 'https://example.test/issues/21',
  ...extra,
});

const rawPullEntry = (number: number) => rawIssue({ number, pull_request: { url: 'x' } });

/** An issue as the mapping sees it after the shared parser has read it. */
function item(extra: Record<string, unknown> = {}) {
  const { issues } = parseIssueList([rawIssue(extra)]);
  const [issue] = issues;
  if (issue === undefined) throw new Error('the fixture was rejected');
  return toIssueItem(issue);
}

const link = (page: number) =>
  `<${GH}/repositories/1/issues?per_page=100&page=${String(page)}>; rel="next"`;

describe('toIssueItem', () => {
  it('keeps the number, title, state, reason, labels, author, comments and dates', () => {
    expect(item()).toEqual({
      number: 21,
      title: 'Crash on start',
      state: 'closed',
      stateReason: 'completed',
      labels: ['bug', 'help wanted'],
      labelsNotShown: 0,
      authorLogin: 'ada',
      comments: 4,
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-03T10:00:00Z',
      closedAt: '2026-10-03T10:00:00Z',
    });
  });

  it('maps an open issue', () => {
    const issue = item({ state: 'open', state_reason: null, closed_at: null });
    expect(issue.state).toBe('open');
    expect(issue.stateReason).toBeNull();
    expect(issue.closedAt).toBeNull();
  });

  it('never keeps the description, an email address, a link or a label colour', () => {
    const text = JSON.stringify(item());
    expect(text).not.toContain('long description');
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('ff0000');
    expect(text).not.toContain('Something is broken');
    expect(text).not.toContain('http');
  });

  it('shows missing author, title, comments and dates as absent, never as an invented value', () => {
    const issue = item({
      user: null,
      title: undefined,
      comments: undefined,
      created_at: 'yesterday',
      updated_at: null,
      closed_at: undefined,
      labels: undefined,
      state_reason: undefined,
    });
    expect(issue.authorLogin).toBeNull();
    expect(issue.title).toBe('');
    expect(issue.comments).toBeNull();
    expect(issue.createdAt).toBeNull();
    expect(issue.updatedAt).toBeNull();
    expect(issue.closedAt).toBeNull();
    expect(issue.labels).toBeNull();
    expect(issue.stateReason).toBeNull();
  });

  it('keeps an issue with no labels as an empty list, distinct from labels not stated', () => {
    expect(item({ labels: [] }).labels).toEqual([]);
  });

  it('makes untrusted text display-safe', () => {
    const issue = item({
      title: 'Fix\u202Eevil\u0000 <b>title</b>',
      user: { login: 'ev\u2066il' },
      labels: ['la\u200Bbel', { name: 'ba\u0007d' }],
    });
    expect(issue.title).toBe('Fix\uFFFDevil\uFFFD <b>title</b>');
    expect(issue.authorLogin).toBe('ev\uFFFDil');
    expect(issue.labels).toEqual(['la\uFFFDbel', 'ba\uFFFDd']);
  });

  it('cuts a very long title and a very long label', () => {
    const issue = item({ title: 'x'.repeat(5000), labels: ['y'.repeat(5000)] });
    expect(issue.title.length).toBeLessThanOrEqual(200);
    expect(issue.labels?.[0]?.length).toBeLessThanOrEqual(200);
  });

  it('drops blank labels, and keeps at most the first few, counting the rest', () => {
    const names = Array.from({ length: MAX_LABELS_SHOWN + 3 }, (_, i) => `label-${String(i)}`);
    const issue = item({ labels: ['', '   ', null, ...names] });
    expect(issue.labels).toEqual(names.slice(0, MAX_LABELS_SHOWN));
    expect(issue.labelsNotShown).toBe(3);
  });

  it('ignores a state reason it does not know', () => {
    expect(item({ state_reason: 'something_new' }).stateReason).toBeNull();
  });
});

describe('loadIssuePage', () => {
  it('asks for 100 issues of every state, most recently updated first, with a GET', async () => {
    const net = stubNetwork({ [ISSUES]: () => Response.json([]) });

    await loadIssuePage(TEST_TOKEN, TARGET, null);

    expect(net.requests).toHaveLength(1);
    const request = net.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url.origin).toBe(GH);
    expect(request?.url.pathname).toBe('/repos/octo/alpha/issues');
    expect(Object.fromEntries(request?.url.searchParams ?? [])).toEqual({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(ISSUE_PAGE_SIZE),
    });
    expect(request?.init.credentials).toBe('omit');
    expect(request?.init.body ?? null).toBeNull();
  });

  it('returns the issues, counts pull requests apart, and counts unreadable entries as skipped', async () => {
    stubNetwork({
      [ISSUES]: () =>
        Response.json([
          rawIssue(),
          rawPullEntry(30),
          rawIssue({ number: 'x' }),
          'junk',
          rawIssue({ number: 22 }),
          rawPullEntry(31),
          rawIssue({ number: 40, pull_request: 'maybe' }),
        ]),
    });
    const page = await loadIssuePage(TEST_TOKEN, TARGET, null);
    expect(page.items.map((issue) => issue.number)).toEqual([21, 22]);
    expect(page.omitted).toBe(2);
    expect(page.skipped).toBe(3);
    expect(page.next).toEqual({ kind: 'end' });
  });

  it('reports no omitted entries when there are only issues', async () => {
    stubNetwork({ [ISSUES]: () => Response.json([rawIssue()]) });
    const page = await loadIssuePage(TEST_TOKEN, TARGET, null);
    expect(page.omitted).toBe(0);
  });

  it('returns a page of only pull requests as no items, with a next cursor when GitHub has more', async () => {
    stubNetwork({
      [ISSUES]: () =>
        Response.json([rawPullEntry(1), rawPullEntry(2)], { headers: { Link: link(2) } }),
    });
    const page = await loadIssuePage(TEST_TOKEN, TARGET, null);
    expect(page.items).toEqual([]);
    expect(page.omitted).toBe(2);
    expect(page.next.kind).toBe('more');
  });

  it('reports the rate-limit headers of the response', async () => {
    stubNetwork({
      [ISSUES]: () =>
        Response.json([], {
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        }),
    });
    const page = await loadIssuePage(TEST_TOKEN, TARGET, null);
    expect(page.rateLimit).toEqual({ remaining: 0, resetAt: 1_800_000_000_000 });
  });

  it('refuses unsafe repository names without sending anything', async () => {
    const net = stubNetwork({});
    await expect(
      loadIssuePage(TEST_TOKEN, { owner: '../etc', name: 'alpha' }, null),
    ).rejects.toBeInstanceOf(Error);
    expect(net.requests).toHaveLength(0);
  });
});

describe('loadIssuePage: paging', () => {
  it('returns a cursor while GitHub offers a next page, and follows exactly that URL', async () => {
    const net = stubNetwork({
      [ISSUES]: () => Response.json([rawIssue()], { headers: { Link: link(2) } }),
      [`GET ${GH}/repositories/1/issues`]: () => Response.json([rawIssue({ number: 5 })]),
    });

    const first = await loadIssuePage(TEST_TOKEN, TARGET, null);
    expect(first.next.kind).toBe('more');
    if (first.next.kind !== 'more') throw new Error('expected a cursor');

    const second = await loadIssuePage(TEST_TOKEN, TARGET, first.next.cursor);
    expect(second.items.map((issue) => issue.number)).toEqual([5]);
    expect(second.next).toEqual({ kind: 'end' });
    expect(net.requests[1]?.url.href).toBe(`${GH}/repositories/1/issues?per_page=100&page=2`);
    expect(net.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it(`stops at ${String(MAX_ISSUE_PAGES)} pages even though GitHub offers more`, async () => {
    stubNetwork({
      [`GET ${GH}/repositories/1/issues`]: () =>
        Response.json([rawIssue()], { headers: { Link: link(MAX_ISSUE_PAGES + 1) } }),
    });
    const cursor: PageCursor = {
      nextUrl: `${GH}/repositories/1/issues?per_page=100&page=${String(MAX_ISSUE_PAGES)}`,
      page: MAX_ISSUE_PAGES,
    };
    const page = await loadIssuePage(TEST_TOKEN, TARGET, cursor);
    expect(page.next).toEqual({ kind: 'capped' });
  });

  it('refuses a cursor past the cap, without sending anything', async () => {
    const net = stubNetwork({});
    await expect(
      loadIssuePage(TEST_TOKEN, TARGET, {
        nextUrl: `${GH}/repositories/1/issues?page=${String(MAX_ISSUE_PAGES + 1)}`,
        page: MAX_ISSUE_PAGES + 1,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(net.requests).toHaveLength(0);
  });

  it('never follows a next link that leaves api.github.com', async () => {
    stubNetwork({
      [ISSUES]: () =>
        Response.json([rawIssue()], {
          headers: { Link: '<https://evil.example/issues?page=2>; rel="next"' },
        }),
    });
    const page = await loadIssuePage(TEST_TOKEN, TARGET, null);
    expect(page.next).toEqual({ kind: 'end' });
  });
});

describe('loadIssuePage: failures', () => {
  const failWith = (status: number, headers: Record<string, string> = {}) => {
    stubNetwork({
      [ISSUES]: () => new Response('{"message":"secret detail"}', { status, headers }),
    });
    return loadIssuePage(TEST_TOKEN, TARGET, null);
  };

  it('reports a 401 as unauthorized', async () => {
    await expect(failWith(401)).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it('reports a 403 as forbidden', async () => {
    await expect(failWith(403)).rejects.toMatchObject({ kind: 'forbidden', status: 403 });
  });

  it('reports a 404 and a 410 with their status', async () => {
    await expect(failWith(404)).rejects.toMatchObject({ status: 404 });
    await expect(failWith(410)).rejects.toMatchObject({ status: 410 });
  });

  it('reports an exhausted rate limit with its reset time', async () => {
    await expect(
      failWith(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', resetAt: 1_800_000_000_000 });
  });

  it('does not carry the response text in the error', async () => {
    const error = await failWith(403).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(JSON.stringify(error)).not.toContain('secret detail');
    expect((error as Error).message).not.toContain('secret detail');
  });

  it('reports a response that is not a list as invalid', async () => {
    stubNetwork({ [ISSUES]: () => Response.json({ issues: [] }) });
    await expect(loadIssuePage(TEST_TOKEN, TARGET, null)).rejects.toBeInstanceOf(GitHubApiError);
  });
});
