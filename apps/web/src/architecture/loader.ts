import { GitHubApiError, type GitHubErrorKind, type GitHubRateLimit } from '../github/client.ts';
import {
  loadTreeListing,
  type RepositoryRef,
  type RepositoryTree,
  type TreeListing,
} from '../github/tree.ts';
import { createTreeStore, directoryListingOf, type AdaptResult } from './adapter.ts';
import type { AttachResult, TreeSnapshot, TreeStore } from './store.ts';

/**
 * Loads directories of a repository on demand into a {@link TreeStore}. Framework-independent:
 * a React hook can subscribe to it with `useSyncExternalStore`.
 *
 * The store stays the only copy of the tree. The loader adds what the store does not know:
 * requests in flight, why a request failed, and what GitHub said about the rate limit.
 *
 * - One folder, one request at a time: concurrent calls for the same folder share one promise.
 * - Direct (non-recursive) listings only, always for the folder's own tree SHA. Files, symlinks,
 *   submodules and folders without a usable SHA are never requested.
 * - A folder that is already listed is not requested again unless a refresh is asked for, and a
 *   refresh keeps showing the old data until the new listing is attached.
 * - A failure touches only its folder. It is recorded, the store is left as it was, and the
 *   folder can be retried if the failure could be transient. Nothing is ever retried by itself.
 * - At most {@link DEFAULT_MAX_CONCURRENT_REQUESTS} listing requests are active at once. The rest
 *   wait in a first-in, first-out queue, still marked as loading, and start as slots free up.
 *   A queued folder is already "in flight" for deduplication, so it never makes a second request.
 * - A 401 ends the session: everything in flight is aborted and nothing more is requested.
 * - {@link DirectoryLoader.dispose} aborts every request, settles the queued ones as cancelled
 *   without ever starting them, and a response that arrives afterwards changes nothing.
 */

/** How many listing requests one loader keeps active at once. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/** Why a folder could not be loaded. Never carries a response body. */
export type FailureKind =
  | Exclude<GitHubErrorKind, 'unauthorized'>
  /** GitHub's answer for this folder could not be used (malformed, or not a direct listing). */
  | 'invalid_listing'
  /** GitHub's answer was for a different tree than the folder's. */
  | 'sha_mismatch'
  /** The store refused the listing. */
  | 'rejected'
  /** Something unexpected went wrong in the loader itself. */
  | 'unexpected';

export interface DirectoryFailure {
  readonly kind: FailureKind;
  /** The HTTP status, when the failure was an HTTP response. */
  readonly status: number | null;
  /** Epoch milliseconds at which a rate limit resets, when GitHub said so. */
  readonly resetAt: number | null;
  /** Asking again could help (a network error, a server error, a rate limit that will reset). */
  readonly retryable: boolean;
}

/**
 * Everything observable about the loader. A new object is made only when something observable
 * changed, so it can be compared by identity.
 */
export interface LoaderSnapshot {
  /** The tree. Request activity and completeness of each folder are on its nodes. */
  readonly tree: TreeSnapshot;
  /** The latest failure of each folder, by folder id. Cleared when the folder loads or retries. */
  readonly failures: ReadonlyMap<number, DirectoryFailure>;
  /** The latest rate-limit information GitHub sent, or `null`. */
  readonly rateLimit: GitHubRateLimit | null;
  /**
   * While set and in the future, GitHub said requests will fail until then (the limit is used up
   * or a retry-after was given), and the loader makes none. It is GitHub's time, not a guess.
   */
  readonly blockedUntil: number | null;
  /** A request got a 401: the session is over and the loader makes no more requests. */
  readonly unauthorized: boolean;
}

export type LoadResult =
  | { readonly status: 'loaded'; /** Nodes the listing added. */ readonly added: number }
  /** Already listed, so nothing was requested (ask for a refresh to request it again). */
  | { readonly status: 'already-loaded' }
  /** Nothing was requested because this is not a folder that can be loaded. */
  | {
      readonly status: 'not-loadable';
      readonly reason: 'unknown-directory' | 'not-a-directory' | 'no-sha';
    }
  /** Nothing was requested: GitHub said to wait until `until`. */
  | { readonly status: 'blocked'; readonly until: number }
  | { readonly status: 'failed'; readonly failure: DirectoryFailure }
  /** The loader was disposed, so nothing (more) happened. */
  | { readonly status: 'cancelled' }
  | { readonly status: 'unauthorized' };

export interface LoadOptions {
  /** Request a folder that is already listed again, keeping its data meanwhile. */
  readonly refresh?: boolean;
}

export interface DirectoryLoaderOptions {
  readonly token: string;
  readonly repository: RepositoryRef;
  /** What `loadRepositoryTree` returned: the root, in `complete` or `lazy` mode. */
  readonly tree: RepositoryTree;
  /** Aborting it disposes the loader. */
  readonly signal?: AbortSignal;
  /** Called once, after the loader's state shows `unauthorized`. */
  readonly onUnauthorized?: () => void;
  /** The clock, for comparing with GitHub's reset times. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * How many listing requests may be active at once; more wait in a queue. A whole number of at
   * least 1, otherwise {@link DEFAULT_MAX_CONCURRENT_REQUESTS} is used.
   */
  readonly maxConcurrentRequests?: number;
  /** The listing request. Defaults to `loadTreeListing`; replaceable only for tests. */
  readonly loadListing?: typeof loadTreeListing;
}

function sameRateLimit(a: GitHubRateLimit | null, b: GitHubRateLimit | null): boolean {
  return (
    a === b || (a !== null && b !== null && a.remaining === b.remaining && a.resetAt === b.resetAt)
  );
}

function describeFailure(error: unknown): DirectoryFailure {
  if (!(error instanceof GitHubApiError) || error.kind === 'unauthorized') {
    return { kind: 'unexpected', status: null, resetAt: null, retryable: false };
  }
  const status = error.status ?? null;
  const retryable =
    error.kind === 'network' ||
    error.kind === 'rate_limited' ||
    (error.kind === 'http' && status !== null && (status >= 500 || status === 408));
  return { kind: error.kind, status, resetAt: error.resetAt ?? null, retryable };
}

const permanent = (kind: FailureKind): DirectoryFailure => ({
  kind,
  status: null,
  resetAt: null,
  retryable: false,
});

interface QueuedRequest {
  readonly directoryId: number;
  readonly sha: string;
  readonly controller: AbortController;
  readonly settle: (result: LoadResult | PromiseLike<LoadResult>) => void;
}

export class DirectoryLoader {
  private readonly store: TreeStore;
  private readonly token: string;
  private readonly repository: RepositoryRef;
  private readonly now: () => number;
  private readonly loadListing: typeof loadTreeListing;
  private readonly onUnauthorized: (() => void) | undefined;
  private readonly maxConcurrent: number;

  private readonly listeners = new Set<() => void>();
  private readonly inFlight = new Map<number, Promise<LoadResult>>();
  /** Every folder that is queued or active, so that aborting reaches both. */
  private readonly controllers = new Map<number, AbortController>();
  private readonly queue: QueuedRequest[] = [];
  /** Requests that have started and not yet settled. */
  private active = 0;
  private readonly detach: (() => void) | undefined;

  private failures: ReadonlyMap<number, DirectoryFailure> = new Map();
  private rateLimit: GitHubRateLimit | null = null;
  private blockedUntil: number | null = null;
  private unauthorized = false;
  private isDisposed = false;
  private current: LoaderSnapshot;

  private constructor(store: TreeStore, options: DirectoryLoaderOptions) {
    this.store = store;
    this.token = options.token;
    this.repository = { owner: options.repository.owner, name: options.repository.name };
    this.now = options.now ?? Date.now;
    this.loadListing = options.loadListing ?? loadTreeListing;
    this.onUnauthorized = options.onUnauthorized;
    const limit = options.maxConcurrentRequests;
    this.maxConcurrent =
      limit !== undefined && Number.isInteger(limit) && limit >= 1
        ? limit
        : DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.current = this.build();

    const { signal } = options;
    if (signal !== undefined) {
      const onAbort = () => {
        this.dispose();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.detach = () => {
        signal.removeEventListener('abort', onAbort);
      };
      if (signal.aborted) this.dispose();
    }
  }

  /**
   * Starts from a repository tree (see {@link createTreeStore}). Makes no request. Returns why not
   * if the tree could not be used.
   */
  static create(options: DirectoryLoaderOptions): AdaptResult<DirectoryLoader> {
    const store = createTreeStore(options.tree);
    if (!store.ok) return store;
    return { ok: true, value: new DirectoryLoader(store.value, options) };
  }

  /**
   * `true` once {@link dispose} ran (or the signal given to `create` aborted). A disposed loader
   * is final: it keeps its last snapshot and refuses every request.
   */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /** The current state. The same object until something observable changes. */
  getSnapshot(): LoaderSnapshot {
    return this.current;
  }

  /** Calls `listener` after each observable change. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Loads one folder's direct listing and attaches it. Resolves, never rejects. Calls for a folder
   * already being loaded share one request (and one result).
   */
  loadDirectory(directoryId: number, options: LoadOptions = {}): Promise<LoadResult> {
    const pending = this.inFlight.get(directoryId);
    if (pending !== undefined) return pending;

    const early = this.refuse(directoryId, options.refresh === true);
    if (early.result !== null) return Promise.resolve(early.result);

    const request = this.run(directoryId, early.sha).finally(() => {
      this.inFlight.delete(directoryId);
    });
    this.inFlight.set(directoryId, request);
    return request;
  }

  /**
   * Aborts every request and stops for good. Listeners are told once if that changed what they
   * see (folders that were loading are idle again), then dropped; a response that arrives later
   * changes nothing and notifies nobody. Safe to call more than once.
   */
  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    this.detach?.();
    this.abortAll();
    this.commit(true);
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------------------------------

  /** Decides whether a request may be made. `result` is set when it may not. */
  private refuse(
    directoryId: number,
    refresh: boolean,
  ): { result: LoadResult; sha: null } | { result: null; sha: string } {
    const stop = (result: LoadResult) => ({ result, sha: null }) as const;
    if (this.unauthorized) return stop({ status: 'unauthorized' });
    if (this.isDisposed) return stop({ status: 'cancelled' });

    const node = this.current.tree.nodes[directoryId];
    if (node === undefined) return stop({ status: 'not-loadable', reason: 'unknown-directory' });
    if (node.kind !== 'directory')
      return stop({ status: 'not-loadable', reason: 'not-a-directory' });
    if (node.sha === null || !node.loadable)
      return stop({ status: 'not-loadable', reason: 'no-sha' });

    const listed = node.status === 'shallow' || node.status === 'complete';
    if (listed && !refresh) return stop({ status: 'already-loaded' });

    // A failure that asking again cannot fix is reported again, without another request.
    const failure = this.failures.get(directoryId);
    if (failure !== undefined && !failure.retryable) return stop({ status: 'failed', failure });

    const until = this.activeBlock();
    if (until !== null) return stop({ status: 'blocked', until });
    return { result: null, sha: node.sha };
  }

  /** GitHub's reset time while it is still ahead, otherwise `null` (and the block is dropped). */
  private activeBlock(): number | null {
    if (this.blockedUntil === null) return null;
    if (this.now() < this.blockedUntil) return this.blockedUntil;
    this.blockedUntil = null; // GitHub's reset time has passed
    this.commit();
    return null;
  }

  /**
   * Marks the folder as loading, then starts its request at once if a slot is free, or queues it.
   * Starting is synchronous, so the request exists as soon as `loadDirectory` returns.
   */
  private run(directoryId: number, sha: string): Promise<LoadResult> {
    const controller = new AbortController();
    this.controllers.set(directoryId, controller);
    this.setFailure(directoryId, null);
    this.store.markLoading(directoryId);
    this.commit();

    if (this.active < this.maxConcurrent) return this.execute(directoryId, sha, controller);
    return new Promise<LoadResult>((settle) => {
      this.queue.push({ directoryId, sha, controller, settle });
    });
  }

  /** Starts queued requests while there are free slots. */
  private drain(): void {
    while (this.active < this.maxConcurrent) {
      const next = this.queue.shift();
      if (next === undefined) return;
      const { directoryId, sha, controller, settle } = next;

      // Anything that ended the wait has already emptied the queue, so this is only a safeguard.
      if (this.interrupted(controller)) {
        this.controllers.delete(directoryId);
        settle(this.interruption());
        continue;
      }
      // GitHub said to wait while this one was queued: it never reaches the network.
      const until = this.activeBlock();
      if (until !== null) {
        this.controllers.delete(directoryId);
        this.store.markIdle(directoryId);
        this.commit();
        settle({ status: 'blocked', until });
        continue;
      }
      settle(this.execute(directoryId, sha, controller));
    }
  }

  /** Makes the request, holding one slot until it has settled. */
  private async execute(
    directoryId: number,
    sha: string,
    controller: AbortController,
  ): Promise<LoadResult> {
    this.active += 1;
    try {
      let listing: TreeListing;
      try {
        listing = await this.loadListing(this.token, this.repository, sha, {
          recursive: false,
          signal: controller.signal,
        });
      } catch (error) {
        return this.afterError(directoryId, controller, error);
      }
      try {
        return this.afterListing(directoryId, controller, sha, listing);
      } catch {
        // A bug in what attaches the listing must not leave the folder marked as loading.
        return this.fail(directoryId, permanent('unexpected'));
      }
    } finally {
      if (this.controllers.get(directoryId) === controller) this.controllers.delete(directoryId);
      this.active -= 1;
      this.drain();
    }
  }

  private afterListing(
    directoryId: number,
    controller: AbortController,
    sha: string,
    listing: TreeListing,
  ): LoadResult {
    if (this.interrupted(controller)) return this.interruption();

    this.noteRateLimit(listing.rateLimit);

    // Only a direct listing of this very folder may be attached.
    if (listing.recursive) return this.fail(directoryId, permanent('invalid_listing'));
    if (listing.sha !== sha) return this.fail(directoryId, permanent('sha_mismatch'));
    const adapted = directoryListingOf(listing);
    if (!adapted.ok) return this.fail(directoryId, permanent('invalid_listing'));

    const attached: AttachResult = this.store.attach(directoryId, adapted.value);
    if (!attached.applied) {
      return this.fail(
        directoryId,
        permanent(attached.reason === 'sha-mismatch' ? 'sha_mismatch' : 'rejected'),
      );
    }
    this.commit();
    return { status: 'loaded', added: attached.added };
  }

  private afterError(directoryId: number, controller: AbortController, error: unknown): LoadResult {
    if (this.interrupted(controller)) return this.interruption();
    if (error instanceof GitHubApiError && error.kind === 'unauthorized') {
      this.expire();
      return { status: 'unauthorized' };
    }
    const failure = describeFailure(error);
    if (failure.kind === 'rate_limited' && failure.resetAt !== null) {
      this.blockUntil(failure.resetAt);
    }
    return this.fail(directoryId, failure);
  }

  /** Records a failure for one folder. The folder's data is left exactly as it was. */
  private fail(directoryId: number, failure: DirectoryFailure): LoadResult {
    this.store.markFailed(directoryId);
    this.setFailure(directoryId, failure);
    this.commit();
    return { status: 'failed', failure };
  }

  private interrupted(controller: AbortController): boolean {
    return this.isDisposed || this.unauthorized || controller.signal.aborted;
  }

  private interruption(): LoadResult {
    return this.unauthorized ? { status: 'unauthorized' } : { status: 'cancelled' };
  }

  /** A 401: the session is over. Nothing in flight may touch the store any more. */
  private expire(): void {
    if (this.unauthorized) return;
    this.unauthorized = true;
    this.abortAll();
    this.commit();
    const callback = this.onUnauthorized;
    if (callback !== undefined) {
      try {
        callback();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  /**
   * Aborts every active request, drops every queued one, and clears the "loading" mark each left
   * on its folder. Callers set `disposed` or `unauthorized` first, which decides how they settle.
   */
  private abortAll(): void {
    for (const [directoryId, controller] of this.controllers) {
      controller.abort();
      this.store.markIdle(directoryId);
    }
    this.controllers.clear();
    const dropped = this.queue.splice(0);
    const result = this.interruption();
    for (const entry of dropped) entry.settle(result);
  }

  private noteRateLimit(rateLimit: GitHubRateLimit | null): void {
    if (rateLimit === null) return;
    this.rateLimit = rateLimit;
    // Used up, and GitHub said when it resets: nothing will succeed until then.
    if (rateLimit.remaining === 0 && rateLimit.resetAt !== null && rateLimit.resetAt > this.now()) {
      this.blockUntil(rateLimit.resetAt);
    }
  }

  /** Holds requests back until `until`, never shortening a block that already reaches further. */
  private blockUntil(until: number): void {
    if (this.blockedUntil === null || until > this.blockedUntil) this.blockedUntil = until;
  }

  private setFailure(directoryId: number, failure: DirectoryFailure | null): void {
    if (failure === null && !this.failures.has(directoryId)) return;
    const next = new Map(this.failures);
    if (failure === null) next.delete(directoryId);
    else next.set(directoryId, failure);
    this.failures = next;
  }

  private build(): LoaderSnapshot {
    return {
      tree: this.store.snapshot(),
      failures: this.failures,
      rateLimit: this.rateLimit,
      blockedUntil: this.blockedUntil,
      unauthorized: this.unauthorized,
    };
  }

  /** Makes a new snapshot if (and only if) something observable changed, and tells listeners. */
  private commit(final = false): void {
    // Once disposed, the one last change disposal itself made is the only one to publish.
    if (this.isDisposed && !final) return;
    const tree = this.store.snapshot();
    const before = this.current;
    if (
      tree === before.tree &&
      this.failures === before.failures &&
      sameRateLimit(this.rateLimit, before.rateLimit) &&
      this.blockedUntil === before.blockedUntil &&
      this.unauthorized === before.unauthorized
    ) {
      return;
    }
    this.current = this.build();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        // One listener's bug must not stop the others or leave the loader half way through.
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
}
