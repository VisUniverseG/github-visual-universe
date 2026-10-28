import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch, fakeRepo, type Handler } from '../../testing/fakeFetch.ts';
import { RepositoryDashboard } from './RepositoryDashboard.tsx';

const GH = 'https://api.github.com';
const SHA = 'a'.repeat(40);
const onUnauthorized = vi.fn();

function routes(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    [`GET ${GH}/user`]: () => Response.json({ login: 'octo' }),
    [`GET ${GH}/user/installations`]: () =>
      Response.json({ total_count: 1, installations: [{ id: 7, account: { login: 'octo' } }] }),
    [`GET ${GH}/user/installations/7/repositories`]: () =>
      Response.json({
        total_count: 2,
        repositories: [
          fakeRepo(1, 'alpha', { default_branch: 'main' }),
          fakeRepo(2, 'beta', { default_branch: 'trunk' }),
        ],
      }),
    [`GET ${GH}/repos/octo/alpha/commits`]: () =>
      Response.json([
        {
          sha: SHA,
          commit: {
            message: 'First commit',
            author: { name: 'Ada', date: '2026-10-01T10:00:00Z' },
          },
          author: { login: 'ada' },
          parents: [],
        },
      ]),
    [`GET ${GH}/repos/octo/alpha/branches`]: () =>
      Response.json([{ name: 'main', commit: { sha: SHA }, protected: false }]),
    [`GET ${GH}/repos/octo/beta/commits`]: () => Response.json([]),
    [`GET ${GH}/repos/octo/beta/branches`]: () => Response.json([]),
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

describe('opening the activity view from the repository panel', () => {
  it('offers it next to the architecture view, only for a selected repository', async () => {
    await openDashboard();
    expect(screen.queryByRole('button', { name: 'View activity' })).toBeNull();
    select('octo/alpha');
    expect(screen.getByRole('button', { name: 'View activity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View architecture' })).toBeTruthy();
  });

  it('makes no activity request until it is opened', async () => {
    const net = await openDashboard();
    select('octo/alpha');
    expect(net.requests.some((r) => /\/(commits|branches)$/.test(r.url.pathname))).toBe(false);
  });

  it('replaces the dashboard with the repository activity and loads it read-only', async () => {
    const net = await openDashboard();
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View activity' }));

    expect(await screen.findByText('Complete · 1 commit loaded')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'octo/alpha · Activity' })).toBeTruthy();
    expect(screen.getByText('First commit')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Overview' })).toBeNull();
    expect(net.requests.every((r) => r.method === 'GET' && r.url.origin === GH)).toBe(true);
  });

  it('goes back with the data, filters and selection intact, and focus on the button', async () => {
    const net = await openDashboard();
    fireEvent.change(screen.getByLabelText('Search by name'), { target: { value: 'alpha' } });
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View activity' }));
    await screen.findByText('Complete · 1 commit loaded');

    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));

    expect(screen.queryByRole('heading', { name: 'octo/alpha · Activity' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Overview' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Search by name').value).toBe('alpha');
    expect(screen.getByText('Showing 1 of 2')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View activity' }));
    });
    expect(net.requests.filter((r) => r.url.pathname === '/user/installations')).toHaveLength(1);
  });

  it('opens only one view at a time and returns focus to the right button', async () => {
    await openDashboard({
      [`GET ${GH}/repos/octo/alpha/git/trees/${SHA}`]: () =>
        Response.json({ sha: SHA, truncated: false, tree: [] }),
      [`GET ${GH}/repos/octo/alpha/branches/main`]: () =>
        Response.json({ commit: { sha: SHA, commit: { tree: { sha: SHA } } } }),
    });
    select('octo/alpha');

    fireEvent.click(screen.getByRole('button', { name: 'View architecture' }));
    await screen.findByRole('heading', { name: 'octo/alpha · Architecture' });
    expect(screen.queryByRole('heading', { name: 'octo/alpha · Activity' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'View architecture' }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'View activity' }));
    await screen.findByRole('heading', { name: 'octo/alpha · Activity' });
    expect(screen.queryByRole('heading', { name: 'octo/alpha · Architecture' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '← Back to repositories' }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View activity' }));
    });
  });

  it('shows an empty repository as empty', async () => {
    await openDashboard();
    select('octo/beta');
    fireEvent.click(screen.getByRole('button', { name: 'View activity' }));

    expect(await screen.findAllByText('Complete · 0 branches loaded')).toBeTruthy();
    expect(screen.getByText('GitHub listed no commits for this branch.')).toBeTruthy();
  });

  it('ends the session once when GitHub rejects the token', async () => {
    await openDashboard({
      [`GET ${GH}/repos/octo/alpha/commits`]: () => new Response('{}', { status: 401 }),
      [`GET ${GH}/repos/octo/alpha/branches`]: () => new Response('{}', { status: 401 }),
    });
    select('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'View activity' }));

    await waitFor(() => {
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
    });
  });
});
