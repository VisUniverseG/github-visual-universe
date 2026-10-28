import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARCHITECTURE_MESSAGES } from '../../architecture/messages.ts';
import { REPOSITORY_MESSAGES } from '../../dashboard/messages.ts';
import { TEST_TOKEN, createFakeFetch, type Handler } from '../../testing/fakeFetch.ts';
import { makeItem } from '../../testing/fixtures.ts';
import { MAX_ROWS } from './DirectoryTable.tsx';
import { ArchitectureView } from './ArchitectureView.tsx';

const GH = 'https://api.github.com';
const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const BRANCH = `GET ${GH}/repos/octo/alpha/branches/main`;
const TREE_ROUTE = `GET ${GH}/repos/octo/alpha/git/trees/${TREE}`;

const onUnauthorized = vi.fn();
const onBack = vi.fn();
const repo = makeItem({ id: 1, name: 'alpha', defaultBranch: 'main' });

const dir = (path: string) => ({ path, type: 'tree', mode: '040000', sha: 'e'.repeat(40) });
const file = (path: string, size?: number) => ({
  path,
  type: 'blob',
  mode: '100644',
  sha: 'e'.repeat(40),
  ...(size === undefined ? {} : { size }),
});

/**
 *   README.md 100 B
 *   docs/guide.md 1,050 B
 *   src/index.ts 300 B
 *   src/util/math.ts 50 B       -> 4 files, 3 folders, 1.5 KB, 3 levels deep
 */
const SAMPLE = [
  file('README.md', 100),
  dir('src'),
  file('src/index.ts', 300),
  dir('src/util'),
  file('src/util/math.ts', 50),
  dir('docs'),
  file('docs/guide.md', 1050),
];

const treeResponse = (tree: unknown[], truncated = false) =>
  Response.json({ sha: TREE, truncated, tree });

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [BRANCH]: () => Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: TREE } } } }),
    [TREE_ROUTE]: () => treeResponse(SAMPLE),
    ...overrides,
  };
}

function setup(overrides: Record<string, Handler> = {}) {
  const net = createFakeFetch(routes(overrides));
  vi.stubGlobal('fetch', net.fetch);
  const view = render(
    <StrictMode>
      <ArchitectureView
        repo={repo}
        accessToken={TEST_TOKEN}
        onUnauthorized={onUnauthorized}
        onBack={onBack}
      />
    </StrictMode>,
  );
  return { net, ...view };
}

async function loaded(overrides: Record<string, Handler> = {}) {
  const ctx = setup(overrides);
  await screen.findByRole('region', { name: 'Summary' });
  return ctx;
}

const stat = (label: string) =>
  within(screen.getByRole('region', { name: 'Summary' }))
    .getByText(label)
    .parentElement?.querySelector('dd')?.textContent;

const rowNames = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.querySelector('th')?.textContent);

const tileTitles = (container: HTMLElement) =>
  [...container.querySelectorAll('g.tile title')].map((title) => title.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onUnauthorized.mockClear();
  onBack.mockClear();
});

describe('ArchitectureView: loaded tree', () => {
  it('shows a loading state, then a complete summary of the whole tree', async () => {
    setup();
    expect(screen.getByText('Loading file tree…')).toBeTruthy();
    await screen.findByRole('region', { name: 'Summary' });

    expect(screen.getByText('Complete · 4 files')).toBeTruthy();
    expect(stat('Files')).toBe('4');
    expect(stat('Folders')).toBe('3');
    expect(stat('Total size')).toBe('1.5 KB');
    expect(stat('Deepest level')).toBe('3');
    expect(screen.queryByText(/Counts and sizes below are lower bounds/)).toBeNull();
  });

  it('states which branch and commit it is a snapshot of, and that no contents are read', async () => {
    await loaded();
    expect(screen.getByText('main')).toBeTruthy();
    expect(screen.getByText('ccccccc')).toBeTruthy();
    expect(screen.getByText(/never file contents/)).toBeTruthy();
  });

  it('reads only the branch and the tree, with GET requests to api.github.com', async () => {
    const { net } = await loaded();
    const paths = new Set(net.requests.map((r) => r.url.pathname));
    expect(paths).toEqual(
      new Set(['/repos/octo/alpha/branches/main', `/repos/octo/alpha/git/trees/${TREE}`]),
    );
    expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
  });

  it('lists folders first, then files, with sizes and file counts', async () => {
    await loaded();
    expect(rowNames()).toEqual(['docs/', 'src/', 'README.md']);
    const docs = screen.getByRole('row', { name: /docs/ });
    expect(within(docs).getByText('Folder')).toBeTruthy();
    expect(within(docs).getByText('1.1 KB')).toBeTruthy();
    const readme = screen.getByRole('row', { name: /README\.md/ });
    expect(within(readme).getByText('100 B')).toBeTruthy();
  });

  it('opens folders from the table, tracks the path, and moves focus to the new listing', async () => {
    await loaded();

    fireEvent.click(screen.getByRole('button', { name: 'Open folder src' }));
    expect(rowNames()).toEqual(['util/', 'index.ts']);
    const heading = screen.getByRole('heading', { name: 'Contents of src' });
    expect(document.activeElement).toBe(heading);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByText('src').getAttribute('aria-current')).toBe('page');

    fireEvent.click(screen.getByRole('button', { name: 'Open folder util' }));
    expect(rowNames()).toEqual(['math.ts']);
    expect(screen.getByRole('heading', { name: 'Contents of src/util' })).toBeTruthy();

    // Back up through the breadcrumb.
    fireEvent.click(within(crumbs).getByRole('button', { name: 'src' }));
    expect(rowNames()).toEqual(['util/', 'index.ts']);
    fireEvent.click(within(crumbs).getByRole('button', { name: 'alpha' }));
    expect(rowNames()).toEqual(['docs/', 'src/', 'README.md']);
  });

  it('draws a treemap whose folder tiles open that folder', async () => {
    const { container } = await loaded();
    expect(screen.getByRole('img', { name: /Treemap of the repository root/ })).toBeTruthy();
    expect(tileTitles(container)).toEqual(['docs/: 1.1 KB', 'src/: 350 B', 'README.md: 100 B']);

    const srcTile = [...container.querySelectorAll('g.tile')].find((tile) =>
      tile.querySelector('title')?.textContent?.startsWith('src/'),
    );
    fireEvent.click(srcTile as Element);
    expect(rowNames()).toEqual(['util/', 'index.ts']);
    expect(screen.getByRole('img', { name: /Treemap of src,/ })).toBeTruthy();
  });

  it('can size tiles by file count instead of bytes', async () => {
    const { container } = await loaded();
    fireEvent.click(screen.getByLabelText('File count'));
    expect(tileTitles(container)).toEqual(['src/: 2 files', 'docs/: 1 file', 'README.md: 1 file']);
    expect(screen.getByRole('img', { name: /sized by file count/ })).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Bytes'));
    expect(screen.getByRole('img', { name: /sized by size/ })).toBeTruthy();
  });

  it('marks nothing as a lower bound in a tree that is complete', async () => {
    const { container } = await loaded();
    expect(container.textContent).not.toContain('≥');
  });

  it('marks a size as a lower bound when a file in the folder has none, but not the count', async () => {
    const { container } = await loaded({
      [TREE_ROUTE]: () =>
        treeResponse([dir('docs'), file('docs/a.md'), file('docs/b.md', 10), file('top.md', 5)]),
    });
    const docs = within(screen.getByRole('row', { name: /docs/ })).getAllByRole('cell');
    expect(docs.map((cell) => cell.textContent)).toEqual(['Folder', '≥ 10 B', '2']);
    const top = within(screen.getByRole('row', { name: /top\.md/ })).getAllByRole('cell');
    expect(top.map((cell) => cell.textContent)).toEqual(['File', '5 B', '—']);
    expect(tileTitles(container)).toEqual(['docs/: ≥ 10 B', 'top.md: 5 B']);

    fireEvent.click(screen.getByLabelText('File count'));
    expect(tileTitles(container)).toEqual(['docs/: 2 files', 'top.md: 1 file']);
  });

  it('marks sizes and counts as lower bounds when entries could not be read', async () => {
    const { container } = await loaded({
      [TREE_ROUTE]: () =>
        treeResponse([
          dir('docs'),
          file('docs/a.md', 10),
          file('top.md', 5),
          { path: 'odd', type: 'banana', mode: '100644', sha: 'e'.repeat(40) },
        ]),
    });
    expect(screen.getByText(/could not be read and was left out/)).toBeTruthy();
    const docs = within(screen.getByRole('row', { name: /docs/ })).getAllByRole('cell');
    expect(docs.map((cell) => cell.textContent)).toEqual(['Folder', '≥ 10 B', '≥ 1']);
    expect(tileTitles(container)).toContain('docs/: ≥ 10 B');
    // A file is what it is.
    const top = within(screen.getByRole('row', { name: /top\.md/ })).getAllByRole('cell');
    expect(top.map((cell) => cell.textContent)).toEqual(['File', '5 B', '—']);
  });

  it('groups files by extension as a file count', async () => {
    await loaded();
    const types = screen.getByRole('region', { name: 'File types' });
    expect(within(types).getByText('.md')).toBeTruthy();
    expect(within(types).getByText('.ts')).toBeTruthy();
    expect(within(types).getAllByText('2 · 50%')).toHaveLength(2);
    expect(within(types).getByText(/not lines of code/)).toBeTruthy();
  });

  it('folds long folders behind "Show all"', async () => {
    const many = Array.from({ length: MAX_ROWS + 50 }, (_unused, index) =>
      file(`f${String(index).padStart(4, '0')}.txt`, 1),
    );
    await loaded({ [TREE_ROUTE]: () => treeResponse(many) });
    expect(rowNames()).toHaveLength(MAX_ROWS);
    expect(
      screen.getByText(`Showing ${String(MAX_ROWS)} of ${String(MAX_ROWS + 50)} entries.`, {
        exact: false,
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Show all ${String(MAX_ROWS + 50)}` }));
    expect(rowNames()).toHaveLength(MAX_ROWS + 50);
  });

  it('shows submodules and symlinks as what they are', async () => {
    await loaded({
      [TREE_ROUTE]: () =>
        treeResponse([
          file('a.txt', 5),
          { path: 'link', type: 'blob', mode: '120000', size: 3 },
          { path: 'vendor', type: 'commit', mode: '160000' },
        ]),
    });
    expect(stat('Symlinks')).toBe('1');
    expect(stat('Submodules')).toBe('1');
    expect(within(screen.getByRole('row', { name: /vendor/ })).getByText('Submodule')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /link/ })).getByText('Symlink')).toBeTruthy();
  });

  it('says so when files have no reported size, without making sizes up', async () => {
    await loaded({
      [TREE_ROUTE]: () => treeResponse([file('a.txt'), file('b.txt', 10)]),
    });
    expect(screen.getByText(/1 file has no size from GitHub and adds nothing/)).toBeTruthy();
    expect(stat('Total size')).toBe('≥ 10 B'); // a file with no size: a lower bound, not a total
    expect(
      within(screen.getByRole('row', { name: /a\.txt/ })).getAllByText('—').length,
    ).toBeGreaterThan(0);
  });

  it('tells an empty folder, an unsized file and a drawn file apart in the treemap note', async () => {
    const { container } = await loaded({
      [TREE_ROUTE]: () => treeResponse([dir('empty'), file('a.txt'), file('b.txt', 10)]),
    });
    // The empty folder is a known zero; the file has an unknown size. Neither is drawn.
    expect(
      screen.getByText(
        '1 file has no size from GitHub. 1 entry has no size to measure. They are not drawn; the table lists every entry.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no known size yet/)).toBeNull();
    expect(tileTitles(container)).toEqual(['b.txt: 10 B']);
  });

  it('says so when the repository has no files on this branch', async () => {
    setup({ [TREE_ROUTE]: () => treeResponse([]) });
    expect(await screen.findByText(ARCHITECTURE_MESSAGES.noFiles)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
  });
});

describe('ArchitectureView: incomplete data is never shown as complete', () => {
  it('labels a truncated listing partial and explains why', async () => {
    // A truncated recursive listing is discarded; only the root's direct children are shown.
    await loaded({
      [TREE_ROUTE]: (request) =>
        request.url.searchParams.has('recursive')
          ? treeResponse(SAMPLE, true)
          : treeResponse([file('README.md', 100), dir('src'), dir('docs')]),
    });
    expect(screen.getByText('Partial · 1 file counted')).toBeTruthy();
    expect(screen.getByText(/GitHub cut this listing off/)).toBeTruthy();
    expect(screen.getByText(/lower bounds, not totals/)).toBeTruthy();
    expect(screen.queryByText(/^Complete/)).toBeNull();
  });

  it('labels the listing partial when entries could not be read', async () => {
    await loaded({
      [TREE_ROUTE]: () => treeResponse([...SAMPLE, { path: 'x', type: 'unknown-kind' }]),
    });
    expect(screen.getByText('Partial · 4 files counted')).toBeTruthy();
    expect(screen.getByText(/1 entry in GitHub's response could not be read/)).toBeTruthy();
  });

  it('labels the listing partial when entries contradict each other', async () => {
    await loaded({
      [TREE_ROUTE]: () => treeResponse([file('a', 1), file('a/b.txt', 1), file('c.txt', 1)]),
    });
    expect(screen.getByText('Partial · 2 files counted')).toBeTruthy();
    expect(screen.getByText(/1 entry in GitHub's response could not be read/)).toBeTruthy();
  });
});

describe('ArchitectureView: nothing readable', () => {
  it('does not claim "no files" when the listing was cut off or unreadable', async () => {
    setup({
      [TREE_ROUTE]: () => treeResponse([{ path: 'x', type: 'unknown-kind' }], true),
    });
    expect(await screen.findByText(/GitHub cut this listing off/)).toBeTruthy();
    expect(screen.getByText(/1 entry in GitHub's response could not be read/)).toBeTruthy();
    expect(screen.queryByText(ARCHITECTURE_MESSAGES.noFiles)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
  });
});

describe('ArchitectureView: failures', () => {
  const failing = (status: number, headers: Record<string, string> = {}) => ({
    [TREE_ROUTE]: () => new Response('{"message":"secret details"}', { status, headers }),
  });

  it.each([
    ['an empty repository', failing(409), ARCHITECTURE_MESSAGES.empty],
    [
      'a missing branch or no access',
      { [BRANCH]: () => new Response('{}', { status: 404 }) },
      ARCHITECTURE_MESSAGES.notFound,
    ],
    ['missing Contents access', failing(403), ARCHITECTURE_MESSAGES.forbidden],
    [
      'a network failure',
      { [BRANCH]: () => Promise.reject(new TypeError('offline')) },
      REPOSITORY_MESSAGES.network,
    ],
    ['an unexpected response', failing(500), REPOSITORY_MESSAGES.generic],
  ])('explains %s without echoing GitHub text', async (_name, overrides, message) => {
    const { container } = setup(overrides);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(container.textContent).not.toContain('secret details');
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
  });

  it('explains a rate limit, and "Try again" recovers', async () => {
    let limited = true;
    setup({
      [TREE_ROUTE]: () =>
        limited
          ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
          : treeResponse(SAMPLE),
    });
    expect((await screen.findByRole('alert')).textContent).toContain('rate limit');

    limited = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('ends the session on a 401 instead of showing an error', async () => {
    setup(failing(401));
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ArchitectureView: hardening', () => {
  it('goes back through the Back button', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('moves focus to its heading when it opens', () => {
    setup();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'octo/alpha · Architecture' }),
    );
  });

  it('draws with no inline styles, no links, and never puts the token in the page', async () => {
    const { container } = await loaded();
    expect(container.querySelectorAll('[style]')).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.innerHTML).not.toContain(TEST_TOKEN);
  });

  it('shows hostile path names as inert text', async () => {
    const { container } = await loaded({
      [TREE_ROUTE]: () =>
        treeResponse([
          file('evil\u202Etxt.exe', 1),
          file('<img src=x onerror=alert(1)>.txt', 1),
          file('../../etc/passwd', 1),
        ]),
    });
    const table = within(screen.getByRole('table'));
    expect(table.getByText('evil\uFFFDtxt.exe')).toBeTruthy();
    expect(table.getByText('<img src=x onerror=alert(1)>.txt')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toMatch(/[\u202a-\u202e]/);
    // ".." is just a folder name: nothing is resolved, and no extra request is made.
    expect(rowNames()).toContain('../');
  });
});
