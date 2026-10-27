import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPOSITORY_MESSAGES, skippedMessage } from '../../dashboard/messages.ts';
import { MAX_AUTO_PAGES } from '../../dashboard/useRepositoryDataset.ts';
import { TEST_TOKEN, createFakeFetch, fakeRepo, type Handler } from '../../testing/fakeFetch.ts';
import { RepositoryDashboard } from './RepositoryDashboard.tsx';

const GH = 'https://api.github.com';
const REPOS_7 = `GET ${GH}/user/installations/7/repositories`;
const REPOS_8 = `GET ${GH}/user/installations/8/repositories`;
const onUnauthorized = vi.fn();

type Routes = Record<string, Handler>;

function repoResponse(repositories: Record<string, unknown>[], next?: string): Response {
  return Response.json(
    { total_count: repositories.length, repositories },
    next ? { headers: { Link: `<${next}>; rel="next"` } } : {},
  );
}

const owner = (login: string, type?: string) => ({ login, ...(type ? { type } : {}) });

/**
 * The sample account (signed-in user: octo), spread over two installations and three pages so the
 * statistics must be built from the whole dataset, not the first page:
 *
 *   installation 7, page 1: alpha, beta, gamma   installation 7, page 2: delta, epsilon
 *   installation 8:         zeta
 */
const alpha = () =>
  fakeRepo(1, 'alpha', {
    owner: owner('octo', 'User'),
    language: 'TypeScript',
    stargazers_count: 3,
    updated_at: '2026-01-01T10:00:00Z',
    pushed_at: '2026-02-15T10:00:00Z',
    default_branch: 'main',
    topics: ['graph'],
    forks_count: 1,
    open_issues_count: 2,
  });
const beta = () =>
  fakeRepo(2, 'beta', {
    private: true,
    owner: owner('octo', 'User'),
    language: 'TypeScript',
    updated_at: '2026-03-01T10:00:00Z',
  });
const gamma = () =>
  fakeRepo(3, 'gamma', { owner: owner('acme', 'Organization'), language: 'JavaScript' });
const delta = () =>
  fakeRepo(4, 'delta', {
    private: true,
    owner: owner('acme', 'Organization'),
    language: null,
    updated_at: '2025-12-01T10:00:00Z',
  });
const epsilon = () =>
  fakeRepo(5, 'epsilon', {
    owner: owner('friend', 'User'),
    language: 'Python',
    updated_at: '2026-02-01T10:00:00Z',
  });
const zeta = () => ({
  id: 6,
  name: 'zeta',
  full_name: 'mystery/zeta',
  private: false,
  html_url: 'https://github.com/mystery/zeta',
  owner: { login: 'mystery' }, // no owner type, no language, no dates: genuinely sparse data
});

function accountRoutes(overrides: Routes = {}): Routes {
  return {
    [`GET ${GH}/user`]: () => Response.json({ login: 'octo' }),
    [`GET ${GH}/user/installations`]: () =>
      Response.json({
        total_count: 2,
        installations: [
          { id: 7, account: { login: 'octo' } },
          { id: 8, account: { login: 'mystery' } },
        ],
      }),
    [REPOS_7]: (req) =>
      req.url.searchParams.get('page') === '2'
        ? repoResponse([delta(), epsilon()])
        : repoResponse(
            [alpha(), beta(), gamma()],
            `${GH}/user/installations/7/repositories?per_page=100&page=2`,
          ),
    [REPOS_8]: () => repoResponse([zeta()]),
    ...overrides,
  };
}

function setup(routes: Routes = accountRoutes()) {
  const net = createFakeFetch(routes);
  vi.stubGlobal('fetch', net.fetch);
  const view = render(
    <StrictMode>
      <RepositoryDashboard accessToken={TEST_TOKEN} onUnauthorized={onUnauthorized} />
    </StrictMode>,
  );
  return { net, ...view };
}

/** Wait until the whole sample account is loaded and the statistics are final. */
async function loadedAccount(overrides: Routes = {}) {
  const ctx = setup(accountRoutes(overrides));
  await screen.findByText('Complete · 6 repositories');
  return ctx;
}

function stat(label: string): string | undefined {
  const overview = screen.getByRole('region', { name: 'Overview' });
  return (
    within(overview).getByText(label).parentElement?.querySelector('dd')?.textContent ?? undefined
  );
}

/** Repository names in the order the cards are shown. */
const titles = () => screen.getAllByRole('button', { pressed: false }).map((b) => b.textContent);

const select = (label: string, value: string) => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const search = (value: string) => {
  fireEvent.change(screen.getByLabelText('Search by name'), { target: { value } });
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  onUnauthorized.mockClear();
});

describe('overview statistics', () => {
  it('counts the complete dataset across every page and installation', async () => {
    const { net } = await loadedAccount();

    expect(stat('Total')).toBe('6');
    expect(stat('Public')).toBe('4');
    expect(stat('Private')).toBe('2');
    expect(stat('Personal')).toBe('2');
    expect(stat('Organization')).toBe('2');
    expect(stat('Other accounts')).toBe('1');

    // 1 username lookup + 1 installations + 2 pages for installation 7 + 1 for installation 8.
    // (StrictMode may repeat the aborted first attempt, so count distinct paths loosely.)
    const pages = net.requests.filter((r) => r.url.pathname.endsWith('/repositories'));
    expect(new Set(pages.map((r) => r.url.href)).size).toBe(3);
  });

  it('explains repositories whose owner type is unknown instead of guessing', async () => {
    await loadedAccount();
    expect(
      screen.getByText(/1 repository has an owner type that could not be determined/),
    ).toBeTruthy();
  });

  it('labels the figures partial while pages are still loading, and final once all are in', async () => {
    let releaseSecondPage!: (response: Response) => void;
    const secondPage = new Promise<Response>((resolve) => {
      releaseSecondPage = resolve;
    });
    setup(
      accountRoutes({
        [REPOS_7]: (req) =>
          req.url.searchParams.get('page') === '2'
            ? secondPage
            : repoResponse(
                [alpha(), beta(), gamma()],
                `${GH}/user/installations/7/repositories?per_page=100&page=2`,
              ),
      }),
    );

    // Only the first page (3 repositories) has arrived: the figures must not read as "the total".
    expect(await screen.findByText('Partial · 3 repositories counted')).toBeTruthy();
    expect(screen.getByText('Loading repositories… 3 loaded so far')).toBeTruthy();
    expect(stat('Total')).toBe('3');
    expect(screen.getByText(/cover only the repositories that were loaded/)).toBeTruthy();
    expect(screen.getByText('Showing 3 of 3 (partial)')).toBeTruthy();

    releaseSecondPage(repoResponse([delta(), epsilon()]));
    expect(await screen.findByText('Complete · 6 repositories')).toBeTruthy();
    expect(stat('Total')).toBe('6');
    expect(screen.queryByText(/Loading repositories/)).toBeNull();
  });

  it('shows the loading state before any repository has arrived', () => {
    setup(
      accountRoutes({
        [`GET ${GH}/user/installations`]: () => new Promise<Response>(() => undefined),
      }),
    );
    expect(screen.getByText('Loading repositories…')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
  });
});

describe('personal repositories come from the signed-in login', () => {
  it('does not call every non-organization repository personal', async () => {
    await loadedAccount();
    // friend/epsilon is a user account, but not the signed-in user's: not personal.
    expect(stat('Personal')).toBe('2');
    select('Owner', 'personal');
    expect(titles()).toEqual(['octo/alpha', 'octo/beta']);
  });

  it('hides personal figures, disables the filter and says why when GET /user fails', async () => {
    await loadedAccount({ [`GET ${GH}/user`]: () => new Response('{}', { status: 500 }) });

    expect(await screen.findByText(REPOSITORY_MESSAGES.viewerFailed)).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Overview' })).queryByText('Personal'),
    ).toBeNull();
    expect(stat('Organization')).toBe('2');
    const personalOption = within(screen.getByLabelText('Owner')).getByRole('option', {
      name: 'Personal',
    });
    expect((personalOption as HTMLOptionElement).disabled).toBe(true);
  });

  it('recovers when the username lookup is retried', async () => {
    let failing = true;
    await loadedAccount({
      [`GET ${GH}/user`]: () =>
        failing ? new Response('{}', { status: 500 }) : Response.json({ login: 'octo' }),
    });
    await screen.findByText(REPOSITORY_MESSAGES.viewerFailed);

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry username lookup' }));
    await waitFor(() => {
      expect(stat('Personal')).toBe('2');
    });
    expect(screen.queryByText(REPOSITORY_MESSAGES.viewerFailed)).toBeNull();
  });
});

describe('language chart', () => {
  it('shows repository counts and shares per primary language, with a "no language" row', async () => {
    await loadedAccount();
    const chart = screen.getByRole('region', { name: 'Languages' });
    const rows = within(chart)
      .getAllByRole('listitem')
      .map((row) => row.textContent);

    expect(rows).toEqual([
      'TypeScript2 · 33%',
      'JavaScript1 · 17%',
      'Python1 · 17%',
      'No language detected2 · 33%',
    ]);
    expect(within(chart).getByText(/repository count, not lines of code/)).toBeTruthy();
  });

  it('draws bars with SVG attributes and no inline style (the CSP forbids it)', async () => {
    const { container } = await loadedAccount();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    const fills = container.querySelectorAll('.lang-fill');
    expect(fills.length).toBeGreaterThan(0);
    expect(fills[0]?.getAttribute('width')).toBe('100'); // the largest row fills the track
  });

  it('is labelled partial until the data is complete', async () => {
    setup(accountRoutes({ [REPOS_8]: () => new Promise<Response>(() => undefined) }));
    await screen.findByText(/Loading repositories… 5 loaded so far/);
    expect(
      within(screen.getByRole('region', { name: 'Languages' })).getByText('Partial'),
    ).toBeTruthy();
  });
});

describe('search and filters on real loaded data', () => {
  it('searches by repository name', async () => {
    await loadedAccount();
    search('ALP');
    expect(titles()).toEqual(['octo/alpha']);
    expect(screen.getByText('Showing 1 of 6')).toBeTruthy();
  });

  it('filters by visibility', async () => {
    await loadedAccount();
    select('Visibility', 'private');
    expect(titles()).toEqual(['octo/beta', 'acme/delta']);
    select('Visibility', 'public');
    expect(titles()).toEqual(['octo/alpha', 'friend/epsilon', 'acme/gamma', 'mystery/zeta']);
  });

  it('filters by ownership', async () => {
    await loadedAccount();
    select('Owner', 'organization');
    expect(titles()).toEqual(['acme/delta', 'acme/gamma']);
    select('Owner', 'other');
    expect(titles()).toEqual(['friend/epsilon']);
  });

  it('filters by language, including repositories with no language', async () => {
    await loadedAccount();
    select('Language', 'TypeScript');
    expect(titles()).toEqual(['octo/alpha', 'octo/beta']);
    select('Language', '__none__');
    expect(titles()).toEqual(['acme/delta', 'mystery/zeta']);
  });

  it('offers a language option per language with its count', async () => {
    await loadedAccount();
    const options = within(screen.getByLabelText('Language'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual([
      'All',
      'TypeScript (2)',
      'JavaScript (1)',
      'Python (1)',
      'No language detected (2)',
    ]);
  });

  it('sorts by name and by most recently updated', async () => {
    await loadedAccount();
    expect(titles()).toEqual([
      'octo/alpha',
      'octo/beta',
      'acme/delta',
      'friend/epsilon',
      'acme/gamma',
      'mystery/zeta',
    ]);
    select('Sort by', 'updated');
    expect(titles()).toEqual([
      'octo/beta', // 2026-03-01
      'friend/epsilon', // 2026-02-01
      'octo/alpha', // 2026-01-01
      'acme/delta', // 2025-12-01
      'acme/gamma', // no date: last, by name
      'mystery/zeta', // no date
    ]);
  });

  it('combines search, filters and sort', async () => {
    await loadedAccount();
    search('a');
    select('Visibility', 'public');
    select('Owner', 'personal');
    expect(titles()).toEqual(['octo/alpha']);

    select('Owner', 'all');
    select('Sort by', 'updated');
    expect(titles()).toEqual(['octo/alpha', 'acme/gamma', 'mystery/zeta']);
  });

  it('keeps statistics on the whole dataset when the view is filtered', async () => {
    await loadedAccount();
    select('Visibility', 'private');
    expect(stat('Total')).toBe('6');
    expect(screen.getByText('Showing 2 of 6')).toBeTruthy();
  });

  it('shows a no-results state with a reset that restores everything', async () => {
    await loadedAccount();
    search('no-such-repository');

    expect(screen.getByText(REPOSITORY_MESSAGES.noResults)).toBeTruthy();
    expect(screen.queryByRole('button', { pressed: false })).toBeNull();

    const resets = screen.getAllByRole('button', { name: 'Reset filters' });
    fireEvent.click(resets[resets.length - 1] as HTMLElement);

    expect(titles()).toHaveLength(6);
    expect(screen.getByLabelText<HTMLInputElement>('Search by name').value).toBe('');
  });

  it('only enables Reset when something is filtered, and keeps the chosen sort', async () => {
    await loadedAccount();
    const reset = screen.getByRole<HTMLButtonElement>('button', { name: 'Reset filters' });
    expect(reset.disabled).toBe(true);

    select('Sort by', 'updated');
    expect(reset.disabled).toBe(true); // sorting is not a filter

    select('Visibility', 'private');
    expect(reset.disabled).toBe(false);
    fireEvent.click(reset);
    expect(screen.getByLabelText<HTMLSelectElement>('Visibility').value).toBe('all');
    expect(screen.getByLabelText<HTMLSelectElement>('Sort by').value).toBe('updated');
  });
});

describe('repository cards', () => {
  it('shows only the data GitHub provided for each repository', async () => {
    await loadedAccount();
    const rich = screen.getByRole('button', { name: 'octo/alpha' }).closest('article');
    const sparse = screen.getByRole('button', { name: 'mystery/zeta' }).closest('article');
    if (!rich || !sparse) throw new Error('expected cards');

    expect(within(rich).getByText('TypeScript')).toBeTruthy();
    expect(within(rich).getByText('★ 3')).toBeTruthy();
    expect(within(rich).getByText(/^Updated .*2026/)).toBeTruthy();
    expect(within(rich).getByText('Owner: octo')).toBeTruthy();

    // zeta has no language, stars or date: nothing is shown in their place (no "0", no "Unknown").
    expect(within(sparse).queryByText(/★/)).toBeNull();
    expect(within(sparse).queryByText(/Updated/)).toBeNull();
    expect(within(sparse).queryByText(/unknown|n\/a|none/i)).toBeNull();
    expect(within(sparse).getByText('Owner: mystery')).toBeTruthy();
  });

  it('does not leak the access token into the page', async () => {
    const { container } = await loadedAccount();
    expect(container.innerHTML).not.toContain(TEST_TOKEN);
  });
});

describe('repository selection', () => {
  it('opens a detail panel with the available fields, and focuses it', async () => {
    await loadedAccount();
    fireEvent.click(screen.getByRole('button', { name: 'octo/alpha' }));

    const panel = screen.getByRole('complementary');
    const heading = within(panel).getByRole('heading', { name: 'octo/alpha' });
    expect(document.activeElement).toBe(heading);

    const value = (label: string) =>
      within(panel).getByText(label).parentElement?.querySelector('dd')?.textContent;
    expect(value('Owner')).toBe('octo (User)');
    expect(value('Visibility')).toBe('Public');
    expect(value('Primary language')).toBe('TypeScript');
    expect(value('Updated')).toMatch(/2026/);
    expect(value('Last pushed')).toMatch(/Feb.*15.*2026|15 Feb 2026|2026/);
    expect(value('Stars')).toBe('3');
    expect(value('Forks')).toBe('1');
    expect(value('Open issues and PRs')).toBe('2');
    expect(value('Default branch')).toBe('main');
    expect(within(panel).getByText('graph')).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Open on GitHub ↗' }).getAttribute('href')).toBe(
      'https://github.com/octo/alpha',
    );
    expect(screen.getByRole('button', { name: 'octo/alpha', pressed: true })).toBeTruthy();
  });

  it('omits rows for data GitHub did not provide', async () => {
    await loadedAccount();
    fireEvent.click(screen.getByRole('button', { name: 'mystery/zeta' }));
    const panel = screen.getByRole('complementary');
    for (const missing of [
      'Primary language',
      'Updated',
      'Last pushed',
      'Stars',
      'Forks',
      'Default branch',
    ]) {
      expect(within(panel).queryByText(missing)).toBeNull();
    }
    expect(within(panel).getByText('Owner').parentElement?.querySelector('dd')?.textContent).toBe(
      'mystery',
    );
  });

  it('switches between repositories and closes, returning focus to the card', async () => {
    await loadedAccount();
    fireEvent.click(screen.getByRole('button', { name: 'octo/alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'octo/beta' }));
    expect(
      within(screen.getByRole('complementary')).getByRole('heading', { name: 'octo/beta' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'octo/beta' }));
  });

  it('keeps showing the selected repository when filters hide its card', async () => {
    await loadedAccount();
    fireEvent.click(screen.getByRole('button', { name: 'octo/alpha' }));
    search('gamma');
    expect(
      within(screen.getByRole('complementary')).getByRole('heading', { name: 'octo/alpha' }),
    ).toBeTruthy();
  });
});

describe('pagination safety cap', () => {
  function endlessRoutes(): Routes {
    return {
      [`GET ${GH}/user`]: () => Response.json({ login: 'octo' }),
      [`GET ${GH}/user/installations`]: () =>
        Response.json({ total_count: 1, installations: [{ id: 7 }] }),
      [REPOS_7]: (req) => {
        const page = Number(req.url.searchParams.get('page') ?? '1');
        return repoResponse(
          [fakeRepo(page, `repo-${String(page)}`)],
          `${GH}/user/installations/7/repositories?per_page=100&page=${String(page + 1)}`,
        );
      },
    };
  }

  it('stops at the cap, says the statistics are partial, and can continue', async () => {
    const net = createFakeFetch(endlessRoutes());
    vi.stubGlobal('fetch', net.fetch);
    render(<RepositoryDashboard accessToken={TEST_TOKEN} onUnauthorized={onUnauthorized} />);

    const capped = await screen.findByText(
      new RegExp(
        `Loaded the first ${String(MAX_AUTO_PAGES)} repositories and stopped at the safety limit`,
      ),
      undefined,
      { timeout: 5000 },
    );
    expect(capped.textContent).toMatch(/partial/);
    expect(
      screen.getByText(`Partial · ${String(MAX_AUTO_PAGES)} repositories counted`),
    ).toBeTruthy();
    expect(stat('Total')).toBe(String(MAX_AUTO_PAGES));
    expect(net.requests.filter((r) => r.url.pathname.endsWith('/repositories'))).toHaveLength(
      MAX_AUTO_PAGES,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText(
      new RegExp(`Loaded the first ${String(MAX_AUTO_PAGES * 2)} repositories`),
      undefined,
      { timeout: 5000 },
    );
    expect(stat('Total')).toBe(String(MAX_AUTO_PAGES * 2));
    expect(screen.queryByText(/Complete ·/)).toBeNull();
  }, 15_000);
});

describe('failures and partial data', () => {
  it('keeps what was loaded when a later page fails, labels it partial, and resumes on retry', async () => {
    let failing = true;
    setup(
      accountRoutes({
        [REPOS_7]: (req) =>
          req.url.searchParams.get('page') === '2'
            ? failing
              ? new Response('{}', { status: 500 })
              : repoResponse([delta(), epsilon()])
            : repoResponse(
                [alpha(), beta(), gamma()],
                `${GH}/user/installations/7/repositories?per_page=100&page=2`,
              ),
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(REPOSITORY_MESSAGES.generic);
    expect(alert.textContent).toContain('Loading stopped after 3 repositories');
    expect(screen.getByText('Partial · 3 repositories counted')).toBeTruthy();
    expect(stat('Total')).toBe('3');
    expect(titles()).toHaveLength(3); // what was loaded stays usable

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Complete · 6 repositories')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error with retry when nothing could be loaded, and no statistics', async () => {
    let failing = true;
    setup(
      accountRoutes({
        [`GET ${GH}/user/installations`]: () =>
          failing
            ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
            : Response.json({ total_count: 1, installations: [{ id: 8 }] }),
      }),
    );

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(REPOSITORY_MESSAGES.rateLimited);
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();

    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Complete · 1 repository')).toBeTruthy();
  });

  it('tells the user about unreadable entries and does not call the figures complete', async () => {
    setup(accountRoutes({ [REPOS_8]: () => repoResponse([zeta(), { surprise: true }]) }));
    expect(await screen.findByText(skippedMessage(1))).toBeTruthy();
    expect(screen.getByText('Partial · 6 repositories counted')).toBeTruthy();
    expect(screen.queryByText(/Complete ·/)).toBeNull();
  });

  it('shows the install guidance when there are no repositories at all', async () => {
    setup(
      accountRoutes({
        [`GET ${GH}/user/installations`]: () =>
          Response.json({ total_count: 0, installations: [] }),
      }),
    );
    expect(await screen.findByText(REPOSITORY_MESSAGES.empty)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
  });

  it('reports a rejected token to the app (401 on any request)', async () => {
    setup(accountRoutes({ [REPOS_8]: () => new Response('{}', { status: 401 }) }));
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
  });
});
