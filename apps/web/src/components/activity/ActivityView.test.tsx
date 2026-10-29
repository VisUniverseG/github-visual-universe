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

    // The same merge is a diamond in the graph.
    expect(document.querySelectorAll('svg.graph-svg polygon.graph-node')).toHaveLength(1);

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

describe('ActivityView history graph', () => {
  /** A commit whose parents are the commits numbered `parents` (so they can be loaded too). */
  const linked = (n: number, parents: readonly number[]) =>
    commit(n, { parents: parents.map((parent) => ({ sha: sha(parent) })) });
  const graphOf = () =>
    within(commitsPanel()).getByRole('region', { name: 'Scrollable history graph' });
  const plot = () => graphOf().querySelector('svg.graph-svg');

  it('draws the loaded commits as a graph above the table, and a merge as a diamond', async () => {
    open({
      [COMMITS]: () =>
        Response.json([linked(1, [2, 3]), linked(2, [4]), linked(3, [4]), linked(4, [])]),
    });
    expect(await screen.findByText('Complete · 4 commits loaded')).toBeTruthy();

    const panel = commitsPanel();
    expect(within(panel).getByRole('heading', { name: 'History graph' })).toBeTruthy();
    expect(plot()?.querySelectorAll('text.graph-label')).toHaveLength(4);
    expect(plot()?.querySelectorAll('polygon.graph-node')).toHaveLength(1);
    expect(plot()?.querySelectorAll('rect.graph-node')).toHaveLength(1);
    // Complete, with every parent loaded: nothing to explain.
    expect(panel.querySelector('.graph-notes')).toBeNull();
    // The graph sits before the table, and the timeline keeps its own, different, name.
    const table = within(panel).getByRole('table');
    expect(
      graphOf().compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole('img').map((image) => image.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/only the commits that have been loaded/i),
      expect.stringContaining('History graph of 4 loaded commits'),
    ]);
  });

  it('lists the same links as text in the Parents column, each state apart', async () => {
    open({
      [COMMITS]: () =>
        Response.json([
          linked(1, [2]),
          linked(2, [9]),
          linked(3, []),
          commit(4, { parents: undefined }),
          commit(5, { parents: [{}] }),
          linked(6, [1, 2]),
        ]),
    });
    await screen.findByText('Complete · 6 commits loaded');

    const rows = [...within(commitsPanel()).getByRole('table').querySelectorAll('tbody tr')];
    const parentsOf = (row: number) => rows[row]?.querySelectorAll('td')[3]?.textContent;
    expect(within(commitsPanel()).getByRole('columnheader', { name: 'Parents' })).toBeTruthy();
    expect(parentsOf(0)).toBe('0202020');
    expect(parentsOf(1)).toBe('0909090 (not loaded)');
    expect(parentsOf(2)).toBe('None (root commit)');
    expect(parentsOf(3)).toBe('Not stated');
    expect(parentsOf(4)).toBe('unreadable');
    // Both are listed above this commit: the graph draws no line to them, and the text says so.
    expect(parentsOf(5)).toBe('0101010 (listed above), 0202020 (listed above)');
  });

  it('says in the Parents column, and marks in the graph, a parent listed above its child', async () => {
    open({
      [COMMITS]: () =>
        Response.json([
          linked(1, []), // a root
          linked(2, [1]), // its parent is listed above it
          linked(3, [9]), // its parent is not loaded
          commit(4, { parents: [{}] }), // an unreadable parent
          linked(5, [5]), // its own parent
          linked(6, [7]), // an ordinary link to a commit below
          linked(7, []),
        ]),
    });
    await screen.findByText('Complete · 7 commits loaded');

    const rows = [...within(commitsPanel()).getByRole('table').querySelectorAll('tbody tr')];
    const parentsOf = (row: number) => rows[row]?.querySelectorAll('td')[3]?.textContent;
    expect(parentsOf(0)).toBe('None (root commit)');
    expect(parentsOf(1)).toBe('0101010 (listed above)');
    expect(parentsOf(2)).toBe('0909090 (not loaded)');
    expect(parentsOf(3)).toBe('unreadable');
    expect(parentsOf(4)).toBe('0505050 (itself)');
    expect(parentsOf(5)).toBe('0707070');

    // Exactly the two commits that list a parent above themselves carry the arrow and the outline.
    expect(plot()?.querySelectorAll('path.graph-above-mark')).toHaveLength(2);
    expect(plot()?.querySelectorAll('.graph-node-above')).toHaveLength(2);
    // No line was drawn to a parent above: only the not-loaded line and the ordinary one exist.
    expect(plot()?.querySelectorAll('path.graph-edge')).toHaveLength(2);
    expect(plot()?.querySelectorAll('path.graph-edge-open')).toHaveLength(1);
  });

  it('says what each unusual state means', async () => {
    open({
      [COMMITS]: () =>
        Response.json([
          linked(1, [9]),
          commit(2, { parents: undefined }),
          commit(3, { parents: [{}] }),
        ]),
    });
    await screen.findByText('Complete · 3 commits loaded');
    const notes = [...(commitsPanel().querySelectorAll('.graph-notes li') ?? [])].map(
      (note) => note.textContent,
    );
    expect(notes).toEqual([
      '1 dashed line leads to parent commits that are not among the loaded commits.',
      'GitHub did not say what the parents of 1 commit is, so no line leaves it.',
      '1 parent entry could not be read and has no line.',
    ]);
  });

  it('grows when older commits load, and joins the dashed line to its parent', async () => {
    const net = open({
      [COMMITS]: () => Response.json([linked(1, [2])], next(`${GH}/repositories/1/commits?page=2`)),
      [COMMITS_PAGE_2]: () => Response.json([linked(2, [])]),
    });
    await screen.findByText('Partial · 1 commit loaded');
    expect(plot()?.querySelectorAll('text.graph-label')).toHaveLength(1);
    expect(plot()?.querySelectorAll('path.graph-edge-open')).toHaveLength(1);
    expect(
      within(commitsPanel()).getByText(
        /not loaded yet\. They join up as older commits are loaded\./,
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }));
    await screen.findByText('Complete · 2 commits loaded');

    expect(plot()?.querySelectorAll('text.graph-label')).toHaveLength(2);
    expect(plot()?.querySelectorAll('path.graph-edge-open')).toHaveLength(0);
    expect(plot()?.querySelectorAll('path.graph-edge')).toHaveLength(1);
    expect(commitsPanel().querySelector('.graph-notes')).toBeNull();
    // Drawing the graph asks GitHub for nothing: the same two commit pages and the branches.
    expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
    expect(net.requests.map((r) => r.url.pathname).sort()).toEqual([
      '/repos/octo/alpha/branches',
      '/repos/octo/alpha/commits',
      '/repositories/1/commits',
    ]);
  });

  it('keeps the graph, and says the rest is missing, when an older page fails', async () => {
    open({
      [COMMITS]: () => Response.json([linked(1, [2])], next(`${GH}/repositories/1/commits?page=2`)),
      [COMMITS_PAGE_2]: () => new Response('{}', { status: 500 }),
    });
    await screen.findByText('Partial · 1 commit loaded');
    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }));
    await within(commitsPanel()).findByRole('alert');

    expect(plot()?.querySelectorAll('text.graph-label')).toHaveLength(1);
    expect(plot()?.querySelectorAll('path.graph-edge-open')).toHaveLength(1);
  });

  it('draws no graph for an empty list, an empty repository or a failed list', async () => {
    open({ [COMMITS]: () => Response.json([]) });
    await screen.findByText('Complete · 0 commits loaded');
    expect(screen.queryByRole('region', { name: 'Scrollable history graph' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'History graph' })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    open({ [COMMITS]: () => new Response('{}', { status: 409 }) });
    await screen.findByText('Empty');
    expect(screen.queryByRole('region', { name: 'Scrollable history graph' })).toBeNull();
    cleanup();
    vi.unstubAllGlobals();

    open({ [COMMITS]: () => new Response('{}', { status: 500 }) });
    await within(commitsPanel()).findByRole('alert');
    expect(screen.queryByRole('region', { name: 'Scrollable history graph' })).toBeNull();
  });

  it('shows a hostile subject in the graph as text only', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    open({
      [COMMITS]: () =>
        Response.json([
          commit(1, {
            commit: { message: hostile, author: { name: 'A', date: '2026-10-01T00:00:00Z' } },
          }),
        ]),
    });
    await screen.findByText('Complete · 1 commit loaded');
    expect(plot()?.querySelector('text.graph-label')?.textContent).toContain(hostile);
    expect(document.querySelector('img')).toBeNull();
    expect(plot()?.querySelector('[style]')).toBeNull();
    expect(document.querySelector('[style]')).toBeNull();
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
    // The graph has every commit, and no more is promised: its open lines are not "yet to load".
    expect(panel.querySelectorAll('svg.graph-svg text.graph-label')).toHaveLength(250);
    expect(within(panel).getByText(/not among the loaded commits\./)).toBeTruthy();
    expect(within(panel).queryByText(/join up as older commits are loaded/)).toBeNull();
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
    // The graph stops at the same 500 and explains its open lines by the limit, not by "later".
    expect(panel.querySelectorAll('svg.graph-svg text.graph-label')).toHaveLength(500);
    expect(within(panel).getByText(/beyond the loading limit/)).toBeTruthy();
    expect(within(panel).queryByText(/join up as older commits are loaded/)).toBeNull();

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
