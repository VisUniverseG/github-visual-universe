import { useEffect, useRef, useState } from 'react';
import type { ActivityPage, PageCursor, PageNext } from '../github/activity.ts';
import { GitHubApiError } from '../github/client.ts';
import type { ActivityFailure } from './messages.ts';

/**
 * Loads a list one page at a time (read-only), for the Activity view.
 *
 * The first page is requested when the list appears; every later page only when `loadMore` is
 * called. Nothing is ever retried automatically. A failure of a later page keeps everything that
 * was already loaded and leaves the cursor where it was, so asking again repeats the same page.
 */

export interface PagedListState<T> {
  /** `loading`: the first page is on its way. `failed`: it did not arrive. `ready`: it did. */
  readonly phase: 'loading' | 'failed' | 'ready';
  readonly items: readonly T[];
  /** Entries GitHub sent that could not be read, over every page so far. */
  readonly skipped: number;
  /** `null` until the first page has arrived. */
  readonly next: PageNext | null;
  /** A later page is on its way. */
  readonly loadingMore: boolean;
  /** The last failure: of the first page when `failed`, of a later page when `ready`. */
  readonly error: ActivityFailure | null;
  /** While set and in the future, GitHub's rate limit forbids another request (epoch ms). */
  readonly blockedUntil: number | null;
  /** When the latest page arrived (epoch ms); `null` before the first. Dates are judged by it. */
  readonly loadedAt: number | null;
}

/** What a list amounts to, for the reader. */
export type ListStatus = 'loading' | 'complete' | 'partial' | 'failed' | 'partial_error';

/**
 * - `loading`: the first page has not arrived.
 * - `failed`: it never did, so there is nothing to show.
 * - `partial_error`: something is shown, and a later page failed.
 * - `complete`: GitHub offered nothing more and every entry could be read.
 * - `partial`: something is shown but not everything (more to load, the cap, or unreadable entries).
 */
export function statusOf<T>(state: PagedListState<T>): ListStatus {
  if (state.phase === 'loading') return 'loading';
  if (state.phase === 'failed') return 'failed';
  if (state.error !== null) return 'partial_error';
  return state.next?.kind === 'end' && state.skipped === 0 ? 'complete' : 'partial';
}

const LOADING: PagedListState<never> = {
  phase: 'loading',
  items: [],
  skipped: 0,
  next: null,
  loadingMore: false,
  error: null,
  blockedUntil: null,
  loadedAt: null,
};

/** The latest time a rate limit forbids requests until, or `null` if none does. */
function blockFrom(previous: number | null, resetAt: number | null, now: number): number | null {
  const candidates = [previous, resetAt].filter(
    (time): time is number => time !== null && time > now,
  );
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/** When a successful response says the budget is spent, the reset time; otherwise `null`. */
function exhaustedUntil(page: ActivityPage<unknown>): number | null {
  const limit = page.rateLimit;
  return limit !== null && limit.remaining === 0 ? limit.resetAt : null;
}

/** The longest delay `setTimeout` accepts. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface PagedListOptions<T> {
  /**
   * Loads one page. It identifies the list: a new function means a different list (another
   * repository, branch or token), which is loaded from scratch, and a result that belongs to an
   * earlier one is never shown. Pass a function that only changes when one of those does.
   */
  readonly loadPage: (cursor: PageCursor | null, signal: AbortSignal) => Promise<ActivityPage<T>>;
  /** Turns a failure into fixed words. Must be referentially stable. */
  readonly describe: (error: unknown, now: number) => ActivityFailure;
  /** Called once if GitHub rejects the token (401). Must be referentially stable. */
  readonly onUnauthorized: () => void;
}

interface Run {
  readonly controller: AbortController;
  /** A request of this run is in flight. Set synchronously, so a double click cannot slip past. */
  busy: boolean;
  /** `onUnauthorized` has been called for this run. */
  ended: boolean;
}

export function usePagedList<T>({ loadPage, describe, onUnauthorized }: PagedListOptions<T>) {
  const [stored, setStored] = useState<{
    readonly owner: PagedListOptions<T>['loadPage'];
    readonly state: PagedListState<T>;
  }>({ owner: loadPage, state: LOADING });
  const [attempt, setAttempt] = useState(0);
  const runRef = useRef<Run | null>(null);

  // What was stored for another list is not an answer for this one.
  const state: PagedListState<T> = stored.owner === loadPage ? stored.state : LOADING;

  /** Applies `change` to the stored state, but only if it still belongs to this list. */
  const update = (change: (current: PagedListState<T>) => PagedListState<T>) => {
    setStored((current) =>
      current.owner === loadPage ? { owner: loadPage, state: change(current.state) } : current,
    );
  };

  // The first page. State is set only from async callbacks, never during render or the effect body.
  useEffect(() => {
    const controller = new AbortController();
    const run: Run = { controller, busy: true, ended: false };
    runRef.current = run;

    // The first page is what adopts a list: whatever was stored for another one is dropped.
    const apply = (change: (current: PagedListState<T>) => PagedListState<T>) => {
      setStored((current) => ({
        owner: loadPage,
        state: change(current.owner === loadPage ? current.state : LOADING),
      }));
    };

    loadPage(null, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        run.busy = false;
        const now = Date.now();
        apply((current) => ({
          ...current,
          phase: 'ready',
          items: page.items,
          skipped: page.skipped,
          next: page.next,
          loadingMore: false,
          error: null,
          blockedUntil: blockFrom(current.blockedUntil, exhaustedUntil(page), now),
          loadedAt: now,
        }));
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        run.busy = false;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          if (!run.ended) {
            run.ended = true;
            onUnauthorized();
          }
          return;
        }
        const now = Date.now();
        const failure = describe(error, now);
        apply((current) => ({
          ...current,
          phase: 'failed',
          error: failure,
          blockedUntil: blockFrom(current.blockedUntil, failure.resetAt, now),
        }));
      },
    );

    return () => {
      controller.abort();
    };
  }, [loadPage, describe, onUnauthorized, attempt]);

  // When a rate limit ends, say so (once), so that loading can be offered again.
  const { blockedUntil } = state;
  useEffect(() => {
    if (blockedUntil === null) return;
    const timer = setTimeout(
      () => {
        setStored((current) =>
          current.owner === loadPage && current.state.blockedUntil === blockedUntil
            ? { owner: loadPage, state: { ...current.state, blockedUntil: null } }
            : current,
        );
      },
      Math.min(Math.max(blockedUntil - Date.now(), 0), MAX_TIMEOUT_MS),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [blockedUntil, loadPage]);

  // `blockedUntil` is only ever set to a time in the future and is cleared by the timer above when
  // that time comes, so while it is set, loading is blocked. (The clock is not read during render.)
  const blocked = blockedUntil !== null;
  const stillBlocked = () => blockedUntil !== null && Date.now() < blockedUntil;

  /** Asks again for a first page that failed. */
  const retry = () => {
    if (state.phase !== 'failed' || stillBlocked()) return;
    const run = runRef.current;
    if (run?.busy === true) return;
    update((current) => ({ ...current, phase: 'loading', error: null }));
    setAttempt((current) => current + 1);
  };

  /** Loads the next page (or repeats the one that failed). */
  const loadMore = () => {
    const run = runRef.current;
    if (run === null || run.busy || run.controller.signal.aborted) return;
    if (state.phase !== 'ready' || state.next?.kind !== 'more' || stillBlocked()) return;
    const { cursor } = state.next;
    run.busy = true;
    update((current) => ({ ...current, loadingMore: true, error: null }));

    loadPage(cursor, run.controller.signal).then(
      (page) => {
        if (run.controller.signal.aborted) return;
        run.busy = false;
        const now = Date.now();
        update((current) => ({
          ...current,
          items: [...current.items, ...page.items],
          skipped: current.skipped + page.skipped,
          next: page.next,
          loadingMore: false,
          error: null,
          blockedUntil: blockFrom(current.blockedUntil, exhaustedUntil(page), now),
          loadedAt: now,
        }));
      },
      (error: unknown) => {
        if (run.controller.signal.aborted) return;
        run.busy = false;
        if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
          if (!run.ended) {
            run.ended = true;
            onUnauthorized();
          }
          return;
        }
        const now = Date.now();
        const failure = describe(error, now);
        // What was loaded stays, and `next` is untouched, so asking again repeats this page.
        update((current) => ({
          ...current,
          loadingMore: false,
          error: failure,
          blockedUntil: blockFrom(current.blockedUntil, failure.resetAt, now),
        }));
      },
    );
  };

  return { state, loadMore, retry, blocked };
}

/** What `usePagedList` returns: the list's state and the ways to ask for more of it. */
export type PagedList<T> = ReturnType<typeof usePagedList<T>>;
