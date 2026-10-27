import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, fakeRepo, type Handler } from '../../testing/fakeFetch.ts';
import { RepositoryDashboard } from './RepositoryDashboard.tsx';

const GH = 'https://api.github.com';
const COMMIT = 'c'.repeat(40);
const TREE = 'd'.repeat(40);
const onUnauthorized = vi.fn();

const treeBody = (tree: unknown[]) => ({ sha: TREE, truncated: false, tree });
const file = (path: string, size: number) => ({ path, type: 'blob', mode: '100644', size });

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`GET ${GH}/user`]: () => Response.json({ login: 'octo' }),
    [`GET ${GH}/user/installations`]: () =>
      Response.json({ total_count: 1, installations: [{ id: 7, account: { login: 'octo' } }] }),
    [`GET ${GH}/user/installations/7/repositories`]: () =>
      Response.json({
        total_count: 2,
        repositories: [
          fakeRepo(1, 'alpha', { default_branch: 'main', language: 'TypeScript' }),
          // No default_branch from the list: the view must ask GitHub for it.
          fakeRepo(2, 'beta'),
        ],
      }),
    [`GET ${GH}/repos/octo/alpha/branches/main`]: () =>
      Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: TREE } } } }),
    [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () =>
      Response.json(treeBody([file('a.ts', 10), file('b.md', 20)])),
    [`GET ${GH}/repos/octo/beta`]: () => Response.json({ default_branch: 'trunk' }),
    [`GET ${GH}/repos/octo/beta/branches/trunk`]: () =>
      Response.json({ commit: { sha: COMMIT, commit: { tree: { sha: TREE } } } }),
    [`GET ${GH}/repos/octo/beta/git/trees/${TREE}`]: () =>
      Response.json(treeBody([file('only.txt', 1)])),
    ...overrides,
  };
}

async function openDashboard(overrides: Record<string, Handler> = {}) {
  const net = createFakeFetch(routes(overrides));
  vi.stubGlobal('fetch', net.fetch);
  render(<RepositoryDashboard accessToken={TEST_TOKEN} onUnauthorized={onUnauthorized} />);
  await screen.findByText('Complete · 2 repositories');
  return net;
}

const select = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  onUnauthorized.mockClear();
});

describe('opening the architecture view from the repository panel', () => {
  it('offers it only for a selected repository', async () => {
    await openDashboard();
    expect(screen.queryByRole('button', { name: 'View architecture' })).toBeNull();
    select('octo/alpha');
    expect(screen.getByRole('button', { name: 'View architecture' })).toBeTruthy();
  });

  it('replaces the dashboard with the repository architecture and loads its tree', async () => {
    const net = await openDashboard();
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View architecture' }));

    expect(await screen.findByRole('region', { name: 'Summary' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'octo/alpha · Architecture' })).toBeTruthy();
    // The repository dashboard is out of the way (hidden, not destroyed).
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
    expect(net.requests.map((r) => r.url.pathname)).toContain('/repos/octo/alpha/branches/main');
    expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
  });

  it('asks GitHub for the default branch when the repository list had none', async () => {
    const net = await openDashboard();
    select('octo/beta');
    fireEvent.click(screen.getByRole('button', { name: 'View architecture' }));

    expect(await screen.findByRole('region', { name: 'Summary' })).toBeTruthy();
    const paths = net.requests.map((r) => r.url.pathname);
    expect(paths).toContain('/repos/octo/beta');
    expect(paths).toContain('/repos/octo/beta/branches/trunk');
    expect(screen.getByText('trunk')).toBeTruthy();
  });

  it('goes back with the data, filters and selection intact, and without reloading', async () => {
    const net = await openDashboard();
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'alpha' } });
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View architecture' }));
    await screen.findByRole('region', { name: 'Summary' });

    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));

    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'octo/alpha' })).toBeTruthy(); // detail panel
    expect(screen.getByLabelText<HTMLInputElement>('Search by name').value).toBe('alpha');
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy();
    // Focus returns to the button that opened the view.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'View architecture' }),
      );
    });
    // The repository list was fetched exactly once.
    expect(net.requests.filter((r) => r.url.pathname === '/user/installations')).toHaveLength(1);
  });

  it('shows a tree failure inside the view, with the dashboard still available behind it', async () => {
    await openDashboard({
      [`GET ${GH}/repos/octo/alpha/git/trees/${TREE}`]: () => new Response('{}', { status: 409 }),
    });
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View architecture' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('This repository is empty');
    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));
    expect(screen.getByRole('region', { name: 'Overview' })).toBeTruthy();
    expect(
      within(screen.getByRole('region', { name: 'Overview' })).getByText('Total'),
    ).toBeTruthy();
  });

  it('ends the session when GitHub rejects the token while reading the tree', async () => {
    await openDashboard({
      [`GET ${GH}/repos/octo/alpha/branches/main`]: () => new Response('{}', { status: 401 }),
    });
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View architecture' }));
    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalled();
    });
  });
});
