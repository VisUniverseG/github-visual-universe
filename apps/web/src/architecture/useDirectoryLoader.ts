import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { RepositoryTree } from '../github/tree.ts';
import type { AdaptFailure } from './adapter.ts';
import {
  DirectoryLoader,
  type LoadOptions,
  type LoadResult,
  type LoaderSnapshot,
} from './loader.ts';

export interface DirectoryLoaderOptions {
  readonly accessToken: string;
  readonly owner: string;
  readonly name: string;
  /** What `loadRepositoryTree` returned. A different object means a different tree. */
  readonly tree: RepositoryTree;
  /** Called once when GitHub rejects the token (401). May change between renders. */
  readonly onUnauthorized: () => void;
  /** Aborting it disposes the loader: nothing more is requested, queued requests are dropped. */
  readonly signal?: AbortSignal;
}

export type DirectoryLoaderState =
  | {
      readonly usable: true;
      /** The loader's own immutable snapshot: the same object until something changes. */
      readonly snapshot: LoaderSnapshot;
      /**
       * Loads one folder (see {@link DirectoryLoader.loadDirectory}). Stable while the loader is;
       * it changes only when a new loader is made, so a call can never reach another repository's
       * loader. Resolves `cancelled` if its loader is disposed first.
       */
      readonly loadDirectory: (directoryId: number, options?: LoadOptions) => Promise<LoadResult>;
    }
  /** The tree could not be turned into a store (for example, it has no usable tree SHA). */
  | { readonly usable: false; readonly reason: AdaptFailure };

/**
 * Connects a {@link DirectoryLoader} to a component. The loader stays the only copy of the tree;
 * React just reads its snapshots.
 *
 * Lifecycle
 * - A loader is made during render for one `(token, repository, tree)`, so the first render
 *   already has the root's snapshot. Making it does no work: no request, no listener, no timer.
 *   One that is made and never committed (Strict Mode's second render, an interrupted render) is
 *   simply dropped.
 * - It is disposed when it stops being the current one: on unmount, and when the token, the
 *   repository or the tree changes. Disposal aborts what is in flight and settles what is queued
 *   as cancelled, and the loader never notifies again, so a late answer cannot reach the view.
 *   When a new loader replaces an old one, the old one is disposed as the new one's effect is set
 *   up, before the new one can be used. On unmount it is disposed at the end of the same task.
 * - Strict Mode runs an effect, cleans it up and runs it again. Because disposal on unmount waits
 *   for the end of the task, the second run keeps the very same loader: nothing is recreated or
 *   lost.
 * - A loader that was disposed without being replaced (an effect cleaned up while a hidden
 *   `Activity` kept rendering, for instance) is replaced by a fresh one, unless `signal` was
 *   aborted: that disposal is final.
 * - `onUnauthorized` is called from an effect, once per loader, when its snapshot first says the
 *   session ended. It may change identity freely.
 */
export function useDirectoryLoader({
  accessToken,
  owner,
  name,
  tree,
  onUnauthorized,
  signal,
}: DirectoryLoaderOptions): DirectoryLoaderState {
  // Bumped to replace a loader that was disposed while it was still the current one.
  const [revision, setRevision] = useState(0);

  const created = useMemo(() => {
    void revision; // a new value asks for a new loader
    return DirectoryLoader.create({ token: accessToken, repository: { owner, name }, tree });
  }, [accessToken, owner, name, tree, revision]);
  const loader = created.ok ? created.value : null;

  if (loader?.disposed === true && signal?.aborted !== true) {
    setRevision((current) => current + 1);
  }

  const subscribe = useCallback(
    (listener: () => void) => loader?.subscribe(listener) ?? noUnsubscribe,
    [loader],
  );
  const getSnapshot = useCallback(() => loader?.getSnapshot() ?? null, [loader]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);

  // Declared after the subscription, so that on cleanup React unsubscribes first and disposing
  // does not notify a component that is going away.
  const lastLoader = useRef<DirectoryLoader | null>(null);
  useEffect(() => {
    if (loader === null) return undefined;
    const previous = lastLoader.current;
    lastLoader.current = loader;
    dueForDisposal.delete(loader); // set up again straight after a cleanup: it stays
    if (previous !== null && previous !== loader) {
      dueForDisposal.delete(previous);
      previous.dispose(); // replaced: finished before the new one is used
    }
    if (signal?.aborted === true) {
      loader.dispose();
      return undefined;
    }
    const abort = () => {
      loader.dispose();
    };
    signal?.addEventListener('abort', abort, { once: true });
    return () => {
      signal?.removeEventListener('abort', abort);
      disposeSoon(loader);
    };
  }, [loader, signal]);

  const unauthorized = snapshot?.unauthorized === true;
  const notifyUnauthorized = useEffectEvent(onUnauthorized);
  useEffect(() => {
    if (unauthorized) notifyUnauthorized();
  }, [unauthorized, loader]);

  const loadDirectory = useCallback(
    (directoryId: number, options?: LoadOptions) =>
      loader === null
        ? Promise.resolve<LoadResult>({ status: 'cancelled' })
        : loader.loadDirectory(directoryId, options),
    [loader],
  );

  return useMemo<DirectoryLoaderState>(() => {
    if (!created.ok) return { usable: false, reason: created.reason };
    // `snapshot` is only `null` when there is no loader, which is the case above.
    return { usable: true, snapshot: snapshot ?? created.value.getSnapshot(), loadDirectory };
  }, [snapshot, created, loadDirectory]);
}

const noUnsubscribe = () => undefined;

/**
 * Loaders whose effect was cleaned up and that are due to be disposed. Disposal waits for the end
 * of the task that runs the cleanup, because React may set the same effect up again straight
 * away (Strict Mode does, on mount) and that loader must then survive, with whatever it has.
 * Each loader belongs to one hook instance, so instances cannot interfere with each other.
 */
const dueForDisposal = new Set<DirectoryLoader>();

function disposeSoon(loader: DirectoryLoader): void {
  dueForDisposal.add(loader);
  queueMicrotask(() => {
    if (dueForDisposal.delete(loader)) loader.dispose();
  });
}
