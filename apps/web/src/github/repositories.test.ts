import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, fakeRepo, type Handler } from '../testing/fakeFetch.ts';
import {
  loadRepositoryPage,
  safeGitHubHtmlUrl,
  toRepositoryItem,
  type RepositoryPage,
} from './repositories.ts';

const GH = 'https://api.github.com';

afterEach(() => {
  vi.unstubAllGlobals();
});

function installations(...ids: number[]): Handler {
  return () =>
    Response.json({
      total_count: ids.length,
      installations: ids.map((id) => ({ id, account: { login: `acct-${String(id)}` } })),
    });
}

function repos(list: Record<string, unknown>[], nextPage?: string): Handler {
  return () =>
    Response.json(
      { total_count: list.length, repositories: list },
      nextPage ? { headers: { Link: `<${nextPage}>; rel="next"` } } : {},
    );
}

describe('loadRepositoryPage', () => {
  it('lists installations first, then the repositories of each, and only reads', async () => {
    const net = createFakeFetch({
      [`GET ${GH}/user/installations`]: installations(7),
      [`GET ${GH}/user/installations/7/repositories`]: repos([
        fakeRepo(1, 'alpha', { description: 'First', private: true }),
      ]),
    });
    vi.stubGlobal('fetch', net.fetch);

    const page = await loadRepositoryPage(TEST_TOKEN, null);

    expect(page.cursor).toBeNull();
    expect(page.skipped).toBe(0);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: 1,
      name: 'alpha',
      fullName: 'octo/alpha',
      owner: 'octo',
      ownerType: 'User',
      isPrivate: true,
      visibility: 'private',
      description: 'First',
      url: 'https://github.com/octo/alpha',
    });
    expect(net.requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      'GET /user/installations',
      'GET /user/installations/7/repositories',
    ]);
    expect(
      net.requests.every((r) => r.headers.get('authorization') === `Bearer ${TEST_TOKEN}`),
    ).toBe(true);
  });

  it('returns an empty, finished page when the App is installed nowhere', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({ [`GET ${GH}/user/installations`]: installations() }).fetch,
    );
    expect(await loadRepositoryPage(TEST_TOKEN, null)).toEqual({
      items: [],
      skipped: 0,
      cursor: null,
    });
  });

  it('paginates within one installation using the Link header', async () => {
    const net = createFakeFetch({
      [`GET ${GH}/user/installations`]: installations(7),
      [`GET ${GH}/user/installations/7/repositories`]: (req) =>
        req.url.searchParams.get('page') === '2'
          ? repos([fakeRepo(3, 'gamma')])(req)
          : repos(
              [fakeRepo(1, 'alpha'), fakeRepo(2, 'beta')],
              `${GH}/user/installations/7/repositories?per_page=100&page=2`,
            )(req),
    });
    vi.stubGlobal('fetch', net.fetch);

    const first = await loadRepositoryPage(TEST_TOKEN, null);
    expect(first.items.map((i) => i.name)).toEqual(['alpha', 'beta']);
    expect(first.cursor).not.toBeNull();

    const second = await loadRepositoryPage(TEST_TOKEN, first.cursor);
    expect(second.items.map((i) => i.name)).toEqual(['gamma']);
    expect(second.cursor).toBeNull();
    // The installation list is fetched once, not again for page two.
    expect(net.requests.filter((r) => r.url.pathname === '/user/installations')).toHaveLength(1);
  });

  it('moves on to the next installation, skipping ones with no repositories', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`GET ${GH}/user/installations`]: installations(1, 2, 3),
        [`GET ${GH}/user/installations/1/repositories`]: repos([fakeRepo(10, 'one')]),
        [`GET ${GH}/user/installations/2/repositories`]: repos([]),
        [`GET ${GH}/user/installations/3/repositories`]: repos([fakeRepo(30, 'three')]),
      }).fetch,
    );

    const first = await loadRepositoryPage(TEST_TOKEN, null);
    expect(first.items.map((i) => i.name)).toEqual(['one']);
    expect(first.cursor).not.toBeNull();

    const second = await loadRepositoryPage(TEST_TOKEN, first.cursor);
    expect(second.items.map((i) => i.name)).toEqual(['three']);
    expect(second.cursor).toBeNull();
  });

  it('does not report a finished list when the empty-installation hop limit is hit', async () => {
    // 50 consecutive installations with no repositories, then a 51st that has one.
    const ids = Array.from({ length: 51 }, (_unused, index) => index + 1);
    const routes: Record<string, Handler> = {
      [`GET ${GH}/user/installations`]: installations(...ids),
    };
    for (const id of ids) {
      routes[`GET ${GH}/user/installations/${String(id)}/repositories`] =
        id === 51 ? repos([fakeRepo(510, 'last')]) : repos([]);
    }
    const net = createFakeFetch(routes);
    vi.stubGlobal('fetch', net.fetch);

    const first = await loadRepositoryPage(TEST_TOKEN, null);
    expect(first.items).toEqual([]);
    expect(first.skipped).toBe(0);
    // Not `null`: installation 51 has not been read yet, so the list is not finished.
    expect(first.cursor).toEqual({ remainingInstallations: [51], nextUrl: null });
    expect(net.requests.filter((r) => r.url.pathname.endsWith('/repositories'))).toHaveLength(50);

    // Resuming from that cursor reads the rest without listing installations again.
    const second = await loadRepositoryPage(TEST_TOKEN, first.cursor);
    expect(second.items.map((i) => i.name)).toEqual(['last']);
    expect(second.cursor).toBeNull();
    expect(net.requests.filter((r) => r.url.pathname === '/user/installations')).toHaveLength(1);
  });

  it('never follows a next link to another host', async () => {
    const net = createFakeFetch({
      [`GET ${GH}/user/installations`]: installations(7),
      [`GET ${GH}/user/installations/7/repositories`]: repos(
        [fakeRepo(1, 'alpha')],
        'https://evil.example/steal',
      ),
    });
    vi.stubGlobal('fetch', net.fetch);
    const page: RepositoryPage = await loadRepositoryPage(TEST_TOKEN, null);
    expect(page.cursor).toBeNull();
    expect(net.requests.every((r) => r.url.origin === GH)).toBe(true);
  });

  it('propagates API errors', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`GET ${GH}/user/installations`]: () => new Response('{}', { status: 401 }),
      }).fetch,
    );
    await expect(loadRepositoryPage(TEST_TOKEN, null)).rejects.toMatchObject({
      kind: 'unauthorized',
    });
  });

  it('rejects a response that breaks the shared contract', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({ [`GET ${GH}/user/installations`]: () => Response.json({ nope: true }) })
        .fetch,
    );
    await expect(loadRepositoryPage(TEST_TOKEN, null)).rejects.toMatchObject({
      kind: 'invalid_response',
    });
  });
});

describe('repository fields from GitHub', () => {
  async function loadOne(repo: Record<string, unknown>) {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`GET ${GH}/user/installations`]: installations(7),
        [`GET ${GH}/user/installations/7/repositories`]: repos([repo]),
      }).fetch,
    );
    const page = await loadRepositoryPage(TEST_TOKEN, null);
    const item = page.items[0];
    if (!item) throw new Error('expected one repository');
    return item;
  }

  it('maps language, stars, dates, owner type and the detail fields', async () => {
    const item = await loadOne(
      fakeRepo(1, 'alpha', {
        owner: { login: 'acme', type: 'Organization' },
        language: 'TypeScript',
        stargazers_count: 12,
        forks_count: 3,
        open_issues_count: 4,
        updated_at: '2026-03-01T10:00:00Z',
        pushed_at: '2026-02-01T10:00:00Z',
        fork: true,
        archived: false,
        default_branch: 'main',
        topics: ['graph', 'viz'],
      }),
    );
    expect(item).toMatchObject({
      ownerType: 'Organization',
      language: 'TypeScript',
      stars: 12,
      forks: 3,
      openIssues: 4,
      updatedAt: '2026-03-01T10:00:00Z',
      pushedAt: '2026-02-01T10:00:00Z',
      isFork: true,
      isArchived: false,
      defaultBranch: 'main',
      topics: ['graph', 'viz'],
    });
  });

  it('reports missing optional data as absent, never as zero or a guess', async () => {
    const item = await loadOne({
      id: 1,
      name: 'bare',
      full_name: 'octo/bare',
      private: false,
      html_url: 'https://github.com/octo/bare',
      owner: { login: 'octo' },
    });
    expect(item).toMatchObject({
      ownerType: null,
      language: null,
      stars: null,
      forks: null,
      openIssues: null,
      updatedAt: null,
      pushedAt: null,
      isFork: null,
      isArchived: null,
      defaultBranch: null,
      topics: [],
    });
  });

  it('treats a null or blank language as "no language", and a bad date as absent', async () => {
    expect((await loadOne(fakeRepo(1, 'a', { language: null }))).language).toBeNull();
    expect((await loadOne(fakeRepo(1, 'a', { language: '  ' }))).language).toBeNull();
    expect((await loadOne(fakeRepo(1, 'a', { updated_at: 'yesterday-ish' }))).updatedAt).toBeNull();
  });

  it('derives visibility from `private`, adding only the "internal" case from `visibility`', async () => {
    expect((await loadOne(fakeRepo(1, 'a', { private: false }))).visibility).toBe('public');
    expect((await loadOne(fakeRepo(1, 'a', { private: true }))).visibility).toBe('private');
    const internal = await loadOne(fakeRepo(1, 'a', { private: true, visibility: 'internal' }));
    expect(internal.visibility).toBe('internal');
    expect(internal.isPrivate).toBe(true);
    // `private: false` wins over an inconsistent `visibility: "private"`.
    expect(
      (await loadOne(fakeRepo(1, 'a', { private: false, visibility: 'private' }))).visibility,
    ).toBe('public');
  });

  it('keeps the readable repositories and reports how many entries it had to skip', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`GET ${GH}/user/installations`]: installations(7),
        [`GET ${GH}/user/installations/7/repositories`]: repos([
          fakeRepo(1, 'alpha'),
          { surprise: true },
          fakeRepo(3, 'gamma'),
        ]),
      }).fetch,
    );
    const page = await loadRepositoryPage(TEST_TOKEN, null);
    expect(page.items.map((i) => i.name)).toEqual(['alpha', 'gamma']);
    expect(page.skipped).toBe(1);
  });
});

describe('safeGitHubHtmlUrl / toRepositoryItem', () => {
  it.each([
    'javascript:alert(1)',
    'http://github.com/a/b',
    'https://evil.example/a/b',
    'https://github.com.evil.example/a',
    'not a url',
  ])('drops the link for %s', (value) => {
    expect(safeGitHubHtmlUrl(value)).toBeNull();
  });

  it('keeps a genuine github.com link and treats a missing description as null', () => {
    expect(safeGitHubHtmlUrl('https://github.com/octo/alpha')).toBe(
      'https://github.com/octo/alpha',
    );
    const item = toRepositoryItem({
      id: 1,
      name: 'a',
      full_name: 'octo/a',
      private: false,
      description: undefined,
      html_url: 'javascript:alert(1)',
      owner: { login: 'octo' },
    });
    expect(item.description).toBeNull();
    expect(item.url).toBeNull();
  });
});
