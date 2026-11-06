import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryItem } from '../../github/repositories.ts';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../../testing/fakeFetch.ts';
import { ActivityView } from './ActivityView.tsx';

const GH = 'https://api.github.com';
const COMMITS = `GET ${GH}/repos/octo/alpha/commits`;
const BRANCHES = `GET ${GH}/repos/octo/alpha/branches`;
const ISSUES = `GET ${GH}/repos/octo/alpha/issues`;
const ISSUES_PAGE_2 = `GET ${GH}/repositories/1/issues`;
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
const HISTORY = [
  {
    sha: sha(1),
    commit: { message: 'Subject 1', author: { name: 'Author', date: '2026-10-10T12:00:00Z' } },
    author: { login: 'login1' },
    parents: [],
  },
];

function issue(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'open',
    title: `Issue ${String(number)}`,
    state_reason: null,
    user: { login: `user${String(number)}` },
    labels: [],
    comments: 0,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-03T10:00:00Z',
    closed_at: null,
    body: `BODY-OF-${String(number)} must never be shown`,
    ...over,
  };
}

const closedIssue = (number: number, over: Record<string, unknown> = {}) =>
  issue(number, {
    state: 'closed',
    state_reason: 'completed',
    closed_at: '2026-10-05T10:00:00Z',
    ...over,
  });

/** A pull request as GitHub's issue list shows it: an issue-shaped entry with a `pull_request` key. */
const pullEntry = (number: number) =>
  issue(number, { title: `PR-ENTRY ${String(number)}`, pull_request: { url: 'x' } });

const next = (url: string) => ({ headers: { Link: `<${url}>; rel="next"` } });

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [COMMITS]: () => Response.json(HISTORY),
    [BRANCHES]: () => Response.json([]),
    [ISSUES]: () => Response.json([issue(1)]),
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

const issuesRequests = (net: ReturnType<typeof open>) =>
  net.requests.filter((request) => request.url.pathname.endsWith('/issues'));
const panel = () => screen.getByRole('region', { name: 'Issues' });
const loadButton = () => screen.getByRole('button', { name: 'Load issues' });

/** Opens the view, waits for the commits, and presses "Load issues". */
async function openAndLoad(overrides: Record<string, Handler> = {}) {
  const net = open(overrides);
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

describe('Issues panel: asking for data', () => {
  it('sits between Pull requests and Branches', async () => {
    open();
    await screen.findByText('Complete · 1 commit loaded');
    const order = screen
      .getAllByRole('heading', { level: 3 })
      .map((heading) => heading.textContent);
    expect(order).toEqual(['Commits', 'Pull requests', 'Issues', 'Branches']);
  });

  it('requests nothing until the reader presses the button', async () => {
    const net = open();
    await screen.findByText('Complete · 1 commit loaded');

    expect(within(panel()).getByRole('button', { name: 'Load issues' })).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();
    expect(issuesRequests(net)).toHaveLength(0);
    expect(net.requests.map((request) => request.url.pathname).sort()).toEqual([
      '/repos/octo/alpha/branches',
      '/repos/octo/alpha/commits',
    ]);
    expect(
      within(panel()).getByText(/Nothing is requested from GitHub until you load/),
    ).toBeTruthy();
  });

  it('then makes one GET for the first page and moves focus to the panel heading', async () => {
    const net = await openAndLoad();
    expect(await screen.findByText('Complete · 1 issue loaded')).toBeTruthy();

    const requests = issuesRequests(net);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(Object.fromEntries(requests[0]?.url.searchParams ?? [])).toEqual({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: '100',
    });
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'Issues' }));
    expect(
      net.requests.every((request) => request.method === 'GET' && request.url.origin === GH),
    ).toBe(true);
    expect(within(panel()).queryByRole('button', { name: 'Load issues' })).toBeNull();
  });

  it('does not touch the pull requests list, and asks for nothing per issue or in the background', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const net = await openAndLoad({
        [ISSUES]: () => Response.json([issue(1), closedIssue(2), issue(3)]),
      });
      await screen.findByText('Complete · 3 issues loaded');
      const before = net.requests.length;
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(net.requests).toHaveLength(before);
      expect(net.requests.map((request) => request.url.pathname).sort()).toEqual([
        '/repos/octo/alpha/branches',
        '/repos/octo/alpha/commits',
        '/repos/octo/alpha/issues',
      ]);
      // The pull request panel is still waiting for its own button.
      expect(screen.getByRole('button', { name: 'Load pull requests' })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Issues panel: rows', () => {
  it('shows number, title, state, reason, labels, author, dates and comments', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([
          issue(3, {
            labels: [{ name: 'bug', color: 'ff0000' }, 'help wanted'],
            comments: 12,
            state_reason: 'reopened',
          }),
          closedIssue(2),
          closedIssue(1, { state_reason: 'not_planned' }),
          closedIssue(4, { state_reason: 'duplicate' }),
        ]),
    });
    await screen.findByText('Complete · 4 issues loaded');

    const rows = rowsOf();
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector('.badge')?.textContent)).toEqual([
      'Open',
      'Closed',
      'Closed',
      'Closed',
    ]);
    expect(rows[0]?.querySelector('th')?.textContent).toBe('#3 Issue 3');

    const [state, labels, author, dates, comments] = cellsOf(rows[0]);
    expect(state?.textContent).toBe('Open (reopened)');
    expect([...(labels?.querySelectorAll('li') ?? [])].map((li) => li.textContent)).toEqual([
      'bug',
      'help wanted',
    ]);
    expect(author?.textContent).toBe('user3');
    expect(dates?.textContent).toContain('Opened');
    expect(dates?.textContent).toContain('Updated');
    expect(dates?.textContent).not.toContain('Closed');
    expect(
      [...(dates?.querySelectorAll('time') ?? [])].map((time) => time.getAttribute('datetime')),
    ).toEqual(['2026-10-01T10:00:00.000Z', '2026-10-03T10:00:00.000Z']);
    expect(comments?.textContent).toBe('12');

    expect(cellsOf(rows[1])[0]?.textContent).toBe('Closed (completed)');
    expect(cellsOf(rows[1])[3]?.textContent).toContain('Closed');
    expect(cellsOf(rows[2])[0]?.textContent).toBe('Closed (not planned)');
    expect(cellsOf(rows[3])[0]?.textContent).toBe('Closed (duplicate)');
    // No labels at all is said in words.
    expect(cellsOf(rows[1])[1]?.textContent).toBe('None');
  });

  it('copes with a missing author, title, labels, comments and dates without inventing values', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([
          issue(1, {
            user: null,
            title: undefined,
            labels: undefined,
            comments: undefined,
            created_at: 'yesterday',
            updated_at: null,
            state_reason: 'something_new',
          }),
          closedIssue(2, { closed_at: null, state_reason: null }),
        ]),
    });
    await screen.findByText('Complete · 2 issues loaded');
    const rows = rowsOf();

    const first = cellsOf(rows[0]);
    expect(rows[0]?.querySelector('th')?.textContent).toBe('#1 (no title)');
    expect(first[0]?.textContent).toBe('Open');
    expect(first[1]?.textContent).toBe('not stated');
    expect(first[2]?.textContent).toBe('Unknown');
    expect(first[3]?.textContent).toBe('Opened: date unknownUpdated: date unknown');
    expect(first[4]?.textContent).toBe('Unknown');

    expect(cellsOf(rows[1])[0]?.textContent).toBe('Closed');
    expect(cellsOf(rows[1])[3]?.textContent).toContain('Closed: date unknown');
  });

  it('shows a few labels and says how many more there are', async () => {
    await openAndLoad({
      [ISSUES]: () => Response.json([issue(1, { labels: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })]),
    });
    await screen.findByText('Complete · 1 issue loaded');
    const items = [...(cellsOf(rowsOf()[0])[1]?.querySelectorAll('li') ?? [])];
    expect(items.map((li) => li.textContent)).toEqual(['a', 'b', 'c', 'd', 'e', '+2 more']);
  });

  it('shows untrusted text, labels included, as plain text with unsafe characters replaced', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([
          issue(1, {
            title: '<img src=x onerror=alert(1)>\u202E',
            user: { login: '<b>bold</b>' },
            labels: [{ name: '<script>x</script>', color: 'url(javascript:alert(1))' }],
          }),
        ]),
    });
    await screen.findByText('Complete · 1 issue loaded');

    expect(within(panel()).getByText(/<img src=x onerror=alert\(1\)>\uFFFD/)).toBeTruthy();
    expect(within(panel()).getByText('<script>x</script>')).toBeTruthy();
    expect(within(panel()).getByText('<b>bold</b>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    // No inline styles (so no label colours) and no links built from anything GitHub sent.
    expect(panel().querySelector('[style]')).toBeNull();
    expect(panel().querySelector('a')).toBeNull();
  });

  it('never shows or keeps the description of an issue', async () => {
    await openAndLoad({
      [ISSUES]: () => Response.json([issue(1), closedIssue(2)]),
    });
    await screen.findByText('Complete · 2 issues loaded');
    expect(panel().textContent).not.toContain('BODY-OF');
    expect(document.body.textContent).not.toContain('must never be shown');
  });

  it('has an accessible table: a caption, column headers and a header for every row', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([issue(1), closedIssue(2)]) });
    await screen.findByText('Complete · 2 issues loaded');

    const table = within(panel()).getByRole('table', { name: /Loaded issues/ });
    expect(
      within(panel())
        .getByRole('region', { name: 'Scrollable issues table' })
        .getAttribute('tabindex'),
    ).toBe('0');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Issue', 'State', 'Labels', 'Author', 'Dates (UTC)', 'Comments']);
    expect(within(table).getAllByRole('rowheader')).toHaveLength(2);
  });

  it('keeps rows apart when GitHub lists the same number twice', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([issue(1), issue(1)]) });
    await screen.findByText('Complete · 2 issues loaded');
    expect(rowsOf()).toHaveLength(2);
  });
});

describe('Issues panel: pull requests in the answer', () => {
  it('leaves them out, says how many, and does not count them as issues or as unreadable', async () => {
    await openAndLoad({
      [ISSUES]: () => Response.json([issue(1), pullEntry(2), pullEntry(3), closedIssue(4)]),
    });

    expect(await screen.findByText('Complete · 2 issues loaded')).toBeTruthy();
    expect(rowsOf().map((row) => row.querySelector('th')?.textContent)).toEqual([
      '#1 Issue 1',
      '#4 Issue 4',
    ]);
    expect(panel().textContent).not.toContain('PR-ENTRY');
    expect(
      within(panel()).getByText(/2 pull requests in GitHub's response were left out/),
    ).toBeTruthy();
    expect(within(panel()).queryByText(/could not be read/)).toBeNull();
    expect(within(panel()).queryByText(/Partial/)).toBeNull();
  });

  it('uses the singular for one omitted pull request, and says nothing when there are none', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([issue(1), pullEntry(2)]) });
    expect(
      await within(panel()).findByText(/1 pull request in GitHub's response was left out/),
    ).toBeTruthy();
  });

  it('says nothing about pull requests when there were none', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([issue(1)]) });
    await screen.findByText('Complete · 1 issue loaded');
    expect(within(panel()).queryByText(/pull requests? in GitHub's response/)).toBeNull();
  });

  it('treats an entry with an ambiguous pull_request marker as unreadable, never as an issue', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([
          issue(1),
          issue(2, { pull_request: 'yes' }),
          issue(3, { pull_request: null }),
          issue(4, { pull_request: true }),
          pullEntry(5),
        ]),
    });

    expect(await screen.findByText('Partial · 1 issue loaded')).toBeTruthy();
    expect(
      within(panel()).getByText(/3 issues in GitHub's response could not be read/),
    ).toBeTruthy();
    expect(
      within(panel()).getByText(/1 pull request in GitHub's response was left out/),
    ).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
  });

  it('keeps counting omitted pull requests across pages', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([issue(1), pullEntry(2)], next(`${GH}/repositories/1/issues?page=2`)),
      [ISSUES_PAGE_2]: () => Response.json([pullEntry(3), pullEntry(4), issue(5)]),
    });
    await screen.findByText('Partial · 1 issue loaded');
    expect(
      within(panel()).getByText(/1 pull request in GitHub's response was left out/),
    ).toBeTruthy();

    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older issues' }));

    expect(await screen.findByText('Complete · 2 issues loaded')).toBeTruthy();
    expect(
      within(panel()).getByText(/3 pull requests in GitHub's response were left out/),
    ).toBeTruthy();
  });

  it('is not Empty after a page of only pull requests while GitHub has more, and then finds the issues', async () => {
    const net = await openAndLoad({
      [ISSUES]: () =>
        Response.json([pullEntry(1), pullEntry(2)], next(`${GH}/repositories/1/issues?page=2`)),
      [ISSUES_PAGE_2]: () => Response.json([issue(7)]),
    });

    expect(await screen.findByText('Partial · 0 issues loaded')).toBeTruthy();
    expect(within(panel()).queryByText('Empty')).toBeNull();
    expect(within(panel()).queryByText('GitHub listed no issues for this repository.')).toBeNull();
    expect(
      within(panel()).getByText('No issues were found among the entries loaded so far.'),
    ).toBeTruthy();
    expect(
      within(panel()).getByText(/2 pull requests in GitHub's response were left out/),
    ).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();
    // Nothing chained by itself.
    expect(issuesRequests(net)).toHaveLength(1);

    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older issues' }));

    expect(await screen.findByText('Complete · 1 issue loaded')).toBeTruthy();
    expect(rowsOf().map((row) => row.querySelector('th')?.textContent)).toEqual(['#7 Issue 7']);
    expect(
      within(panel()).queryByText('No issues were found among the entries loaded so far.'),
    ).toBeNull();
    expect(issuesRequests(net)).toHaveLength(2);
  });

  it('is Empty, with the omitted note, when everything GitHub listed was a pull request', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([pullEntry(1), pullEntry(2)]) });

    expect(await within(panel()).findByText('Empty')).toBeTruthy();
    expect(within(panel()).getByText('GitHub listed no issues for this repository.')).toBeTruthy();
    expect(
      within(panel()).getByText(/2 pull requests in GitHub's response were left out/),
    ).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();
  });
});

describe('Issues panel: lists, pages and states', () => {
  it('says Partial and offers more while GitHub has more, then loads only when asked', async () => {
    const net = await openAndLoad({
      [ISSUES]: () => Response.json([issue(2)], next(`${GH}/repositories/1/issues?page=2`)),
      [ISSUES_PAGE_2]: () => Response.json([issue(1)]),
    });
    expect(await screen.findByText('Partial · 1 issue loaded')).toBeTruthy();
    expect(within(panel()).getByText(/Older issues have not been loaded\./)).toBeTruthy();
    expect(within(panel()).queryByText(/Complete/)).toBeNull();
    expect(issuesRequests(net)).toHaveLength(1);

    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older issues' }));

    expect(await screen.findByText('Complete · 2 issues loaded')).toBeTruthy();
    expect(rowsOf().map((row) => row.querySelector('th')?.textContent)).toEqual([
      '#2 Issue 2',
      '#1 Issue 1',
    ]);
    expect(issuesRequests(net)).toHaveLength(2);
    expect(within(panel()).queryByRole('button', { name: /Load older/ })).toBeNull();
  });

  it('stops after five pages (500 entries examined) and says the rest cannot be loaded here', async () => {
    let served = 0;
    const net = await openAndLoad({
      [ISSUES]: () => {
        served += 1;
        return Response.json([issue(100)], next(`${GH}/repositories/1/issues?page=2`));
      },
      [ISSUES_PAGE_2]: (request) => {
        served += 1;
        const page = Number(request.url.searchParams.get('page'));
        return Response.json(
          [issue(100 - page)],
          next(`${GH}/repositories/1/issues?page=${String(page + 1)}`),
        );
      },
    });

    for (let page = 2; page <= 5; page += 1) {
      fireEvent.click(await screen.findByRole('button', { name: 'Load older issues' }));
      await screen.findByText(`Partial · ${String(page)} issues loaded`);
    }

    expect(served).toBe(5);
    expect(within(panel()).queryByRole('button', { name: /Load older/ })).toBeNull();
    expect(
      within(panel()).getByText(
        /Loading stops after 500 entries from GitHub \(issues and pull requests together\), and GitHub has more\./,
      ),
    ).toBeTruthy();
    expect(issuesRequests(net)).toHaveLength(5);
  });

  it('keeps the loaded rows when a later page fails, and retries the same page', async () => {
    let attempts = 0;
    const net = await openAndLoad({
      [ISSUES]: () => Response.json([issue(2)], next(`${GH}/repositories/1/issues?page=2`)),
      [ISSUES_PAGE_2]: () => {
        attempts += 1;
        return attempts === 1 ? new Response('{}', { status: 500 }) : Response.json([issue(1)]);
      },
    });
    await screen.findByText('Partial · 1 issue loaded');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older issues' }));

    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('What was already loaded is still shown.');
    expect(screen.getByText('Partial, with an error · 1 issue loaded')).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
    expect(attempts).toBe(1);

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Complete · 2 issues loaded')).toBeTruthy();
    expect(attempts).toBe(2);
    expect(
      issuesRequests(net).filter((request) => request.url.pathname === '/repositories/1/issues'),
    ).toHaveLength(2);
  });

  it('keeps the omitted count when a later page fails', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([issue(2), pullEntry(3)], next(`${GH}/repositories/1/issues?page=2`)),
      [ISSUES_PAGE_2]: () => new Response('{}', { status: 500 }),
    });
    await screen.findByText('Partial · 1 issue loaded');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older issues' }));
    await within(panel()).findByRole('alert');
    expect(
      within(panel()).getByText(/1 pull request in GitHub's response was left out/),
    ).toBeTruthy();
  });

  it('shows a first page that failed as Failed, with a retry, and loads on retry', async () => {
    let attempts = 0;
    await openAndLoad({
      [ISSUES]: () => {
        attempts += 1;
        return attempts === 1 ? new Response('{}', { status: 500 }) : Response.json([issue(1)]);
      },
    });
    const alert = await within(panel()).findByRole('alert');
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(within(panel()).queryByRole('table')).toBeNull();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Complete · 1 issue loaded')).toBeTruthy();
  });

  it('shows an empty list as Empty, not as an error', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([]) });

    expect(await within(panel()).findByText('Empty')).toBeTruthy();
    expect(within(panel()).getByText('GitHub listed no issues for this repository.')).toBeTruthy();
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(within(panel()).queryByRole('table')).toBeNull();
  });

  it('skips issues it cannot read, counts them and says the list is incomplete', async () => {
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([issue(1), { number: 2 }, issue(3, { state: 'merged' }), issue(0), 'junk']),
    });

    expect(await screen.findByText('Partial · 1 issue loaded')).toBeTruthy();
    expect(
      within(panel()).getByText(
        /4 issues in GitHub's response could not be read and were left out\. The list is incomplete\./,
      ),
    ).toBeTruthy();
    expect(rowsOf()).toHaveLength(1);
  });

  it('shows no rows and no Empty claim when nothing could be read and GitHub has no more', async () => {
    await openAndLoad({ [ISSUES]: () => Response.json([{ number: 1 }, 'junk']) });

    expect(await screen.findByText('Partial · 0 issues loaded')).toBeTruthy();
    expect(within(panel()).queryByText('Empty')).toBeNull();
    expect(within(panel()).queryByRole('table')).toBeNull();
  });

  it('shows an empty repository as Empty', async () => {
    open({
      [COMMITS]: () => new Response('{}', { status: 409 }),
      [ISSUES]: () => Response.json([]),
    });
    await screen.findByText(/repository is empty/);
    fireEvent.click(loadButton());
    expect(await within(panel()).findByText('Empty')).toBeTruthy();
  });
});

describe('Issues panel: failures', () => {
  it('explains a 403 as a missing Issues permission, with no retry', async () => {
    await openAndLoad({ [ISSUES]: () => new Response('{"message":"secret"}', { status: 403 }) });

    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('read access to Issues');
    expect(alert.textContent).not.toContain('secret');
    expect(within(alert).queryByRole('button')).toBeNull();
    // Commits and branches are unaffected.
    expect(screen.getByText('Complete · 1 commit loaded')).toBeTruthy();
  });

  it('explains a 404 without a retry', async () => {
    await openAndLoad({ [ISSUES]: () => new Response('{}', { status: 404 }) });
    const alert = await within(panel()).findByRole('alert');
    expect(alert.textContent).toContain('issue list could not be found');
    expect(within(alert).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('shows issues turned off (410) as Empty with a note, not as an error', async () => {
    await openAndLoad({ [ISSUES]: () => new Response('{}', { status: 410 }) });

    expect(await within(panel()).findByText('Empty')).toBeTruthy();
    expect(within(panel()).getByText('Issues are turned off for this repository.')).toBeTruthy();
    expect(within(panel()).queryByRole('alert')).toBeNull();
    expect(within(panel()).queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('offers no retry while a rate limit is in force, and says when loading can resume', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    await openAndLoad({
      [ISSUES]: () =>
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

  it('stops offering more when a successful page says the rate limit is used up', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    await openAndLoad({
      [ISSUES]: () =>
        Response.json([issue(1)], {
          headers: {
            Link: `<${GH}/repositories/1/issues?page=2>; rel="next"`,
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': reset,
          },
        }),
    });
    await screen.findByText('Partial · 1 issue loaded');
    expect(within(panel()).queryByRole('button', { name: 'Load older issues' })).toBeNull();
    expect(within(panel()).getByText(/rate limit is used up/)).toBeTruthy();
  });

  it('ends the session exactly once on a 401, and stops showing the lists', async () => {
    await openAndLoad({ [ISSUES]: () => new Response('{}', { status: 401 }) });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('session has ended');
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole('region', { name: 'Issues' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Commits' })).toBeNull();
  });

  it('ends the session once when the token is rejected for a later page of issues', async () => {
    await openAndLoad({
      [ISSUES]: () => Response.json([issue(1)], next(`${GH}/repositories/1/issues?page=2`)),
      [ISSUES_PAGE_2]: () => new Response('{}', { status: 401 }),
    });
    await screen.findByText('Partial · 1 issue loaded');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Load older issues' }));

    await screen.findByText(/session has ended/);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('ends the session once when the token is rejected for the commits too, and never asks for issues', async () => {
    const net = open({
      [COMMITS]: () => new Response('{}', { status: 401 }),
      [BRANCHES]: () => new Response('{}', { status: 401 }),
    });
    await screen.findByRole('alert');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Load issues' })).toBeNull();
    expect(issuesRequests(net)).toHaveLength(0);
  });
});
