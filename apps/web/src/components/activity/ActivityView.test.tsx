import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryItem } from '../../github/repositories.ts';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../../testing/fakeFetch.ts';
import { ActivityView } from './ActivityView.tsx';

const GH = 'https://api.github.com';
const COMMITS = `GET ${GH}/repos/octo/alpha/commits`;
const BRANCHES = `GET ${GH}/repos/octo/alpha/branches`;
const COMMITS_PAGE_2 = `GET ${GH}/repositories/1/commits`;
const onUnauthorized = vi.fn();
const onBack = vi.fn();

const repo: RepositoryItem = {
  id: 1,
  name: 'alpha',
  fullName: 'octo/alpha',
  owner: 'octo',
  isPrivate: false,
  description: null,
  url: 'https://github.com/octo/alpha',
  ownerType: 'User',
  visibility: 'public',
  language: null,
  stars: null,
  forks: null,
  openIssues: null,
  updatedAt: null,
  pushedAt: null,
  isFork: false,
  isArchived: false,
  defaultBranch: 'main',
  topics: [],
};

const sha = (n: number) => String(n).padStart(2, '0').repeat(20);

function commit(n: number, over: Record<string, unknown> = {}) {
  return {
    sha: sha(n),
    commit: {
      message: `Subject ${String(n)}\n\nA long body that must never be kept.`,
      author: {
        name: `Author ${String(n)}`,
        email: `private-${String(n)}@example.test`,
        date: `2026-10-${String(10 + n).padStart(2, '0')}T12:00:00Z`,
      },
      committer: { name: 'GitHub', email: 'noreply@github.com' },
    },
    author: { login: `login${String(n)}`, id: 5 },
    parents: [{ sha: sha(900 + n) }],
    ...over,
  };
}

const branch = (name: string, isProtected = false) => ({
  name,
  commit: { sha: sha(name.length), url: 'ignored' },
  protected: isProtected,
});

const next = (url: string) => ({ headers: { Link: `<${url}>; rel="next"` } });

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [COMMITS]: () =>
      Response.json([commit(1), commit(2, { parents: [{ sha: 'a' }, { sha: 'b' }] })]),
    [BRANCHES]: () => Response.json([branch('main', true), branch('dev')]),
    ...overrides,
  };
}

function open(overrides: Record<string, Handler> = {}) {
  const net = createFakeFetch(routes(overrides));
  vi.stubGlobal('fetch', net.fetch);
  render(
    <ActivityView
      repo={repo}
      accessToken={TEST_TOKEN}
      onUnauthorized={onUnauthorized}
      onBack={onBack}
    />,
  );
  return net;
}

const commitsPanel = () => screen.getByRole('region', { name: 'Commits' });
const branchesPanel = () => screen.getByRole('region', { name: 'Branches' });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onUnauthorized.mockClear();
  onBack.mockClear();
});

describe('ActivityView', () => {
  it('loads commits and branches and shows them as tables and a timeline', async () => {
    const net = open();

    expect(await screen.findByText('Complete · 2 commits loaded')).toBeTruthy();
    expect(await screen.findByText('Complete · 2 branches loaded')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'octo/alpha · Activity' }),
    );

    const commits = within(commitsPanel()).getByRole('table');
    expect(within(commits).getByText('Subject 1')).toBeTruthy();
    expect(within(commits).getByText('Author 1 (login1)')).toBeTruthy();
    expect(within(commits).getByText('0101010')).toBeTruthy();
    // Only the second commit has two parents.
    const badges = commits.querySelectorAll('tbody .badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe('Merge');

    const branches = within(branchesPanel()).getByRole('table');
    expect(within(branches).getByText('main')).toBeTruthy();
    expect(within(branches).getByText('Default')).toBeTruthy();
    expect(within(branches).getByText('Yes')).toBeTruthy();

    expect(
      screen.getByRole('img', { name: /only the commits that have been loaded/i }),
    ).toBeTruthy();
    expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
    expect(net.requests.map((r) => r.url.pathname).sort()).toEqual([
      '/repos/octo/alpha/branches',
      '/repos/octo/alpha/commits',
    ]);
    expect(net.requests.find((r) => r.url.pathname.endsWith('/commits'))?.url.search).toContain(
      'sha=main',
    );
  });

  it('never shows message bodies or email addresses', async () => {
    open();
    await screen.findByText('Complete · 2 commits loaded');
    expect(document.body.textContent).not.toContain('long body');
    expect(document.body.textContent).not.toContain('example.test');
    expect(document.body.textContent).not.toContain('noreply');
  });

  it('shows untrusted text as plain text', async () => {
    open({
      [COMMITS]: () =>
        Response.json([
          commit(1, {
            commit: {
              message: '<img src=x onerror=alert(1)>',
              author: { name: '<b>bold</b>', date: '2026-10-01T00:00:00Z' },
            },
          }),
        ]),
      [BRANCHES]: () => Response.json([branch('<script>x</script>')]),
    });
    await screen.findByText('Complete · 1 commit loaded');

    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByText(/<b>bold<\/b>/)).toBeTruthy();
    expect(screen.getByText('<script>x</script>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('says Partial, never a total, while older commits remain', async () => {
    open({
      [COMMITS]: () => Response.json([commit(1)], next(`${GH}/repositories/1/commits?page=2`)),
    });

    expect(await screen.findByText('Partial · 1 commit loaded')).toBeTruthy();
    expect(within(commitsPanel()).getByText(/Older commits have not been loaded/)).toBeTruthy();
    expect(within(commitsPanel()).queryByText(/Complete/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Load older commits' })).toBeTruthy();
  });

  it('loads older commits only when asked, and appends them', async () => {
    const net = open({
      [COMMITS]: () => Response.json([commit(1)], next(`${GH}/repositories/1/commits?page=2`)),
      [COMMITS_PAGE_2]: () => Response.json([commit(2)]),
    });
    await screen.findByText('Partial · 1 commit loaded');
    expect(net.requests.filter((r) => r.url.pathname.includes('commits'))).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }));

    expect(await screen.findByText('Complete · 2 commits loaded')).toBeTruthy();
    const table = within(commitsPanel()).getByRole('table');
    expect(within(table).getByText('Subject 1')).toBeTruthy();
    expect(within(table).getByText('Subject 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load older commits' })).toBeNull();
  });

  it('keeps loaded commits when an older page fails, and retries the same page', async () => {
    let attempts = 0;
    const net = open({
      [COMMITS]: () => Response.json([commit(1)], next(`${GH}/repositories/1/commits?page=2`)),
      [COMMITS_PAGE_2]: () => {
        attempts += 1;
        return attempts === 1 ? new Response('{}', { status: 500 }) : Response.json([commit(2)]);
      },
    });
    await screen.findByText('Partial · 1 commit loaded');

    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }));
    const alert = await within(commitsPanel()).findByRole('alert');
    expect(alert.textContent).toContain('What was already loaded is still shown.');
    expect(screen.getByText('Partial, with an error · 1 commit loaded')).toBeTruthy();
    expect(within(commitsPanel()).getByText('Subject 1')).toBeTruthy();
    // Nothing retried by itself.
    expect(attempts).toBe(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Complete · 2 commits loaded')).toBeTruthy();
    expect(attempts).toBe(2);
    expect(net.requests.filter((r) => r.url.pathname === '/repositories/1/commits')).toHaveLength(
      2,
    );
  });

  it('fails commits and branches independently', async () => {
    let attempts = 0;
    const net = open({
      [COMMITS]: () => {
        attempts += 1;
        return attempts === 1
          ? new Response('{}', { status: 500 })
          : Response.json([commit(1), commit(2)]);
      },
    });

    const alert = await within(await screen.findByRole('region', { name: 'Commits' })).findByRole(
      'alert',
    );
    expect(alert.textContent).toContain('unexpected response');
    expect(screen.getByText('Failed')).toBeTruthy();
    // The branches are unaffected.
    expect(await screen.findByText('Complete · 2 branches loaded')).toBeTruthy();
    expect(within(branchesPanel()).getByRole('table')).toBeTruthy();
    expect(net.requests.filter((r) => r.url.pathname.endsWith('/commits'))).toHaveLength(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    // Only commits are asked for again.
    expect(await screen.findByText('Complete · 2 commits loaded')).toBeTruthy();
    expect(net.requests.filter((r) => r.url.pathname.endsWith('/branches'))).toHaveLength(1);
  });

  it('lets branches fail while commits are shown', async () => {
    open({ [BRANCHES]: () => new Response('{}', { status: 403 }) });

    expect(await screen.findByText('Complete · 2 commits loaded')).toBeTruthy();
    const alert = await within(await screen.findByRole('region', { name: 'Branches' })).findByRole(
      'alert',
    );
    expect(alert.textContent).toContain('refused access');
    // Not worth asking again.
    expect(within(alert).queryByRole('button')).toBeNull();
  });

  it('shows an empty repository as empty, not as an error', async () => {
    open({ [COMMITS]: () => new Response('{}', { status: 409 }) });

    expect(await screen.findByText('Empty')).toBeTruthy();
    expect(within(commitsPanel()).getByText(/repository is empty/)).toBeTruthy();
    expect(within(commitsPanel()).queryByRole('alert')).toBeNull();
  });

  it('counts entries it could not read and says the list is incomplete', async () => {
    open({
      [COMMITS]: () => Response.json([commit(1), { sha: 'nope' }, 42]),
    });

    expect(await screen.findByText('Partial · 1 commit loaded')).toBeTruthy();
    expect(
      within(commitsPanel()).getByText(/2 commits in GitHub's response could not be read/),
    ).toBeTruthy();
  });

  it('ends the session exactly once when GitHub rejects the token for both lists', async () => {
    open({
      [COMMITS]: () => new Response('{}', { status: 401 }),
      [BRANCHES]: () => new Response('{}', { status: 401 }),
    });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('session has ended');
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('region', { name: 'Commits' })).toBeNull();
  });

  it('offers no retry while a rate limit is in force', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    open({
      [COMMITS]: () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        }),
    });

    const alert = await within(await screen.findByRole('region', { name: 'Commits' })).findByRole(
      'alert',
    );
    expect(alert.textContent).toMatch(/rate limit/i);
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(commitsPanel()).getByText(/rate limit is used up/)).toBeTruthy();
  });

  it('goes back when asked', async () => {
    open();
    await screen.findByText('Complete · 2 commits loaded');
    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe('ActivityView with full pages of commits', () => {
  const PAGE_URL = `${GH}/repositories/1/commits`;
  const bulkSha = (n: number) => n.toString(16).padStart(40, '0');
  /** Commits numbered `from` to `from + count - 1`, an hour apart in 2025, so every date is usable. */
  const bulkCommits = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => {
      const n = from + i;
      return {
        sha: bulkSha(n),
        commit: {
          message: `Subject ${String(n)}`,
          author: {
            name: 'Author',
            date: new Date(Date.UTC(2025, 0, 1) + n * 3_600_000).toISOString(),
          },
        },
        author: { login: 'login' },
        parents: [{ sha: bulkSha(n + 100_000) }],
      };
    });

  /**
   * GitHub's paging: the first page comes from the repository route, later pages from the `Link`
   * URLs, which carry `per_page`, `sha` and `page`. Every page has 100 commits except the last.
   * `served` records which page numbers were asked for; a page past the last one is an error.
   */
  function pagedCommits(options: { pages: number; lastSize: number; nextOnLast: boolean }) {
    const served: number[] = [];
    const respond = (page: number): Response => {
      const size = page === options.pages ? options.lastSize : 100;
      const body = bulkCommits((page - 1) * 100 + 1, size);
      return page < options.pages || options.nextOnLast
        ? Response.json(body, next(`${PAGE_URL}?per_page=100&sha=main&page=${String(page + 1)}`))
        : Response.json(body);
    };
    const routes: Record<string, Handler> = {
      [COMMITS]: () => {
        served.push(1);
        return respond(1);
      },
      [COMMITS_PAGE_2]: ({ url }) => {
        const page = Number(url.searchParams.get('page'));
        served.push(page);
        return page > options.pages ? new Response('{}', { status: 500 }) : respond(page);
      },
    };
    return { routes, served };
  }

  // Up to 500 table rows are drawn after each page, so these wait longer than the others.
  const SLOW = { timeout: 10_000 };
  const loadOlder = () => {
    fireEvent.click(screen.getByText('Load older commits'));
  };
  const rowsOf = (panel: HTMLElement) => panel.querySelectorAll('tbody tr');

  it('is Complete when a short final page follows full pages, and every page is appended', async () => {
    const { routes, served } = pagedCommits({ pages: 3, lastSize: 50, nextOnLast: false });
    open(routes);

    expect(await screen.findByText('Partial · 100 commits loaded', {}, SLOW)).toBeTruthy();
    loadOlder();
    expect(await screen.findByText('Partial · 200 commits loaded', {}, SLOW)).toBeTruthy();
    loadOlder();
    expect(await screen.findByText('Complete · 250 commits loaded', {}, SLOW)).toBeTruthy();

    const panel = commitsPanel();
    expect(rowsOf(panel)).toHaveLength(250);
    expect(within(panel).getByText('Subject 1')).toBeTruthy();
    expect(within(panel).getByText('Subject 100')).toBeTruthy();
    expect(within(panel).getByText('Subject 101')).toBeTruthy();
    expect(within(panel).getByText('Subject 250')).toBeTruthy();
    // Nothing is missing, so there is no warning and nothing more to load.
    expect(within(panel).queryByText(/have not been loaded/)).toBeNull();
    expect(within(panel).queryByText(/Loading stops at/)).toBeNull();
    expect(screen.queryByText('Load older commits')).toBeNull();
    expect(served).toEqual([1, 2, 3]);
  }, 30_000);

  it('stops at 500 commits when page 5 still has a next link: warns, offers no more, asks for no sixth page', async () => {
    const { routes, served } = pagedCommits({ pages: 5, lastSize: 100, nextOnLast: true });
    const net = open(routes);

    expect(await screen.findByText('Partial · 100 commits loaded', {}, SLOW)).toBeTruthy();
    for (const loaded of [200, 300, 400, 500]) {
      loadOlder();
      expect(
        await screen.findByText(`Partial · ${String(loaded)} commits loaded`, {}, SLOW),
      ).toBeTruthy();
    }

    const panel = commitsPanel();
    // The cap: the warning is shown, and it is the only reason the list is partial.
    expect(
      within(panel).getByText(
        'Loading stops at 500 commits, and GitHub has more. The rest cannot be loaded here.',
      ),
    ).toBeTruthy();
    expect(within(panel).queryByText(/Older commits have not been loaded/)).toBeNull();
    expect(within(panel).queryByText(/Complete/)).toBeNull();
    expect(
      within(panel).getByText(/Older commits are not loaded, so earlier activity/),
    ).toBeTruthy();
    // No way to ask for more: no "Load older commits" button, or any other button in the panel.
    expect(screen.queryByText('Load older commits')).toBeNull();
    expect(screen.queryByText('Loading older commits…')).toBeNull();
    expect(panel.querySelectorAll('button')).toHaveLength(0);
    // Every page was appended, in order.
    expect(rowsOf(panel)).toHaveLength(500);
    expect(within(panel).getByText('Subject 1')).toBeTruthy();
    expect(within(panel).getByText('Subject 500')).toBeTruthy();

    // Exactly five commit requests; the later ones followed GitHub's URLs with their query.
    expect(served).toEqual([1, 2, 3, 4, 5]);
    const commitRequests = net.requests.filter((r) => r.url.pathname.endsWith('/commits'));
    expect(commitRequests).toHaveLength(5);
    expect(commitRequests.map((r) => r.url.searchParams.get('page'))).toEqual([
      null,
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(
      commitRequests.every(
        (r) =>
          r.url.searchParams.get('per_page') === '100' && r.url.searchParams.get('sha') === 'main',
      ),
    ).toBe(true);
  }, 60_000);
});
