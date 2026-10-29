import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../testing/fakeFetch.ts';
import {
  ACTIVITY_PAGE_SIZE,
  MAX_BRANCH_PAGES,
  MAX_COMMIT_PAGES,
  loadBranchPage,
  loadCommitPage,
  toCommitItem,
  type PageCursor,
} from './activity.ts';
import { GitHubApiError } from './client.ts';

const GH = 'https://api.github.com';
const SHA = 'a'.repeat(40);
const PARENT = 'b'.repeat(40);
const TARGET = { owner: 'octo', name: 'alpha', branch: 'main' };

afterEach(() => {
  vi.unstubAllGlobals();
});

const rawCommit = (extra: Record<string, unknown> = {}) => ({
  sha: SHA,
  commit: {
    message: 'Fix the thing\n\nA much longer explanation that must not be kept.',
    author: { name: 'Ada Lovelace', email: 'ada@example.com', date: '2026-10-01T10:00:00Z' },
    committer: { name: 'Bot', email: 'bot@example.com', date: '2026-10-02T10:00:00Z' },
  },
  author: { login: 'ada' },
  parents: [{ sha: PARENT }],
  ...extra,
});

const rawBranch = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  commit: { sha: SHA },
  protected: false,
  ...extra,
});

function stubNetwork(routes: Record<string, Handler>) {
  const net = createFakeFetch(routes);
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

/** A Link header pointing at another page of the same collection. */
const link = (path: string, page: number) =>
  `<${GH}${path}?per_page=100&page=${String(page)}>; rel="next"`;

describe('loadCommitPage', () => {
  it('asks for 100 commits of the default branch, by name', async () => {
    const net = stubNetwork({ [`GET ${GH}/repos/octo/alpha/commits`]: () => Response.json([]) });

    await loadCommitPage(TEST_TOKEN, TARGET, null);

    expect(net.requests).toHaveLength(1);
    const request = net.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url.origin).toBe(GH);
    expect(request?.url.pathname).toBe('/repos/octo/alpha/commits');
    expect(request?.url.searchParams.get('per_page')).toBe(String(ACTIVITY_PAGE_SIZE));
    expect(request?.url.searchParams.get('sha')).toBe('main');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('encodes a branch name that contains a slash or other URL characters', async () => {
    const net = stubNetwork({ [`GET ${GH}/repos/octo/alpha/commits`]: () => Response.json([]) });

    await loadCommitPage(TEST_TOKEN, { ...TARGET, branch: 'feature/a&b=c#d' }, null);

    const request = net.requests[0];
    expect(request?.url.searchParams.get('sha')).toBe('feature/a&b=c#d');
    expect(request?.url.pathname).toBe('/repos/octo/alpha/commits');
    expect(request?.url.hash).toBe('');
    expect(request?.url.search).toContain('sha=feature%2Fa%26b%3Dc%23d');
  });

  it('omits the branch when it is not known, so GitHub uses the default branch', async () => {
    const net = stubNetwork({ [`GET ${GH}/repos/octo/alpha/commits`]: () => Response.json([]) });

    await loadCommitPage(TEST_TOKEN, { ...TARGET, branch: null }, null);

    expect(net.requests[0]?.url.searchParams.has('sha')).toBe(false);
  });

  it('keeps only the first line of the message, the author, a date and the parent count', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () => Response.json([rawCommit()]),
    });

    const page = await loadCommitPage(TEST_TOKEN, TARGET, null);

    expect(page.items).toEqual([
      {
        sha: SHA,
        subject: 'Fix the thing',
        authorName: 'Ada Lovelace',
        authorLogin: 'ada',
        date: '2026-10-01T10:00:00Z',
        parentCount: 1,
        parentShas: [PARENT],
      },
    ]);
    expect(page.skipped).toBe(0);
    expect(page.next).toEqual({ kind: 'end' });
  });

  it('never keeps an email address, the message body or any other field', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([
          rawCommit({ committer: { login: 'web-flow' }, html_url: 'https://x.test' }),
        ]),
    });

    const page = await loadCommitPage(TEST_TOKEN, TARGET, null);
    const text = JSON.stringify(page);

    expect(text).not.toContain('example.com');
    expect(text).not.toContain('@');
    expect(text).not.toContain('longer explanation');
    expect(text).not.toContain('web-flow');
    expect(text).not.toContain('x.test');
  });

  it('makes untrusted subjects and names display-safe', () => {
    const item = toCommitItem({
      sha: SHA,
      commit: {
        message: `\u202Eevil\u0007 ${'x'.repeat(400)}`,
        author: { name: 'Mal\u202Elory', date: '2026-10-01T10:00:00Z' },
      },
      author: { login: 'a\u200Bb' },
    });

    expect(item.subject).not.toContain('\u202E');
    expect(item.subject).not.toContain('\u0007');
    expect(item.subject.length).toBeLessThanOrEqual(200);
    expect(item.authorName).toBe('Mal\uFFFDlory');
    expect(item.authorLogin).toBe('a\uFFFDb');
  });

  it('copes with a commit that has no message, author or parents', () => {
    const item = toCommitItem({ sha: SHA, commit: {} });
    expect(item).toEqual({
      sha: SHA,
      subject: '',
      authorName: null,
      authorLogin: null,
      date: null,
      parentCount: null,
      parentShas: null,
    });
  });

  it('treats a message that starts with a line break as having no subject', () => {
    expect(toCommitItem({ sha: SHA, commit: { message: '\n\nbody only' } }).subject).toBe('');
  });

  it('falls back to the committer date when the author date is missing or unreadable', () => {
    const commit = (author: { name?: string; date?: string } | undefined) => ({
      sha: SHA,
      commit: { author, committer: { date: '2026-10-02T10:00:00Z' } },
    });
    expect(toCommitItem(commit({ date: 'not a date' })).date).toBe('2026-10-02T10:00:00Z');
    expect(toCommitItem(commit({})).date).toBe('2026-10-02T10:00:00Z');
    expect(toCommitItem(commit(undefined)).date).toBe('2026-10-02T10:00:00Z');
  });

  it('has no date when neither date is readable', () => {
    expect(
      toCommitItem({
        sha: SHA,
        commit: { author: { date: 'x' }, committer: { date: 'y' } },
      }).date,
    ).toBeNull();
  });

  it('counts merges by their parents, and unknown parents as unknown', () => {
    const merge = toCommitItem({ sha: SHA, commit: {}, parents: [null, null] });
    const root = toCommitItem({ sha: SHA, commit: {}, parents: [] });
    expect(merge.parentCount).toBe(2);
    expect(root.parentCount).toBe(0);
  });

  it('keeps the parents in order, an unreadable one as null, and a root as an empty list', () => {
    const other = 'c'.repeat(40);
    const merge = toCommitItem({ sha: SHA, commit: {}, parents: [PARENT, other] });
    const odd = toCommitItem({ sha: SHA, commit: {}, parents: [null, other] });
    const root = toCommitItem({ sha: SHA, commit: {}, parents: [] });
    const unknown = toCommitItem({ sha: SHA, commit: {} });

    expect(merge.parentShas).toEqual([PARENT, other]);
    expect(odd.parentShas).toEqual([null, other]);
    expect(odd.parentCount).toBe(2);
    expect(root.parentShas).toEqual([]);
    expect(unknown.parentShas).toBeNull();
    expect(unknown.parentCount).toBeNull();
  });

  it('reads parent SHAs from a real-shaped response, and drops everything else about a parent', async () => {
    const other = 'c'.repeat(40);
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([
          rawCommit({
            parents: [
              { sha: PARENT, url: 'https://api.github.com/p', html_url: 'https://github.test/p' },
              { sha: 'not-a-sha' },
              { sha: other },
            ],
          }),
        ]),
    });

    const page = await loadCommitPage(TEST_TOKEN, TARGET, null);

    expect(page.items[0]?.parentShas).toEqual([PARENT, null, other]);
    expect(page.items[0]?.parentCount).toBe(3);
    expect(JSON.stringify(page)).not.toContain('github.test');
  });

  it('skips and counts entries that cannot be read', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([rawCommit(), { sha: 'bad' }, null, rawCommit({ sha: 'c'.repeat(40) })]),
    });

    const page = await loadCommitPage(TEST_TOKEN, TARGET, null);

    expect(page.items.map((item) => item.sha)).toEqual([SHA, 'c'.repeat(40)]);
    expect(page.skipped).toBe(2);
  });

  it('reports the rate-limit headers of the response', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([], {
          headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1800000000' },
        }),
    });

    const page = await loadCommitPage(TEST_TOKEN, TARGET, null);

    expect(page.rateLimit).toEqual({ remaining: 4999, resetAt: 1_800_000_000_000 });
  });
});

describe('paging', () => {
  it('returns a cursor while GitHub offers a next page, and follows it', async () => {
    const path = '/repositories/1/commits';
    const net = stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([rawCommit()], { headers: { link: link(path, 2) } }),
      [`GET ${GH}${path}`]: () =>
        Response.json([rawCommit({ sha: 'c'.repeat(40) })], { headers: { link: link(path, 3) } }),
    });

    const first = await loadCommitPage(TEST_TOKEN, TARGET, null);
    expect(first.next.kind).toBe('more');
    const cursor = first.next.kind === 'more' ? first.next.cursor : null;
    expect(cursor?.page).toBe(2);

    const second = await loadCommitPage(TEST_TOKEN, TARGET, cursor);
    expect(second.items.map((item) => item.sha)).toEqual(['c'.repeat(40)]);
    expect(second.next.kind === 'more' && second.next.cursor.page).toBe(3);
    expect(net.requests.map((r) => r.url.pathname)).toEqual(['/repos/octo/alpha/commits', path]);
    expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
  });

  it('stops at the commit page cap even though GitHub offers more', async () => {
    const path = '/repositories/1/commits';
    stubNetwork({
      [`GET ${GH}${path}`]: () => Response.json([], { headers: { link: link(path, 9) } }),
    });

    const last: PageCursor = { nextUrl: `${GH}${path}?page=5`, page: MAX_COMMIT_PAGES };
    const page = await loadCommitPage(TEST_TOKEN, TARGET, last);

    expect(MAX_COMMIT_PAGES).toBe(5);
    expect(page.next).toEqual({ kind: 'capped' });
  });

  it('ends when the last page has no next link, even at the cap', async () => {
    const path = '/repositories/1/commits';
    stubNetwork({ [`GET ${GH}${path}`]: () => Response.json([]) });

    const last: PageCursor = { nextUrl: `${GH}${path}?page=5`, page: MAX_COMMIT_PAGES };
    const page = await loadCommitPage(TEST_TOKEN, TARGET, last);

    expect(page.next).toEqual({ kind: 'end' });
  });

  it('refuses a cursor that is not a later page of the list, without sending anything', async () => {
    const net = stubNetwork({});
    const url = `${GH}/repositories/1/commits?page=2`;
    for (const page of [0, 1, MAX_COMMIT_PAGES + 1]) {
      await expect(
        loadCommitPage(TEST_TOKEN, TARGET, { nextUrl: url, page }),
      ).rejects.toBeInstanceOf(GitHubApiError);
    }
    expect(net.requests).toHaveLength(0);
  });

  it('never follows a next link that leaves api.github.com', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([], { headers: { link: '<https://evil.example/x?page=2>; rel="next"' } }),
    });

    const page = await loadCommitPage(TEST_TOKEN, TARGET, null);

    expect(page.next).toEqual({ kind: 'end' });
  });

  it('ends the list on a short final page that follows a full page of 100', async () => {
    const path = '/repositories/1/commits';
    const commitsFrom = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        rawCommit({ sha: (from + i).toString(16).padStart(40, '0') }),
      );
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json(commitsFrom(1, ACTIVITY_PAGE_SIZE), { headers: { link: link(path, 2) } }),
      // The last page has no `rel="next"`, and fewer than 100 entries.
      [`GET ${GH}${path}`]: () => Response.json(commitsFrom(ACTIVITY_PAGE_SIZE + 1, 50)),
    });

    const first = await loadCommitPage(TEST_TOKEN, TARGET, null);
    expect(first.items).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(first.next.kind).toBe('more');
    const cursor = first.next.kind === 'more' ? first.next.cursor : null;

    const last = await loadCommitPage(TEST_TOKEN, TARGET, cursor);

    expect(last.items).toHaveLength(50);
    expect(last.items[0]?.sha).toBe((ACTIVITY_PAGE_SIZE + 1).toString(16).padStart(40, '0'));
    expect(last.items[49]?.sha).toBe((ACTIVITY_PAGE_SIZE + 50).toString(16).padStart(40, '0'));
    expect(last.skipped).toBe(0);
    expect(last.next).toEqual({ kind: 'end' });
  });

  it("follows GitHub's next URL exactly, so per_page and sha stay as GitHub gave them", async () => {
    const path = '/repositories/1/commits';
    // What GitHub builds from the first request's query, with the branch name encoded.
    const nextUrl = `${GH}${path}?per_page=100&sha=release%2Fv1&page=2`;
    const net = stubNetwork({
      [`GET ${GH}/repos/octo/alpha/commits`]: () =>
        Response.json([rawCommit()], { headers: { link: `<${nextUrl}>; rel="next"` } }),
      [`GET ${GH}${path}`]: () => Response.json([]),
    });
    const target = { ...TARGET, branch: 'release/v1' };

    const first = await loadCommitPage(TEST_TOKEN, target, null);
    const firstUrl = net.requests[0]?.url;
    expect(firstUrl?.searchParams.get('per_page')).toBe(String(ACTIVITY_PAGE_SIZE));
    expect(firstUrl?.searchParams.get('sha')).toBe('release/v1');
    const cursor = first.next.kind === 'more' ? first.next.cursor : null;
    expect(cursor?.nextUrl).toBe(nextUrl);

    await loadCommitPage(TEST_TOKEN, target, cursor);

    // The later page is requested at GitHub's URL as given: nothing is rebuilt, added or dropped.
    const followed = net.requests[1]?.url;
    expect(followed?.href).toBe(nextUrl);
    expect(followed?.searchParams.get('per_page')).toBe('100');
    expect(followed?.searchParams.get('sha')).toBe('release/v1');
    expect(followed?.searchParams.get('page')).toBe('2');
    expect([...(followed?.searchParams.keys() ?? [])]).toEqual(['per_page', 'sha', 'page']);
  });
});

describe('loadCommitPage failures', () => {
  const failWith = (response: () => Response) =>
    stubNetwork({ [`GET ${GH}/repos/octo/alpha/commits`]: response });

  it('reports a 401 as unauthorized', async () => {
    failWith(() => new Response('{}', { status: 401 }));
    await expect(loadCommitPage(TEST_TOKEN, TARGET, null)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('reports a 403 as forbidden', async () => {
    failWith(() => new Response('{}', { status: 403 }));
    await expect(loadCommitPage(TEST_TOKEN, TARGET, null)).rejects.toMatchObject({
      kind: 'forbidden',
    });
  });

  it.each([404, 409, 500])('reports a %i with its status', async (status) => {
    failWith(() => new Response('{}', { status }));
    await expect(loadCommitPage(TEST_TOKEN, TARGET, null)).rejects.toMatchObject({
      kind: 'http',
      status,
    });
  });

  it('reports an exhausted rate limit with its reset time', async () => {
    failWith(
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
        }),
    );
    await expect(loadCommitPage(TEST_TOKEN, TARGET, null)).rejects.toMatchObject({
      kind: 'rate_limited',
      resetAt: 1_800_000_000_000,
    });
  });

  it('reports a response that is not a list as invalid', async () => {
    failWith(() => Response.json({ message: 'nope' }));
    await expect(loadCommitPage(TEST_TOKEN, TARGET, null)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });

  it('reports a network failure', async () => {
    failWith(() => {
      throw new TypeError('offline');
    });
    await expect(loadCommitPage(TEST_TOKEN, TARGET, null)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it.each([
    ['an owner with a slash', { owner: 'a/b', name: 'alpha' }],
    ['a repository named ..', { owner: 'octo', name: '..' }],
    ['an empty owner', { owner: '', name: 'alpha' }],
    ['a name with a query', { owner: 'octo', name: 'alpha?x=1' }],
  ])('sends nothing for %s', async (_label, repo) => {
    const net = stubNetwork({});
    await expect(
      loadCommitPage(TEST_TOKEN, { ...repo, branch: 'main' }, null),
    ).rejects.toBeInstanceOf(GitHubApiError);
    await expect(loadBranchPage(TEST_TOKEN, repo, null)).rejects.toBeInstanceOf(GitHubApiError);
    expect(net.requests).toHaveLength(0);
  });
});

describe('loadBranchPage', () => {
  const REPO = { owner: 'octo', name: 'alpha' };

  it('asks for 100 branches with a GET', async () => {
    const net = stubNetwork({ [`GET ${GH}/repos/octo/alpha/branches`]: () => Response.json([]) });

    await loadBranchPage(TEST_TOKEN, REPO, null);

    const request = net.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.url.pathname).toBe('/repos/octo/alpha/branches');
    expect(request?.url.searchParams.get('per_page')).toBe('100');
  });

  it('keeps the name, head sha and protection, and makes names display-safe', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/branches`]: () =>
        Response.json([
          rawBranch('main', { protected: true }),
          rawBranch('feat/\u202Eevil'),
          rawBranch('no-flag', { protected: undefined }),
        ]),
    });

    const page = await loadBranchPage(TEST_TOKEN, REPO, null);

    expect(page.items).toEqual([
      { name: 'main', headSha: SHA, isProtected: true },
      { name: 'feat/\uFFFDevil', headSha: SHA, isProtected: false },
      { name: 'no-flag', headSha: SHA, isProtected: null },
    ]);
  });

  it('skips and counts entries that cannot be read', async () => {
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/branches`]: () =>
        Response.json([rawBranch('main'), { name: '' }, { name: 'x', commit: { sha: 'zz' } }]),
    });

    const page = await loadBranchPage(TEST_TOKEN, REPO, null);

    expect(page.items).toHaveLength(1);
    expect(page.skipped).toBe(2);
  });

  it('pages and stops at its own cap', async () => {
    const path = '/repositories/1/branches';
    stubNetwork({
      [`GET ${GH}/repos/octo/alpha/branches`]: () =>
        Response.json([rawBranch('a')], { headers: { link: link(path, 2) } }),
      [`GET ${GH}${path}`]: () => Response.json([], { headers: { link: link(path, 99) } }),
    });

    const first = await loadBranchPage(TEST_TOKEN, REPO, null);
    expect(first.next.kind).toBe('more');

    const last: PageCursor = { nextUrl: `${GH}${path}?page=5`, page: MAX_BRANCH_PAGES };
    expect((await loadBranchPage(TEST_TOKEN, REPO, last)).next).toEqual({ kind: 'capped' });
  });

  it('reports a response that is not a list as invalid', async () => {
    stubNetwork({ [`GET ${GH}/repos/octo/alpha/branches`]: () => Response.json({}) });
    await expect(loadBranchPage(TEST_TOKEN, REPO, null)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});
