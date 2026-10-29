import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryItem } from '../../github/repositories.ts';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../../testing/fakeFetch.ts';
import { ActivityView } from './ActivityView.tsx';
import { commitRowId } from './CommitTable.tsx';

const GH = 'https://api.github.com';
const COMMITS = `GET ${GH}/repos/octo/alpha/commits`;
const BRANCHES = `GET ${GH}/repos/octo/alpha/branches`;
const PULLS = `GET ${GH}/repos/octo/alpha/pulls`;
const PULLS_PAGE_2 = `GET ${GH}/repositories/1/pulls`;
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

const sha = (n: number) => n.toString(16).padStart(2, '0').repeat(20);

function commit(n: number, parents: readonly number[]) {
  return {
    sha: sha(n),
    commit: {
      message: `Subject ${String(n)}`,
      author: { name: `Author ${String(n)}`, date: '2026-10-10T12:00:00Z' },
    },
    author: { login: `login${String(n)}` },
    parents: parents.map((parent) => ({ sha: sha(parent) })),
  };
}

/**
 * Three merged pull requests, one for each way of merging, as the default branch shows them:
 * 1 = a merge commit (two parents), 2 = a squashed commit, 3 = the last rebased commit.
 */
const HISTORY = [commit(1, [2, 9]), commit(2, [3]), commit(3, [4]), commit(4, [])];

function pull(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'closed',
    title: `Pull request ${String(number)}`,
    draft: false,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-03T10:00:00Z',
    closed_at: '2026-10-03T10:00:00Z',
    merged_at: '2026-10-03T10:00:00Z',
    merge_commit_sha: sha(99),
    head: { ref: `feat/${String(number)}`, repo: { full_name: 'octo/alpha' } },
    base: { ref: 'main' },
    user: { login: `user${String(number)}` },
    ...over,
  };
}

const openPull = (number: number, over: Record<string, unknown> = {}) =>
  pull(number, {
    state: 'open',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    ...over,
  });

const next = (url: string) => ({ headers: { Link: `<${url}>; rel="next"` } });

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [COMMITS]: () => Response.json(HISTORY),
    [BRANCHES]: () => Response.json([]),
    [PULLS]: () => Response.json([openPull(1)]),
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

const pullsRequests = (net: ReturnType<typeof open>) =>
  net.requests.filter((request) => request.url.pathname.endsWith('/pulls'));
const panel = () => screen.getByRole('region', { name: 'Pull requests' });
const loadButton = () => screen.getByRole('button', { name: 'Load pull requests' });

/** Opens the view, waits for the commits, and presses "Load pull requests". */
async function openAndLoad(overrides: Record<string, Handler> = {}) {
  const net = open(overrides);
  // Wait until the commits have arrived (or failed), so links can be judged against them.
  await waitFor(() => {
    expect(screen.queryByText('Loading commits…')).toBeNull();
  });
  fireEvent.click(loadButton());
  return net;
}

const rowsOf = () => [...panel().querySelectorAll('tbody tr')];
const cellsOf = (row: Element | undefined) => [...(row?.querySelectorAll('td') ?? [])];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onUnauthorized.mockClear();
  onBack.mockClear();
});

describe('Pull requests panel: asking for data', () => {
  it('requests nothing until the reader presses the button', async () => {
    const net = open();
    await screen.findByText('Complete · 4 commits loaded');

    expect(within(panel()).getByRole('button', { name: 'Load pull requests' })).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();
    expect(pullsRequests(net)).toHaveLength(0);
    expect(net.requests.map((request) => request.url.pathname).sort()).toEqual([
      '/repos/octo/alpha/branches',
      '/repos/octo/alpha/commits',
    ]);
  });

  it('then makes one GET for the first page and moves focus to the panel heading', async () => {
    const net = await openAndLoad();
    expect(await screen.findByText('Complete · 1 pull request loaded')).toBeTruthy();

    const requests = pullsRequests(net);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: '100',
    });
    expect(document.activeElement).toBe(
      within(panel()).getByRole('heading', { name: 'Pull requests' }),
    );
    expect(
      net.requests.every((request) => request.method === 'GET' && request.url.origin === GH),
    ).toBe(true);
  });

  it('asks for nothing per pull request, and nothing in the background', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const net = await openAndLoad({
        [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(1) }), pull(2), openPull(3)]),
      });
      await screen.findByText('Complete · 3 pull requests loaded');
      const before = net.requests.length;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(net.requests).toHaveLength(before);
      expect(net.requests.map((request) => request.url.pathname).sort()).toEqual([
        '/repos/octo/alpha/branches',
        '/repos/octo/alpha/commits',
        '/repos/octo/alpha/pulls',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Pull requests panel: rows', () => {
  it('shows the state, branches, author and relevant date of open, draft, merged and closed pull requests', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          openPull(4),
          openPull(3, { draft: true }),
          pull(2),
          pull(1, { merged_at: null, closed_at: '2026-10-05T10:00:00Z' }),
        ]),
    });
    await screen.findByText('Complete · 4 pull requests loaded');

    const rows = rowsOf();
    expect(rows).toHaveLength(4);
    const badges = rows.map((row) => row.querySelector('.badge')?.textContent);
    expect(badges).toEqual(['Open', 'Draft', 'Merged', 'Closed']);

    // Title and number are the row header.
    expect(rows[0]?.querySelector('th')?.textContent).toBe('#4 Pull request 4');

    const [, branches, author, date] = cellsOf(rows[2]);
    expect([...(branches?.querySelectorAll('code') ?? [])].map((code) => code.textContent)).toEqual(
      ['main', 'feat/2'],
    );
    expect(branches?.textContent).toContain('←');
    expect(author?.textContent).toBe('user2');

    // Each state shows its own date.
    const dateOf = (row: number) => {
      const cell = cellsOf(rows[row])[2 + 1];
      return {
        label: cell?.querySelector('.note')?.textContent,
        iso: cell?.querySelector('time')?.getAttribute('datetime'),
      };
    };
    expect(dateOf(0)).toEqual({ label: 'Opened ', iso: '2026-10-01T10:00:00.000Z' });
    expect(dateOf(2)).toEqual({ label: 'Merged ', iso: '2026-10-03T10:00:00.000Z' });
    expect(dateOf(3)).toEqual({ label: 'Closed ', iso: '2026-10-05T10:00:00.000Z' });
    expect(date?.querySelector('time')).toBeTruthy();
  });

  it('copes with missing head, base, author, title and dates without inventing values', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          pull(1, {
            head: null,
            base: undefined,
            user: null,
            title: undefined,
            merged_at: 'not a date',
            merge_commit_sha: undefined,
          }),
          // A head repository that was deleted: the branch is still there.
          openPull(2, { head: { ref: 'ghost-branch', repo: null } }),
          openPull(3, { draft: undefined, created_at: null }),
        ]),
    });
    await screen.findByText('Complete · 3 pull requests loaded');
    const rows = rowsOf();

    const first = cellsOf(rows[0]);
    expect(rows[0]?.querySelector('th')?.textContent).toBe('#1 (no title)');
    expect(first[1]?.textContent).toContain('not stated');
    expect(first[1]?.querySelectorAll('code')).toHaveLength(0);
    expect(first[2]?.textContent).toBe('Unknown');
    expect(first[3]?.textContent).toBe('Merged: date unknown');
    expect(first[4]?.textContent).toBe('GitHub did not state the merge commit.');

    expect(
      [...(cellsOf(rows[1])[1]?.querySelectorAll('code') ?? [])].map((code) => code.textContent),
    ).toEqual(['main', 'ghost-branch']);

    // No draft flag: shown as open, with the gap said aloud, not as a draft.
    expect(rows[2]?.querySelector('.badge')?.textContent).toBe('Open');
    expect(cellsOf(rows[2])[0]?.textContent).toContain('draft status not stated');
    expect(cellsOf(rows[2])[3]?.textContent).toBe('Opened: date unknown');
  });

  it('says the draft status was not stated for a null, unreadable or missing flag, and only then', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          openPull(1, { draft: null }),
          openPull(2, { draft: 'yes' }),
          openPull(3, { draft: undefined }),
          openPull(4, { draft: false }),
          openPull(5, { draft: true }),
          pull(6, { draft: null }),
        ]),
    });
    await screen.findByText('Complete · 6 pull requests loaded');

    const rows = rowsOf();
    const stateCell = (row: number) => cellsOf(rows[row])[0]?.textContent;
    for (const row of [0, 1, 2]) expect(stateCell(row)).toBe('Open (draft status not stated)');
    expect(stateCell(3)).toBe('Open');
    expect(stateCell(4)).toBe('Draft');
    // A merged pull request has no use for the flag, so nothing is said about it.
    expect(stateCell(5)).toBe('Merged');
  });

  it('shows untrusted text as plain text, with unsafe characters replaced', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          openPull(1, {
            title: '<img src=x onerror=alert(1)>\u202E',
            head: { ref: '<script>x</script>' },
            user: { login: '<b>bold</b>' },
          }),
        ]),
    });
    await screen.findByText('Complete · 1 pull request loaded');

    expect(within(panel()).getByText(/<img src=x onerror=alert\(1\)>\uFFFD/)).toBeTruthy();
    expect(within(panel()).getByText('<script>x</script>')).toBeTruthy();
    expect(within(panel()).getByText('<b>bold</b>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect(panel().querySelector('[style]')).toBeNull();
    expect(panel().querySelector('a')).toBeNull();
  });

  it('skips pull requests it cannot read, counts them and says the list is incomplete', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          openPull(1),
          { number: 2 },
          pull(3, { state: 'merged' }),
          // Open, yet merged: contradicts itself.
          openPull(4, { merged_at: '2026-10-03T10:00:00Z' }),
          'junk',
        ]),
    });

    expect(await screen.findByText('Partial · 1 pull request loaded')).toBeTruthy();
    expect(
      within(panel()).getByText(
        /4 pull requests in GitHub's response could not be read and were left out\. The list is incomplete\./,
      ),
    ).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
  });

  it('has an accessible table: a caption, column headers and a header for every row', async () => {
    await openAndLoad({ [PULLS]: () => Response.json([openPull(1), pull(2)]) });
    await screen.findByText('Complete · 2 pull requests loaded');

    const table = within(panel()).getByRole('table', { name: /Loaded pull requests/ });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Pull request', 'State', 'Branches', 'Author', 'Date (UTC)', 'Merge commit']);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(2);
  });
});

describe('Pull requests panel: lists, pages and states', () => {
  it('says Partial and offers more while GitHub has more, then loads only when asked', async () => {
    const net = await openAndLoad({
      [PULLS]: () => Response.json([openPull(2)], next(`${GH}/repositories/1/pulls?page=2`)),
      [PULLS_PAGE_2]: () => Response.json([openPull(1)]),
    });
    expect(await screen.findByText('Partial · 1 pull request loaded')).toBeTruthy();
    expect(within(panel()).getByText(/Older pull requests have not been loaded\./)).toBeTruthy();
    expect(within(panel()).queryByText(/Complete/)).toBeNull();
    expect(pullsRequests(net)).toHaveLength(1);

    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older pull requests' }));

    expect(await screen.findByText('Complete · 2 pull requests loaded')).toBeTruthy();
    expect(rowsOf().map((row) => row.querySelector('th')?.textContent)).toEqual([
      '#2 Pull request 2',
      '#1 Pull request 1',
    ]);
    expect(pullsRequests(net)).toHaveLength(2);
    expect(within(panel()).queryByRole('button', { name: /Load older/ })).toBeNull();
  });

  it('stops after five pages and says the rest cannot be loaded here', async () => {
    let served = 0;
    const net = await openAndLoad({
      [PULLS]: () => {
        served += 1;
        return Response.json([openPull(100)], next(`${GH}/repositories/1/pulls?page=2`));
      },
      [PULLS_PAGE_2]: (request) => {
        served += 1;
        const page = Number(request.url.searchParams.get('page'));
        return Response.json(
          [openPull(100 - page)],
          next(`${GH}/repositories/1/pulls?page=${String(page + 1)}`),
        );
      },
    });

    for (let page = 2; page <= 5; page += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Load older pull requests' }));
      await screen.findByText(`Partial · ${String(page)} pull requests loaded`);
    }

    expect(served).toBe(5);
    expect(within(panel()).queryByRole('button', { name: /Load older/ })).toBeNull();
    expect(
      within(panel()).getByText(/Loading stops at 500 pull requests, and GitHub has more\./),
    ).toBeTruthy();
    expect(pullsRequests(net)).toHaveLength(5);
  });

  it('keeps the loaded rows when a later page fails, and retries the same page', async () => {
    let attempts = 0;
    const net = await openAndLoad({
      [PULLS]: () => Response.json([openPull(2)], next(`${GH}/repositories/1/pulls?page=2`)),
      [PULLS_PAGE_2]: () => {
        attempts += 1;
        return attempts === 1 ? new Response('{}', { status: 500 }) : Response.json([openPull(1)]);
      },
    });
    await screen.findByText('Partial · 1 pull request loaded');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older pull requests' }));

    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('What was already loaded is still shown.');
    expect(screen.getByText('Partial, with an error · 1 pull request loaded')).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
    // Nothing is retried by itself.
    expect(attempts).toBe(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Complete · 2 pull requests loaded')).toBeTruthy();
    expect(attempts).toBe(2);
    expect(
      pullsRequests(net).filter((request) => request.url.pathname === '/repositories/1/pulls'),
    ).toHaveLength(2);
  });

  it('shows a first page that failed as Failed, with a retry, and loads on retry', async () => {
    let attempts = 0;
    await openAndLoad({
      [PULLS]: () => {
        attempts += 1;
        return attempts === 1 ? new Response('{}', { status: 500 }) : Response.json([openPull(1)]);
      },
    });
    const alert = await within(panel()).findByRole('alert');
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Complete · 1 pull request loaded')).toBeTruthy();
  });

  it('shows an empty list as Empty, not as an error', async () => {
    await openAndLoad({ [PULLS]: () => Response.json([]) });

    expect(await within(panel()).findByText('Empty')).toBeTruthy();
    expect(
      within(panel()).getByText('GitHub listed no pull requests for this repository.'),
    ).toBeTruthy();
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(within(panel()).queryByRole('table')).toBeNull();
  });

  it('shows the repository as empty when it has no commits and no pull requests', async () => {
    open({
      [COMMITS]: () => new Response('{}', { status: 409 }),
      [PULLS]: () => Response.json([]),
    });
    await screen.findByText(/repository is empty/);
    fireEvent.click(loadButton());
    expect(await within(panel()).findByText('Empty')).toBeTruthy();
    expect(within(panel()).getByText(/listed no pull requests/)).toBeTruthy();
  });

  it('explains a 403 as a missing Pull requests permission, with no retry', async () => {
    await openAndLoad({ [PULLS]: () => new Response('{}', { status: 403 }) });

    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('read access to Pull requests');
    expect(within(alert).queryByRole('button')).toBeNull();
    // Commits and branches are unaffected.
    expect(screen.getByText('Complete · 4 commits loaded')).toBeTruthy();
  });

  it('offers no retry while a rate limit is in force, and says when loading can resume', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    await openAndLoad({
      [PULLS]: () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        }),
    });

    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toMatch(/rate limit/i);
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(within(panel()).getByText(/rate limit is used up/)).toBeTruthy();
  });

  it('ends the session exactly once on a 401, and stops showing the lists', async () => {
    await openAndLoad({ [PULLS]: () => new Response('{}', { status: 401 }) });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('session has ended');
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('region', { name: 'Pull requests' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Commits' })).toBeNull();
  });

  it('ends the session once when the token is rejected for commits and pull requests alike', async () => {
    open({
      [COMMITS]: () => new Response('{}', { status: 401 }),
      [BRANCHES]: () => new Response('{}', { status: 401 }),
    });
    await screen.findByRole('alert');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // The pull requests were never asked for: the panel went away with the rest.
    expect(screen.queryByRole('button', { name: 'Load pull requests' })).toBeNull();
  });
});

describe('Pull requests panel: linking merged pull requests to the history graph', () => {
  const commitsTable = () =>
    within(screen.getByRole('region', { name: 'Commits' })).getByRole('table');

  it('links merge, squash and rebase merges to their exact commit, and moves focus to its row', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          pull(3, { merge_commit_sha: sha(3) }), // rebase: the last rebased commit
          pull(2, { merge_commit_sha: sha(2) }), // squash: one new commit
          pull(1, { merge_commit_sha: sha(1) }), // merge: a commit with two parents
        ]),
    });
    await screen.findByText('Complete · 3 pull requests loaded');

    const buttons = within(panel()).getAllByRole('button', { name: /^Show commit/ });
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Show commit 0303030 in the commit table',
      'Show commit 0202020 in the commit table',
      'Show commit 0101010 in the commit table',
    ]);
    // Only the commit with two parents is called a merge commit.
    expect(rowsOf().map((row) => cellsOf(row)[4]?.textContent)).toEqual([
      expect.not.stringContaining('merge commit'),
      expect.not.stringContaining('merge commit'),
      expect.stringContaining('(merge commit)'),
    ]);

    for (const [index, n] of [3, 2, 1].entries()) {
      fireEvent.click(buttons[index] as HTMLElement);
      const row = document.activeElement;
      expect(row?.id).toBe(commitRowId(sha(n)));
      expect(row?.tagName).toBe('TR');
      expect(commitsTable().contains(row)).toBe(true);
      expect(row?.textContent).toContain(`Subject ${String(n)}`);
    }
  });

  it('highlights the row it took the reader to, and moves the highlight when another is chosen', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          pull(2, { merge_commit_sha: sha(2) }),
          pull(1, { merge_commit_sha: sha(1) }),
        ]),
    });
    await screen.findByText('Complete · 2 pull requests loaded');
    const highlighted = () =>
      [...commitsTable().querySelectorAll('tbody tr.commit-row-target')].map((row) => row.id);

    // Nothing is highlighted before a commit has been chosen.
    expect(highlighted()).toEqual([]);

    fireEvent.click(within(panel()).getByRole('button', { name: /^Show commit 0202020/ }));
    expect(highlighted()).toEqual([commitRowId(sha(2))]);
    expect(document.activeElement?.id).toBe(commitRowId(sha(2)));

    // The highlight does not depend on focus: it stays when focus moves elsewhere.
    (document.activeElement as HTMLElement).blur();
    expect(highlighted()).toEqual([commitRowId(sha(2))]);

    // Choosing another commit replaces it, so there is never more than one.
    fireEvent.click(within(panel()).getByRole('button', { name: /^Show commit 0101010/ }));
    expect(highlighted()).toEqual([commitRowId(sha(1))]);

    // Choosing the same one again keeps it.
    fireEvent.click(within(panel()).getByRole('button', { name: /^Show commit 0101010/ }));
    expect(highlighted()).toEqual([commitRowId(sha(1))]);
  });

  it('highlights only the first row of a commit that is listed twice', async () => {
    await openAndLoad({
      [COMMITS]: () => Response.json([commit(1, [2]), commit(2, []), commit(1, [2])]),
      [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(1) })]),
    });
    await screen.findByText('Complete · 1 pull request loaded');
    fireEvent.click(within(panel()).getByRole('button', { name: /^Show commit 0101010/ }));

    const rows = [...commitsTable().querySelectorAll('tbody tr')];
    expect(rows.map((row) => row.classList.contains('commit-row-target'))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('describes the button as taking the reader to the commit table, not to the graph', async () => {
    open();
    await screen.findByText('Complete · 4 commits loaded');
    const text = panel().textContent ?? '';
    expect(text).toContain('takes you to its commit in the commit table');
    expect(text).not.toMatch(/history graph/i);
  });

  it('does not link a merged pull request whose commit is not loaded, and says so', async () => {
    const net = await openAndLoad({
      [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(77) })]),
    });
    await screen.findByText('Complete · 1 pull request loaded');

    const cell = cellsOf(rowsOf()[0])[4];
    expect(cell?.textContent).toMatch(/^Merge commit not loaded\./);
    expect(cell?.textContent).toContain('not among the loaded commits of the default branch');
    expect(within(panel()).queryByRole('button', { name: /^Show commit/ })).toBeNull();
    expect(document.getElementById(commitRowId(sha(77)))).toBeNull();
    // Looking for it asked GitHub for nothing.
    expect(net.requests.some((request) => request.url.pathname.includes(sha(77)))).toBe(false);
  });

  it('never links by an abbreviated or near-miss SHA, branch name, title or date', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          pull(1, { merge_commit_sha: sha(1).slice(0, 7) }),
          pull(2, { merge_commit_sha: `${sha(2).slice(0, 39)}f`, title: 'Subject 2' }),
          // Same branch and title as a loaded commit's subject: still nothing to go on.
          pull(3, { merge_commit_sha: sha(55), title: 'Subject 3', head: { ref: 'feat/3' } }),
        ]),
    });
    await screen.findByText('Complete · 3 pull requests loaded');

    expect(within(panel()).queryByRole('button', { name: /^Show commit/ })).toBeNull();
    const texts = rowsOf().map((row) => cellsOf(row)[4]?.textContent);
    // An abbreviated SHA is not one GitHub's answer can be trusted for: it counts as not stated.
    expect(texts[0]).toBe('GitHub did not state the merge commit.');
    // A well-formed SHA that is not loaded is simply not loaded, however much else fits.
    expect(texts[1]).toMatch(/^Merge commit not loaded\./);
    expect(texts[2]).toMatch(/^Merge commit not loaded\./);
  });

  it('does not link a pull request that is not merged, whatever SHA GitHub gives it', async () => {
    await openAndLoad({
      [PULLS]: () =>
        Response.json([
          // GitHub's value for these is a throwaway test merge; here it even equals a loaded commit.
          openPull(1, { merge_commit_sha: sha(1) }),
          openPull(2, { draft: true, merge_commit_sha: sha(2) }),
          pull(3, { merged_at: null, merge_commit_sha: sha(3) }),
        ]),
    });
    await screen.findByText('Complete · 3 pull requests loaded');

    expect(within(panel()).queryByRole('button', { name: /^Show commit/ })).toBeNull();
    for (const row of rowsOf()) expect(cellsOf(row)[4]?.textContent).toBe('');
  });

  it('says the commit may be among older commits while more can be loaded, then links once they are', async () => {
    const OLDER = `GET ${GH}/repositories/1/commits`;
    open({
      [COMMITS]: () => Response.json([commit(1, [2])], next(`${GH}/repositories/1/commits?page=2`)),
      [OLDER]: () => Response.json([commit(2, [])]),
      [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(2) })]),
    });
    await screen.findByText('Partial · 1 commit loaded');
    fireEvent.click(loadButton());
    await screen.findByText('Complete · 1 pull request loaded');

    expect(cellsOf(rowsOf()[0])[4]?.textContent).toContain(
      'older commits, which can be loaded above',
    );
    expect(within(panel()).queryByRole('button', { name: /^Show commit/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load older commits' }));
    await screen.findByText('Complete · 2 commits loaded');

    expect(within(panel()).getByRole('button', { name: /^Show commit 0202020/ })).toBeTruthy();
  });

  it('says the commits are still loading while they are, and never links before they arrive', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    open({
      [COMMITS]: async () => {
        await gate;
        return Response.json(HISTORY);
      },
      [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(1) })]),
    });
    fireEvent.click(loadButton());
    await screen.findByText('Complete · 1 pull request loaded');
    expect(cellsOf(rowsOf()[0])[4]?.textContent).toContain('the commits are still loading');
    expect(within(panel()).queryByRole('button', { name: /^Show commit/ })).toBeNull();

    release();
    expect(
      await within(panel()).findByRole('button', { name: /^Show commit 0101010/ }),
    ).toBeTruthy();
  });

  it('says so when the commits could not be loaded', async () => {
    open({
      [COMMITS]: () => new Response('{}', { status: 500 }),
      [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(1) })]),
    });
    await screen.findByText('Failed');
    fireEvent.click(loadButton());
    await screen.findByText('Complete · 1 pull request loaded');
    expect(cellsOf(rowsOf()[0])[4]?.textContent).toContain('the commits could not be loaded');
  });

  it('takes the reader to the first row of a commit that is listed twice', async () => {
    await openAndLoad({
      [COMMITS]: () => Response.json([commit(1, [2]), commit(2, []), commit(1, [2])]),
      [PULLS]: () => Response.json([pull(1, { merge_commit_sha: sha(1) })]),
    });
    await screen.findByText('Complete · 1 pull request loaded');

    expect(document.querySelectorAll(`[id="${commitRowId(sha(1))}"]`)).toHaveLength(1);
    fireEvent.click(within(panel()).getByRole('button', { name: /^Show commit 0101010/ }));
    expect(document.activeElement).toBe(commitsTable().querySelectorAll('tbody tr')[0]);
  });
});
