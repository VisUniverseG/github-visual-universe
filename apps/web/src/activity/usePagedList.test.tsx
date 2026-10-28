import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActivityPage, PageCursor, PageNext } from '../github/activity.ts';
import { GitHubApiError } from '../github/client.ts';
import { describeCommitFailure } from './messages.ts';
import { statusOf, usePagedList, type PagedListState } from './usePagedList.ts';

afterEach(() => {
  vi.useRealTimers();
});

const more = (page: number): PageNext => ({
  kind: 'more',
  cursor: { nextUrl: `https://api.github.com/x?page=${String(page)}`, page },
});
const END: PageNext = { kind: 'end' };

function page(
  items: string[],
  next: PageNext,
  extra: Partial<ActivityPage<string>> = {},
): ActivityPage<string> {
  return { items, skipped: 0, next, rateLimit: null, ...extra };
}

type Load = (cursor: PageCursor | null, signal: AbortSignal) => Promise<ActivityPage<string>>;

function setup(loadPage: Load) {
  const onUnauthorized = vi.fn();
  const view = renderHook(
    (props: { loadPage: Load }) =>
      usePagedList<string>({
        loadPage: props.loadPage,
        describe: describeCommitFailure,
        onUnauthorized,
      }),
    { initialProps: { loadPage } },
  );
  return { ...view, onUnauthorized };
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('statusOf', () => {
  const base: PagedListState<string> = {
    phase: 'ready',
    items: ['a'],
    skipped: 0,
    next: END,
    loadingMore: false,
    error: null,
    blockedUntil: null,
    loadedAt: 0,
  };
  const failure = describeCommitFailure(new GitHubApiError('network'));

  it.each([
    ['loading', { ...base, phase: 'loading', next: null }, 'loading'],
    ['failed', { ...base, phase: 'failed', next: null, error: failure }, 'failed'],
    ['complete', base, 'complete'],
    ['partial: more to load', { ...base, next: more(2) }, 'partial'],
    ['partial: stopped at the cap', { ...base, next: { kind: 'capped' } }, 'partial'],
    ['partial: entries skipped', { ...base, skipped: 1 }, 'partial'],
    ['partial with an error', { ...base, next: more(2), error: failure }, 'partial_error'],
  ] as const)('%s', (_name, state, expected) => {
    expect(statusOf(state)).toBe(expected);
  });
});

describe('usePagedList', () => {
  it('loads the first page on its own, and nothing more', async () => {
    const loadPage = vi.fn<Load>(() => Promise.resolve(page(['a', 'b'], more(2))));
    const { result } = setup(loadPage);

    expect(result.current.state.phase).toBe('loading');
    await waitFor(() => {
      expect(result.current.state.phase).toBe('ready');
    });

    expect(result.current.state.items).toEqual(['a', 'b']);
    expect(statusOf(result.current.state)).toBe('partial');
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage.mock.calls[0]?.[0]).toBeNull();
  });

  it('appends the next page only when asked, and finishes complete', async () => {
    const loadPage = vi.fn<Load>((cursor) =>
      Promise.resolve(cursor === null ? page(['a'], more(2)) : page(['b'], END, { skipped: 0 })),
    );
    const { result } = setup(loadPage);
    await waitFor(() => {
      expect(result.current.state.phase).toBe('ready');
    });

    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.state.items).toEqual(['a', 'b']);
    });

    expect(statusOf(result.current.state)).toBe('complete');
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(loadPage.mock.calls[1]?.[0]).toEqual({
      nextUrl: 'https://api.github.com/x?page=2',
      page: 2,
    });
  });

  it('adds up the entries that could not be read, and is then only partial', async () => {
    const loadPage = vi.fn<Load>((cursor) =>
      Promise.resolve(
        cursor === null ? page(['a'], more(2), { skipped: 1 }) : page(['b'], END, { skipped: 2 }),
      ),
    );
    const { result } = setup(loadPage);
    await waitFor(() => {
      expect(result.current.state.phase).toBe('ready');
    });
    act(() => {
      result.current.loadMore();
    });
    await waitFor(() => {
      expect(result.current.state.next).toEqual(END);
    });

    expect(result.current.state.skipped).toBe(3);
    expect(statusOf(result.current.state)).toBe('partial');
  });

  it('does nothing when there is no further page, and does not load a page twice at once', async () => {
    const second = deferred<ActivityPage<string>>();
    const loadPage = vi.fn<Load>((cursor) =>
      cursor === null ? Promise.resolve(page(['a'], more(2))) : second.promise,
    );
    const { result } = setup(loadPage);
    await waitFor(() => {
      expect(result.current.state.phase).toBe('ready');
    });

    act(() => {
      result.current.loadMore();
      result.current.loadMore(); // a double click
    });
    expect(loadPage).toHaveBeenCalledTimes(2);
    expect(result.current.state.loadingMore).toBe(true);

    await act(async () => {
      second.resolve(page(['b'], END));
      await second.promise;
    });
    await waitFor(() => {
      expect(result.current.state.loadingMore).toBe(false);
    });

    act(() => {
      result.current.loadMore(); // nothing left
    });
    expect(loadPage).toHaveBeenCalledTimes(2);
  });

  describe('when the first page fails', () => {
    it('shows the failure, does not retry by itself, and loads again when asked', async () => {
      let calls = 0;
      const loadPage = vi.fn<Load>(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new GitHubApiError('network'))
          : Promise.resolve(page(['a'], END));
      });
      const { result } = setup(loadPage);

      await waitFor(() => {
        expect(result.current.state.phase).toBe('failed');
      });
      expect(result.current.state.error?.kind).toBe('network');
      expect(result.current.state.error?.retryable).toBe(true);
      expect(statusOf(result.current.state)).toBe('failed');
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(loadPage).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.retry();
      });
      expect(result.current.state.phase).toBe('loading');
      await waitFor(() => {
        expect(result.current.state.phase).toBe('ready');
      });
      expect(loadPage).toHaveBeenCalledTimes(2);
      expect(statusOf(result.current.state)).toBe('complete');
    });

    it('reports an empty repository (409) as an empty failure that cannot be retried', async () => {
      const loadPage = vi.fn<Load>(() =>
        Promise.reject(new GitHubApiError('http', { status: 409 })),
      );
      const { result } = setup(loadPage);
      await waitFor(() => {
        expect(result.current.state.phase).toBe('failed');
      });
      expect(result.current.state.error).toMatchObject({ kind: 'empty', retryable: false });
    });

    it('ends the session exactly once on a 401, and shows no failure', async () => {
      const loadPage = vi.fn<Load>(() =>
        Promise.reject(new GitHubApiError('unauthorized', { status: 401 })),
      );
      const { result, onUnauthorized } = setup(loadPage);

      await waitFor(() => {
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(onUnauthorized).toHaveBeenCalledTimes(1);
      expect(result.current.state.error).toBeNull();
      expect(loadPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('when a later page fails', () => {
    function failingSecondPage() {
      let secondCalls = 0;
      const loadPage = vi.fn<Load>((cursor) => {
        if (cursor === null) return Promise.resolve(page(['a', 'b'], more(2)));
        secondCalls += 1;
        return secondCalls === 1
          ? Promise.reject(new GitHubApiError('http', { status: 503 }))
          : Promise.resolve(page(['c'], END));
      });
      return loadPage;
    }

    it('keeps what was loaded, keeps the cursor, and retries the same page', async () => {
      const loadPage = failingSecondPage();
      const { result } = setup(loadPage);
      await waitFor(() => {
        expect(result.current.state.phase).toBe('ready');
      });

      act(() => {
        result.current.loadMore();
      });
      await waitFor(() => {
        expect(result.current.state.error).not.toBeNull();
      });

      expect(result.current.state.items).toEqual(['a', 'b']);
      expect(result.current.state.loadingMore).toBe(false);
      expect(result.current.state.next).toEqual(more(2));
      expect(result.current.state.error?.retryable).toBe(true);
      expect(statusOf(result.current.state)).toBe('partial_error');
      // Nothing retries on its own.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(loadPage).toHaveBeenCalledTimes(2);

      act(() => {
        result.current.loadMore();
      });
      await waitFor(() => {
        expect(result.current.state.items).toEqual(['a', 'b', 'c']);
      });
      expect(loadPage.mock.calls[2]?.[0]).toEqual(loadPage.mock.calls[1]?.[0]);
      expect(result.current.state.error).toBeNull();
      expect(statusOf(result.current.state)).toBe('complete');
    });

    it('ends the session exactly once on a 401, and keeps what was loaded', async () => {
      const loadPage = vi.fn<Load>((cursor) =>
        cursor === null
          ? Promise.resolve(page(['a'], more(2)))
          : Promise.reject(new GitHubApiError('unauthorized', { status: 401 })),
      );
      const { result, onUnauthorized } = setup(loadPage);
      await waitFor(() => {
        expect(result.current.state.phase).toBe('ready');
      });

      act(() => {
        result.current.loadMore();
      });
      await waitFor(() => {
        expect(onUnauthorized).toHaveBeenCalledTimes(1);
      });
      expect(result.current.state.items).toEqual(['a']);
      expect(result.current.state.error).toBeNull();
    });
  });

  describe('rate limits', () => {
    const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

    async function flush() {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
    }

    it('refuses to load until the reset time GitHub gave, then allows it', async () => {
      vi.useFakeTimers({ now: NOW });
      let secondCalls = 0;
      const loadPage = vi.fn<Load>((cursor) => {
        if (cursor === null) return Promise.resolve(page(['a'], more(2)));
        secondCalls += 1;
        return secondCalls === 1
          ? Promise.reject(
              new GitHubApiError('rate_limited', { status: 403, resetAt: NOW + 60_000 }),
            )
          : Promise.resolve(page(['b'], END));
      });
      const { result } = setup(loadPage);
      await flush();
      expect(result.current.state.phase).toBe('ready');

      act(() => {
        result.current.loadMore();
      });
      await flush();
      expect(result.current.state.error?.kind).toBe('rate_limited');
      expect(result.current.blocked).toBe(true);
      expect(result.current.state.blockedUntil).toBe(NOW + 60_000);

      // Still blocked: a request is not even sent.
      act(() => {
        result.current.loadMore();
      });
      await flush();
      expect(loadPage).toHaveBeenCalledTimes(2);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_001);
      });
      expect(result.current.blocked).toBe(false);

      act(() => {
        result.current.loadMore();
      });
      await flush();
      expect(result.current.state.items).toEqual(['a', 'b']);
    });

    it('does not block when GitHub gave no reset time', async () => {
      vi.useFakeTimers({ now: NOW });
      const loadPage = vi.fn<Load>(() =>
        Promise.reject(new GitHubApiError('rate_limited', { status: 429 })),
      );
      const { result } = setup(loadPage);
      await flush();

      expect(result.current.state.error?.kind).toBe('rate_limited');
      expect(result.current.blocked).toBe(false);
      act(() => {
        result.current.retry();
      });
      await flush();
      expect(loadPage).toHaveBeenCalledTimes(2);
    });

    it('blocks the first-page retry too', async () => {
      vi.useFakeTimers({ now: NOW });
      const loadPage = vi.fn<Load>(() =>
        Promise.reject(new GitHubApiError('rate_limited', { status: 403, resetAt: NOW + 5_000 })),
      );
      const { result } = setup(loadPage);
      await flush();
      expect(result.current.blocked).toBe(true);

      act(() => {
        result.current.retry();
      });
      await flush();
      expect(loadPage).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_001);
      });
      act(() => {
        result.current.retry();
      });
      await flush();
      expect(loadPage).toHaveBeenCalledTimes(2);
    });

    it('blocks further loading when a successful page says the budget is spent', async () => {
      vi.useFakeTimers({ now: NOW });
      const loadPage = vi.fn<Load>(() =>
        Promise.resolve(
          page(['a'], more(2), { rateLimit: { remaining: 0, resetAt: NOW + 30_000 } }),
        ),
      );
      const { result } = setup(loadPage);
      await flush();

      expect(result.current.blocked).toBe(true);
      act(() => {
        result.current.loadMore();
      });
      await flush();
      expect(loadPage).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifetime', () => {
    it('cancels an unfinished request when it goes away, and ignores its result', async () => {
      const first = deferred<ActivityPage<string>>();
      let signal: AbortSignal | undefined;
      const loadPage = vi.fn<Load>((_cursor, abort) => {
        signal = abort;
        return first.promise;
      });
      const { result, unmount, onUnauthorized } = setup(loadPage);

      unmount();
      expect(signal?.aborted).toBe(true);
      first.reject(new GitHubApiError('unauthorized', { status: 401 }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      expect(onUnauthorized).not.toHaveBeenCalled();
      expect(result.current.state.phase).toBe('loading');
    });

    it('starts again from scratch for a different list, never showing the old one', async () => {
      const oldFirst = deferred<ActivityPage<string>>();
      const loadOld = vi.fn<Load>(() => oldFirst.promise);
      const loadNew = vi.fn<Load>(() => Promise.resolve(page(['new'], END)));
      const { result, rerender } = setup(loadOld);

      rerender({ loadPage: loadNew });
      expect(result.current.state.phase).toBe('loading');
      await waitFor(() => {
        expect(result.current.state.items).toEqual(['new']);
      });

      // The old list's answer arrives late and must not appear.
      await act(async () => {
        oldFirst.resolve(page(['old'], END));
        await oldFirst.promise;
      });
      expect(result.current.state.items).toEqual(['new']);
    });

    it('shows a loading state at once when the list changes after one was loaded', async () => {
      const loadOld = vi.fn<Load>(() => Promise.resolve(page(['old'], END)));
      const pending = deferred<ActivityPage<string>>();
      const loadNew = vi.fn<Load>(() => pending.promise);
      const { result, rerender } = setup(loadOld);
      await waitFor(() => {
        expect(result.current.state.items).toEqual(['old']);
      });

      rerender({ loadPage: loadNew });

      expect(result.current.state.phase).toBe('loading');
      expect(result.current.state.items).toEqual([]);
    });
  });
});
