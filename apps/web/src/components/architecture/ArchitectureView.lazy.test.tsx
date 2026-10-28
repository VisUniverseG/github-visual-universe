import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHITECTURE_MESSAGES } from '../../architecture/messages.ts';
import { formatBytes } from '../../dashboard/format.ts';
import { REPOSITORY_MESSAGES } from '../../dashboard/messages.ts';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../../testing/fakeFetch.ts';
import { makeItem } from '../../testing/fixtures.ts';
import { FixtureTree, blob, dirEntry } from '../../testing/treeFixtures.ts';
import { GH, gated, okResponse } from '../../testing/treeNetwork.ts';
import { ArchitectureView } from './ArchitectureView.tsx';

/**
 * A repository GitHub cannot list in one piece: the recursive request comes back cut off, so the
 * view reads the root, then each folder when it is opened.
 *
 *   README.md 100 B
 *   docs/guide.md 1,050 B
 *   src/index.ts 300 B
 *   src/util/math.ts 50 B
 */
const LAZY = new FixtureTree([
  blob('README.md', 100),
  dirEntry('src'),
  blob('src/index.ts', 300),
  dirEntry('src/util'),
  blob('src/util/math.ts', 50),
  dirEntry('docs'),
  blob('docs/guide.md', 1050),
]);

const OTHER = new FixtureTree([blob('LICENSE', 5), dirEntry('lib'), blob('lib/x.js', 7)]);

// A root that lists only folders, none of them loaded yet.
const FOLDERS = new FixtureTree([
  dirEntry('a'),
  blob('a/x.txt', 1),
  dirEntry('b'),
  blob('b/y.txt', 2),
]);

// `a` holds only a folder (so, once `a` is listed, all it contributes so far is a zero), `empty`
// really is empty, and `r.txt` gives the treemap something to draw.
const NESTED = new FixtureTree([
  dirEntry('a'),
  dirEntry('a/sub'),
  blob('a/sub/x.txt', 4),
  dirEntry('empty'),
  blob('r.txt', 5),
]);

const COMMIT = 'c'.repeat(40);
const alpha = makeItem({ id: 1, name: 'alpha', defaultBranch: 'main' });
const beta = makeItem({ id: 2, name: 'beta', defaultBranch: 'main' });

const onUnauthorized = vi.fn();
const onBack = vi.fn();

const route = (name: string, fixture: FixtureTree, path: string) =>
  `GET ${GH}/repos/octo/${name}/git/trees/${fixture.shaOf(path)}`;

/** The branch, the (cut-off) recursive root, and every folder's direct listing. */
function lazyRoutes(
  name: string,
  fixture: FixtureTree,
  overrides: Record<string, Handler> = {},
): Record<string, Handler> {
  const routes: Record<string, Handler> = {
    [`GET ${GH}/repos/octo/${name}/branches/main`]: () =>
      Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: fixture.shaOf('') } } } }),
  };
  for (const path of fixture.directories()) {
    routes[route(name, fixture, path)] = (request) =>
      request.url.searchParams.has('recursive')
        ? Response.json({ sha: fixture.shaOf(path), truncated: true, tree: [] })
        : okResponse(fixture, path);
  }
  return { ...routes, ...overrides };
}

function setup(overrides: Record<string, Handler> = {}, repo = alpha, strict = true) {
  const net = createFakeFetch({
    ...lazyRoutes('alpha', LAZY),
    ...lazyRoutes('beta', OTHER),
    ...overrides,
  });
  vi.stubGlobal('fetch', net.fetch);
  const element = (item = repo, token = TEST_TOKEN) => {
    const view = (
      <ArchitectureView
        repo={item}
        accessToken={token}
        onUnauthorized={onUnauthorized}
        onBack={onBack}
      />
    );
    return strict ? <StrictMode>{view}</StrictMode> : view;
  };
  const view = render(element());
  return { net, element, ...view };
}

const summaryShown = () => screen.findByRole('region', { name: 'Summary' });

const rowNames = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('th')?.textContent);

const open = (folder: string) => {
  fireEvent.click(screen.getByRole('button', { name: `Open folder ${folder}` }));
};

const stat = (label: string) =>
  within(screen.getByRole('region', { name: 'Summary' }))
    .getByText(label)
    .parentElement?.querySelector('dd')?.textContent;

const folderRequests = (net: ReturnType<typeof setup>['net']) =>
  net.requests.filter((request) => request.url.pathname.includes('/git/trees/'));

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onUnauthorized.mockClear();
  onBack.mockClear();
});

describe('ArchitectureView: a repository read folder by folder', () => {
  it('shows the root straight away, with folders not yet loaded and nothing made up', async () => {
    const { net } = setup();
    await summaryShown();

    expect(screen.getByText('Partial · 1 file counted')).toBeTruthy();
    expect(screen.getByText(/Folders are loaded one at a time/)).toBeTruthy();
    expect(screen.getByText(/2 have not been loaded yet/)).toBeTruthy();
    expect(rowNames()).toEqual(['docs/', 'src/', 'README.md']);

    const docs = screen.getByRole('row', { name: /docs/ });
    expect(within(docs).getByText('Folder · not loaded')).toBeTruthy();
    expect(within(docs).getAllByText('—').length).toBe(2); // size and file count: unknown, not 0
    // Only the branch and the root were read (twice each: Strict Mode runs the load effect twice).
    const root = `/repos/octo/alpha/git/trees/${LAZY.shaOf('')}`;
    expect(
      net.requests.every(
        (r) => r.url.pathname.endsWith('/branches/main') || r.url.pathname === root,
      ),
    ).toBe(true);
  });

  it('loads a folder when it is opened, then a nested one', async () => {
    const { net } = setup();
    await summaryShown();

    open('src');
    // The folder's own state is shown while its listing is on its way.
    await screen.findByRole('row', { name: /index\.ts/ });
    expect(rowNames()).toEqual(['util/', 'index.ts']);
    expect(screen.getByRole('heading', { name: 'Contents of src' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Contents of src' }));
    expect(stat('Files')).toBe('≥ 2');
    expect(screen.getByText(/2 have not been loaded yet/)).toBeTruthy();

    open('util');
    await screen.findByRole('row', { name: /math\.ts/ });
    expect(rowNames()).toEqual(['math.ts']);
    expect(stat('Files')).toBe('≥ 3');
    expect(stat('Total size')).toBe('≥ 450 B');
    expect(screen.getByText(/1 has not been loaded yet/)).toBeTruthy();

    const requested = folderRequests(net).map((request) => request.url.pathname);
    expect(requested).toContain(`/repos/octo/alpha/git/trees/${LAZY.shaOf('src')}`);
    expect(requested).toContain(`/repos/octo/alpha/git/trees/${LAZY.shaOf('src/util')}`);
    // Only the root was ever asked for recursively; folders are always direct listings.
    const recursive = folderRequests(net).filter((r) => r.url.searchParams.has('recursive'));
    expect(recursive.every((r) => r.url.pathname.endsWith(LAZY.shaOf('')))).toBe(true);
  });

  it('shows the folder as loading while its listing is on its way, instead of an empty folder', async () => {
    const slow = gated(() => okResponse(LAZY, 'docs'));
    setup({ [route('alpha', LAZY, 'docs')]: slow.handler });
    await summaryShown();

    open('docs');
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.folderLoading)).toBeTruthy();
    expect(screen.queryByText('This folder is empty.')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();

    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await screen.findByRole('row', { name: /guide\.md/ });
    expect(screen.queryByText(ARCHITECTURE_MESSAGES.folderLoading)).toBeNull();
  });

  it('becomes complete once every folder has been loaded', async () => {
    setup();
    await summaryShown();

    for (const folder of ['docs', 'src']) {
      open(folder);
      await screen.findByRole('table');
      await waitFor(() => {
        expect(screen.queryByText(ARCHITECTURE_MESSAGES.folderLoading)).toBeNull();
      });
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', {
          name: 'alpha',
        }),
      );
    }
    open('src');
    open('util');
    await screen.findByRole('row', { name: /math\.ts/ });

    expect(screen.getByText('Complete · 4 files')).toBeTruthy();
    expect(screen.queryByText(/Counts and sizes below are lower bounds/)).toBeNull();
  });

  it('does not request a folder twice, however often it is opened', async () => {
    const { net } = setup();
    await summaryShown();
    const crumbs = () => screen.getByRole('navigation', { name: 'Breadcrumb' });

    for (let round = 0; round < 3; round += 1) {
      open('docs');
      await screen.findByRole('row', { name: /guide\.md/ });
      fireEvent.click(within(crumbs()).getByRole('button', { name: 'alpha' }));
    }
    const docs = `/repos/octo/alpha/git/trees/${LAZY.shaOf('docs')}`;
    expect(net.requests.filter((request) => request.url.pathname === docs)).toHaveLength(1);
  });
});

describe('ArchitectureView: folder errors and retry', () => {
  it('explains a failure for that folder, without echoing GitHub, and "Try again" recovers', async () => {
    let failing = true;
    const { container, net } = setup({
      [route('alpha', LAZY, 'src')]: (request) =>
        request.url.searchParams.has('recursive')
          ? Response.json({ sha: LAZY.shaOf('src'), truncated: true, tree: [] })
          : failing
            ? new Response('{"message":"secret details"}', { status: 503 })
            : okResponse(LAZY, 'src'),
    });
    await summaryShown();

    open('src');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(REPOSITORY_MESSAGES.generic);
    expect(container.textContent).not.toContain('secret details');
    // The rest of the tree is still there and still honest.
    expect(screen.getByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(screen.getByText('Partial · 1 file counted')).toBeTruthy();

    failing = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('row', { name: /index\.ts/ });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(net.requests.filter((r) => r.url.pathname.endsWith(LAZY.shaOf('src')))).toHaveLength(2);
  });

  it('offers no retry for a failure that retrying cannot fix', async () => {
    const { net } = setup({
      [route('alpha', LAZY, 'src')]: () => new Response('{}', { status: 404 }),
    });
    await summaryShown();
    open('src');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(ARCHITECTURE_MESSAGES.folderNotFound);
    expect(within(alert).queryByRole('button')).toBeNull();
    expect(net.requests.filter((r) => r.url.pathname.endsWith(LAZY.shaOf('src')))).toHaveLength(1);

    // Another folder is unaffected.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', {
        name: 'alpha',
      }),
    );
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });
  });

  it("shows a failed folder as failed in its parent's table", async () => {
    setup({ [route('alpha', LAZY, 'src')]: () => new Response('{}', { status: 500 }) });
    await summaryShown();
    open('src');
    await screen.findByRole('alert');
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', {
        name: 'alpha',
      }),
    );
    expect(
      within(screen.getByRole('row', { name: /src/ })).getByText('Folder · failed to load'),
    ).toBeTruthy();
  });
});

describe('ArchitectureView: rate limits and authentication', () => {
  it("shows GitHub's rate limit, and does not request while it lasts", async () => {
    const { net } = setup({
      [route('alpha', LAZY, 'src')]: (request) =>
        request.url.searchParams.has('recursive')
          ? Response.json({ sha: LAZY.shaOf('src'), truncated: true, tree: [] })
          : new Response('{}', {
              status: 429,
              headers: { 'x-ratelimit-reset': '2000000000' },
            }),
    });
    await summaryShown();

    open('src');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(REPOSITORY_MESSAGES.rateLimited);
    expect(screen.getByText(/Folders can be loaded again after/)).toBeTruthy();

    // Opening another folder makes no request; it can be loaded by hand later.
    const before = folderRequests(net).length;
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', {
        name: 'alpha',
      }),
    );
    open('docs');
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.folderNotLoaded)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load this folder' })).toBeTruthy();
    expect(folderRequests(net)).toHaveLength(before);
  });

  it('ends the session on a 401 from a folder', async () => {
    setup({
      [route('alpha', LAZY, 'src')]: (request) =>
        request.url.searchParams.has('recursive')
          ? Response.json({ sha: LAZY.shaOf('src'), truncated: true, tree: [] })
          : new Response('{}', { status: 401 }),
    });
    await summaryShown();
    open('src');
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.unauthorized)).toBeTruthy();
    // The folder is not reported as an ordinary failure.
    expect(screen.queryByText(ARCHITECTURE_MESSAGES.folderUnusable)).toBeNull();
  });
});

describe('ArchitectureView: what GitHub could not list', () => {
  const cutOff = (path: string) => (request: { url: URL }) =>
    request.url.searchParams.has('recursive')
      ? Response.json({ sha: LAZY.shaOf(path), truncated: true, tree: [] })
      : Response.json({
          sha: LAZY.shaOf(path),
          truncated: true,
          tree: LAZY.listing(path).entries,
        });

  it('never says a cut-off folder can be completed by asking again', async () => {
    setup({ [route('alpha', LAZY, 'docs')]: cutOff('docs') });
    await summaryShown();
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });

    expect(screen.getByText(/GitHub cut off the listing of 1 folder/)).toBeTruthy();
    expect(screen.getAllByText(/asking again will not bring them back/)).toHaveLength(2);
    expect(screen.getByText(/GitHub cut off this folder's listing/)).toBeTruthy();
    expect(screen.getByText('Partial · 2 files counted')).toBeTruthy();
    // And nothing on offer to reload it.
    expect(
      screen.queryByRole('button', { name: /refresh|reload|load again|try again/i }),
    ).toBeNull();
  });

  it('keeps a root that GitHub cut off partial, even after every folder is loaded', async () => {
    setup({ [route('alpha', LAZY, '')]: cutOff('') });
    await summaryShown();
    expect(screen.getByText(/GitHub cut off the listing of 1 folder/)).toBeTruthy();
    for (const folder of ['docs', 'src']) {
      open(folder);
      await screen.findByRole('table');
      await waitFor(() => {
        expect(screen.queryByText(ARCHITECTURE_MESSAGES.folderLoading)).toBeNull();
      });
      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('button', {
          name: 'alpha',
        }),
      );
    }
    expect(screen.queryByText(/^Complete/)).toBeNull();
    expect(screen.getByText(/lower bounds, not totals/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /refresh|reload|load again/i })).toBeNull();
  });
});

describe('ArchitectureView: lifecycle', () => {
  it('ignores a folder that answers after the view was closed', async () => {
    const slow = gated(() => okResponse(LAZY, 'docs'));
    const { net, unmount } = setup({ [route('alpha', LAZY, 'docs')]: slow.handler });
    await summaryShown();
    open('docs');
    await screen.findByText(ARCHITECTURE_MESSAGES.folderLoading);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    const docsRequest = net.requests.find((r) => r.url.pathname.endsWith(LAZY.shaOf('docs')));
    expect(docsRequest?.init.signal?.aborted).toBe(true);

    slow.release();
    await act(async () => {
      await Promise.resolve();
    });
    expect(errors).not.toHaveBeenCalled();
  });

  it("starts again from the new repository, and ignores the old one's late answers", async () => {
    const slow = gated(() => okResponse(LAZY, 'docs'));
    const { element, rerender } = setup({ [route('alpha', LAZY, 'docs')]: slow.handler });
    await summaryShown();
    open('docs');
    await screen.findByText(ARCHITECTURE_MESSAGES.folderLoading);

    rerender(element(beta));
    await waitFor(() => {
      expect(rowNames()).toEqual(['lib/', 'LICENSE']);
    });
    expect(screen.getByRole('heading', { name: 'octo/beta · Architecture' })).toBeTruthy();

    slow.release();
    await act(async () => {
      await Promise.resolve();
    });
    expect(rowNames()).toEqual(['lib/', 'LICENSE']);
    expect(screen.queryByText(/guide\.md/)).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  it('starts again from the root when the token changes', async () => {
    const { net, element, rerender } = setup();
    await summaryShown();
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });

    rerender(element(alpha, 'ghu_another_token'));
    await waitFor(() => {
      expect(rowNames()).toEqual(['docs/', 'src/', 'README.md']);
    });
    expect(
      within(screen.getByRole('row', { name: /docs/ })).getByText('Folder · not loaded'),
    ).toBeTruthy();

    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });
    const last = folderRequests(net).at(-1);
    expect(last?.headers.get('authorization')).toBe('Bearer ghu_another_token');
  });

  it('works without Strict Mode too', async () => {
    const { net } = setup({}, alpha, false);
    await summaryShown();
    open('src');
    await screen.findByRole('row', { name: /index\.ts/ });
    expect(folderRequests(net)).toHaveLength(3); // the recursive root, the root, and src
  });
});

// -----------------------------------------------------------------------------------------------
// Review fixes: unauthorized state, focus, lower bounds, stale trees, folders without a SHA
// -----------------------------------------------------------------------------------------------

const crumbs = () => screen.getByRole('navigation', { name: 'Breadcrumb' });
const toRoot = () => {
  fireEvent.click(within(crumbs()).getByRole('button', { name: 'alpha' }));
};
const heading = (name: string) => screen.getByRole('heading', { name });

/** Answers the folder's direct listing with `respond`, and its (cut-off) recursive one as usual. */
const direct =
  (path: string, respond: Handler): Handler =>
  (request) =>
    request.url.searchParams.has('recursive')
      ? Response.json({ sha: LAZY.shaOf(path), truncated: true, tree: [] })
      : respond(request);

describe('ArchitectureView: after the session has ended', () => {
  it('offers no way to load a folder, keeps what was loaded, and asks for nothing more', async () => {
    const { net } = setup({
      [route('alpha', LAZY, 'src')]: direct('src', () => new Response('{}', { status: 401 })),
    });
    await summaryShown();

    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });
    toRoot();
    open('src');
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.unauthorized)).toBeTruthy();
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });

    // The folder that was being asked for is shown as not loaded, with nothing to click.
    expect(screen.getByText(ARCHITECTURE_MESSAGES.folderNotLoaded)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load this folder' })).toBeNull();

    // Another folder nobody asked for yet: same, and opening it makes no request.
    toRoot();
    const before = folderRequests(net).length;
    open('docs');
    expect(screen.getByRole('row', { name: /guide\.md/ })).toBeTruthy(); // data kept
    toRoot();
    expect(screen.getByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(folderRequests(net)).toHaveLength(before);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('no longer offers "Try again" for a folder that failed before', async () => {
    setup({
      [route('alpha', LAZY, 'src/util')]: direct(
        'src/util',
        () => new Response('{}', { status: 503 }),
      ),
      [route('alpha', LAZY, 'docs')]: direct('docs', () => new Response('{}', { status: 401 })),
    });
    await summaryShown();

    open('src');
    await screen.findByRole('row', { name: /index\.ts/ });
    open('util');
    const failed = await screen.findByRole('alert');
    expect(within(failed).getByRole('button', { name: 'Try again' })).toBeTruthy();

    toRoot();
    open('docs'); // GitHub rejects the token
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.unauthorized)).toBeTruthy();

    toRoot();
    open('src');
    open('util');
    expect(screen.getByText(REPOSITORY_MESSAGES.generic)).toBeTruthy(); // still explained
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });
});

describe('ArchitectureView: where focus goes when a control is replaced', () => {
  const limitedSrc = direct(
    'src',
    () => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '2000000000' } }),
  );

  it('moves it to the folder contents when "Load this folder" gives way to loading', async () => {
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const slow = gated(() => okResponse(LAZY, 'docs'));
    setup({
      [route('alpha', LAZY, 'src')]: limitedSrc,
      [route('alpha', LAZY, 'docs')]: slow.handler,
    });
    await summaryShown();

    open('src');
    await screen.findByText(/Folders can be loaded again after/);
    toRoot();
    open('docs'); // held back by the rate limit: nothing was requested
    const button = screen.getByRole('button', { name: 'Load this folder' });
    button.focus();

    // Still held back: the button is still there, and so is focus. Nothing jumps.
    fireEvent.click(button);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Load this folder' }));

    clock = 2_000_000_001_000; // GitHub's reset time has passed
    fireEvent.click(screen.getByRole('button', { name: 'Load this folder' }));
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.folderLoading)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load this folder' })).toBeNull();
    expect(document.activeElement).toBe(heading('Contents of docs'));

    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await screen.findByRole('row', { name: /guide\.md/ });
  });

  it('moves it to the folder contents when "Try again" gives way to loading', async () => {
    let failing = true;
    const slow = gated(() => okResponse(LAZY, 'src'));
    setup({
      [route('alpha', LAZY, 'src')]: direct('src', (request) =>
        failing ? new Response('{}', { status: 503 }) : slow.handler(request),
      ),
    });
    await summaryShown();

    open('src');
    const retry = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    retry.focus();
    expect(document.activeElement).toBe(retry);

    failing = false;
    fireEvent.click(retry);
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.folderLoading)).toBeTruthy();
    expect(document.activeElement).toBe(heading('Contents of src'));

    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await screen.findByRole('row', { name: /index\.ts/ });
    expect(document.activeElement).toBe(heading('Contents of src')); // and it stays there
  });

  it('moves it to the page heading when the tree-level "Try again" gives way to loading', async () => {
    let failing = true;
    setup({
      [`GET ${GH}/repos/octo/alpha/branches/main`]: () =>
        failing
          ? new Response('{}', { status: 500 })
          : Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: LAZY.shaOf('') } } } }),
    });
    const retry = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    retry.focus();

    failing = false;
    fireEvent.click(retry);
    expect(await screen.findByText('Loading file tree…')).toBeTruthy();
    expect(document.activeElement).toBe(heading('octo/alpha · Architecture'));
    await summaryShown();
  });

  it('leaves focus alone when a folder arrives in the background', async () => {
    const slow = gated(() => okResponse(LAZY, 'docs'));
    setup({ [route('alpha', LAZY, 'docs')]: slow.handler });
    await summaryShown();

    open('docs');
    await screen.findByText(ARCHITECTURE_MESSAGES.folderLoading);
    toRoot();
    const radio = screen.getByRole('radio', { name: 'File count' });
    radio.focus();

    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.queryByText('Folder · loading…')).toBeNull();
    });
    expect(document.activeElement).toBe(radio);
  });

  it('keeps focus where it is when a button is replaced while something else has focus', async () => {
    let failing = true;
    setup({
      [route('alpha', LAZY, 'src')]: direct('src', () =>
        failing ? new Response('{}', { status: 503 }) : okResponse(LAZY, 'src'),
      ),
    });
    await summaryShown();

    open('src');
    const retry = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    const radio = screen.getByRole('radio', { name: 'File count' });
    radio.focus();

    failing = false;
    fireEvent.click(retry); // activated without moving focus onto it, as a script or a tap can
    await screen.findByRole('row', { name: /index\.ts/ });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(document.activeElement).toBe(radio);
  });

  it('does not take focus from a button that is still there when the view re-renders', async () => {
    const { rerender, element } = setup({
      [route('alpha', LAZY, 'src')]: direct('src', () => new Response('{}', { status: 503 })),
    });
    await summaryShown();

    open('src');
    const retry = within(await screen.findByRole('alert')).getByRole('button', {
      name: 'Try again',
    });
    retry.focus();

    // React puts focus back after a commit, so watch for the attempt to move it rather than for
    // where it ends up.
    const moved = vi.spyOn(heading('Contents of src'), 'focus');
    rerender(element());
    rerender(element());
    expect(moved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBe(retry);
    expect(document.activeElement).toBe(retry);
  });
});

describe('ArchitectureView: lower bounds', () => {
  const cells = (folder: RegExp) =>
    within(screen.getByRole('row', { name: folder }))
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
  const tileTitles = (container: HTMLElement) =>
    [...container.querySelectorAll('svg title')].map((title) => title.textContent);

  it('marks a size or count with ≥ only while it is a lower bound', async () => {
    const { container } = setup();
    await summaryShown();

    // Nothing loaded below the root: unknown, not zero, and not "at least" anything either.
    expect(cells(/docs/)).toEqual(['Folder · not loaded', '—', '—']);
    expect(cells(/README/)).toEqual(['File', formatBytes(100), '—']);

    // src is listed, but src/util is not: what is shown for src is a lower bound.
    open('src');
    await screen.findByRole('row', { name: /index\.ts/ });
    toRoot();
    expect(cells(/src/)).toEqual(['Folder', `≥ ${formatBytes(300)}`, '≥ 1']);
    expect(tileTitles(container)).toContain(`src/: ≥ ${formatBytes(300)}`);
    expect(tileTitles(container)).toContain(`README.md: ${formatBytes(100)}`);

    fireEvent.click(screen.getByRole('radio', { name: 'File count' }));
    expect(tileTitles(container)).toContain('src/: ≥ 1 file');
    expect(tileTitles(container)).toContain('README.md: 1 file');

    // docs is listed completely: exact, so no mark.
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });
    toRoot();
    expect(cells(/docs/)).toEqual(['Folder', formatBytes(1050), '1']);
    expect(tileTitles(container)).toContain('docs/: 1 file');

    // Once src/util is loaded too, src becomes exact and loses its mark.
    open('src');
    open('util');
    await screen.findByRole('row', { name: /math\.ts/ });
    toRoot();
    expect(cells(/src/)).toEqual(['Folder', formatBytes(350), '2']);
    expect(tileTitles(container).some((title) => title?.includes('≥'))).toBe(false);
  });

  it('shows every summary figure as a lower bound while the tree is partial, with the note', async () => {
    setup();
    await summaryShown();
    expect(screen.getByText(/Counts and sizes below are lower bounds, not totals/)).toBeTruthy();
    expect(stat('Files')).toBe('≥ 1');
    expect(stat('Folders')).toBe('≥ 2');
    expect(stat('Total size')).toBe(`≥ ${formatBytes(100)}`);
    expect(stat('Deepest level')).toMatch(/^≥ \d+$/);
  });

  it('drops every mark once the whole tree is listed', async () => {
    setup();
    await summaryShown();
    open('src');
    await screen.findByRole('row', { name: /index\.ts/ });
    open('util');
    await screen.findByRole('row', { name: /math\.ts/ });
    toRoot();
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });

    expect(screen.getByText(/Complete · 4 files/)).toBeTruthy();
    expect(stat('Files')).toBe('4');
    expect(stat('Folders')).toBe('3');
    expect(stat('Total size')).toBe(formatBytes(1500));
    const summary = within(screen.getByRole('region', { name: 'Summary' }));
    expect(summary.queryByText(/≥/)).toBeNull();
    expect(summary.queryByText(/lower bounds/)).toBeNull();
  });

  it('says folders not loaded yet have no known size yet, not that they have none to measure', async () => {
    setup();
    await summaryShown();

    // docs and src are not loaded: unknown, and the note must not call them empty.
    expect(screen.getByText(/2 folders have no known size yet/)).toBeTruthy();
    expect(screen.queryByText(/to measure/)).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'File count' }));
    expect(screen.getByText(/2 folders have no known file count yet/)).toBeTruthy();
    expect(screen.queryByText(/to measure/)).toBeNull();

    // Once docs is listed, only src is still unknown.
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });
    toRoot();
    expect(screen.getByText(/1 folder has no known file count yet/)).toBeTruthy();
  });

  it('does not say a root of unloaded folders has nothing to measure', async () => {
    setup(lazyRoutes('alpha', FOLDERS));
    await summaryShown();

    expect(
      screen.getByText(/Nothing to draw here yet\. 2 folders have no known size yet\./),
    ).toBeTruthy();
    expect(screen.queryByText(/nothing in this folder has a size to measure/)).toBeNull();
  });

  describe('a zero that is only a floor', () => {
    const row = (name: string) => cellsOf(new RegExp(`^${name}/ Folder`));
    const cellsOf = (pattern: RegExp) =>
      within(screen.getByRole('row', { name: pattern }))
        .getAllByRole('cell')
        .map((cell) => cell.textContent);

    async function openBoth() {
      setup(lazyRoutes('alpha', NESTED));
      await summaryShown();
      open('a');
      await screen.findByRole('row', { name: /sub/ });
      toRoot();
      open('empty');
      await screen.findByText('This folder is empty.');
      toRoot();
    }

    it('shows "—" in the table for a listed folder with only unloaded folders below it', async () => {
      await openBoth();
      expect(row('a')).toEqual(['Folder', '—', '—']);
      expect(screen.getByRole('row', { name: /^a\/ / }).textContent).not.toContain('≥');
    });

    it('still shows an exact empty folder as 0 and 0 B', async () => {
      await openBoth();
      expect(row('empty')).toEqual(['Folder', '0 B', '0']);
    });

    it('still marks an inexact positive figure with ≥', async () => {
      setup();
      await summaryShown();
      open('src');
      await screen.findByRole('row', { name: /index\.ts/ });
      toRoot();
      expect(cellsOf(/^src\/ Folder/)).toEqual(['Folder', `≥ ${formatBytes(300)}`, '≥ 1']);
    });

    it('describes such a folder in the treemap note as unknown, apart from a really empty one', async () => {
      setup(lazyRoutes('alpha', NESTED));
      await summaryShown();
      // Nothing is loaded: both folders are unknown.
      expect(screen.getByText(/^2 folders have no known size yet\./)).toBeTruthy();

      open('a');
      await screen.findByRole('row', { name: /sub/ });
      toRoot();
      // `a` is listed but only adds a zero so far, so it is still unknown; `empty` is not loaded.
      expect(screen.getByText(/^2 folders have no known size yet\./)).toBeTruthy();
      expect(screen.queryByText(/to measure/)).toBeNull();

      open('empty');
      await screen.findByText('This folder is empty.');
      toRoot();
      // Now `empty` is a known zero and `a` is still unknown.
      expect(
        screen.getByText(
          '1 folder has no known size yet. 1 entry has no size to measure. They are not drawn; the table lists every entry.',
        ),
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('radio', { name: 'File count' }));
      expect(
        screen.getByText(
          '1 folder has no known file count yet. 1 entry has no file count to measure. They are not drawn; the table lists every entry.',
        ),
      ).toBeTruthy();
    });
  });

  it('shows "—", never "≥ 0", for a figure that has only a floor of zero', async () => {
    // The root lists two folders and no files: nothing is known about files or sizes yet.
    setup(lazyRoutes('alpha', FOLDERS));
    await summaryShown();

    expect(stat('Files')).toBe('—');
    expect(stat('Total size')).toBe('—');
    expect(stat('Folders')).toBe('≥ 2');
    expect(within(screen.getByRole('region', { name: 'Summary' })).queryByText(/≥ 0/)).toBeNull();
  });
});

describe('ArchitectureView: a repository that changes under the view', () => {
  const branchRoute = (name: string) => `GET ${GH}/repos/octo/${name}/branches/main`;
  const branchBody = (fixture: FixtureTree) =>
    Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: fixture.shaOf('') } } } });

  it("never shows one repository's tree under another, even without a remount", async () => {
    const slowBeta = gated(() => branchBody(OTHER));
    const { net, element, rerender } = setup({ [branchRoute('beta')]: slowBeta.handler });
    await summaryShown();
    expect(screen.getByRole('button', { name: 'Open folder docs' })).toBeTruthy();

    rerender(element(beta));
    // At once: the new repository's heading, loading, and none of alpha's folders to click.
    expect(heading('octo/beta · Architecture')).toBeTruthy();
    expect(screen.getByText('Loading file tree…')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open folder docs' })).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();

    await act(async () => {
      slowBeta.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(rowNames()).toEqual(['lib/', 'LICENSE']);
    });
    // Nothing was ever asked of beta with alpha's data; its own folder is asked for as usual.
    expect(net.requests.some((r) => r.url.pathname.startsWith('/repos/octo/beta/git/trees/'))).toBe(
      true,
    ); // its root, from its own tree
    open('lib');
    await screen.findByRole('row', { name: /x\.js/ });
    expect(
      net.requests.some(
        (r) => r.url.pathname === `/repos/octo/beta/git/trees/${OTHER.shaOf('lib')}`,
      ),
    ).toBe(true);
  });

  it('does not show a tree to a different token either, until its own arrives', async () => {
    const OTHER_TOKEN = 'ghu_another_token';
    const slow = gated(() => branchBody(LAZY));
    const { element, rerender } = setup({
      [branchRoute('alpha')]: (request) =>
        request.headers.get('authorization') === `Bearer ${OTHER_TOKEN}`
          ? slow.handler(request)
          : branchBody(LAZY),
    });
    await summaryShown();

    rerender(element(alpha, OTHER_TOKEN));
    expect(screen.getByText('Loading file tree…')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();

    await act(async () => {
      slow.release();
      await Promise.resolve();
    });
    await summaryShown();
    expect(rowNames()).toEqual(['docs/', 'src/', 'README.md']);
  });

  it('does not fetch again when nothing it was asked for has changed', async () => {
    const { net, element, rerender } = setup({}, alpha, false);
    await summaryShown();
    open('docs');
    await screen.findByRole('row', { name: /guide\.md/ });
    const branchCalls = () =>
      net.requests.filter((r) => r.url.pathname.endsWith('/branches/main')).length;
    expect(branchCalls()).toBe(1);

    // The same repository again, in a new object.
    rerender(element({ ...alpha }));
    rerender(element({ ...alpha }));
    expect(branchCalls()).toBe(1);
    expect(screen.getByRole('row', { name: /guide\.md/ })).toBeTruthy(); // nothing was reset
  });
});

describe('ArchitectureView: folders GitHub gave no usable SHA for', () => {
  const NO_SHA_ROOT: Handler = (request) =>
    request.url.searchParams.has('recursive')
      ? Response.json({ sha: LAZY.shaOf(''), truncated: true, tree: [] })
      : Response.json({
          sha: LAZY.shaOf(''),
          truncated: false,
          tree: [
            { path: 'README.md', type: 'blob', mode: '100644', sha: 'a'.repeat(40), size: 100 },
            { path: 'docs', type: 'tree', mode: '040000', sha: LAZY.shaOf('docs') },
            { path: 'vendor', type: 'tree', mode: '040000', sha: 'not-a-sha' },
            { path: 'gone', type: 'tree', mode: '040000' },
          ],
        });

  it('tells apart a folder that can be loaded from one that never can', async () => {
    const { net } = setup({ [route('alpha', LAZY, '')]: NO_SHA_ROOT });
    await summaryShown();

    expect(
      within(screen.getByRole('row', { name: /docs/ })).getByText('Folder · not loaded'),
    ).toBeTruthy();
    for (const name of [/vendor/, /gone/]) {
      expect(
        within(screen.getByRole('row', { name })).getByText('Folder · cannot be loaded'),
      ).toBeTruthy();
    }

    // The note counts only the folder that opening can still bring in, and says why for the rest.
    const note = screen.getByText(/Folders are loaded one at a time/);
    expect(note.textContent).toMatch(/1 has not been loaded yet/);
    expect(note.textContent).toMatch(/2 folders cannot be loaded at all/);
    expect(note.textContent).toMatch(/did not give a usable identifier/);
    expect(note.textContent).toMatch(/Opening them will not change that/);
    expect(note.textContent).not.toMatch(/3 have not been loaded/);
    expect(note.textContent).not.toMatch(/2 have not been loaded/);

    // Opening one explains itself, offers nothing to click, and asks GitHub for nothing.
    const before = folderRequests(net).length;
    open('vendor');
    expect(screen.getByText(ARCHITECTURE_MESSAGES.folderNoSha)).toBeTruthy();
    expect(screen.queryByText(ARCHITECTURE_MESSAGES.folderNotLoaded)).toBeNull();
    expect(screen.queryByRole('button', { name: /load|try again/i })).toBeNull();
    expect(folderRequests(net)).toHaveLength(before);
  });
});
