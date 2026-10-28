import { githubTreeEntrySchema, gitShaSchema, type GitHubTreeEntry } from '@gvu/shared';
import type { RepositoryTree, TreeListing } from '../github/tree.ts';
import { TreeStore, type StoreListing } from './store.ts';

/**
 * Turns what the GitHub tree client returns into what the {@link TreeStore} accepts. Pure and
 * deterministic: no network, no state.
 *
 * It owns only the translation, and what the store cannot check for itself:
 *
 * - Meaning. A lazy {@link RepositoryTree} says `truncated: true` ("this is not the whole
 *   repository"), but the *root listing* inside it is only cut off when `rootTruncated` is set.
 *   The store needs the second.
 * - Runtime safety. The values are re-checked here (the types are only a promise): a listing that
 *   is not well-formed is refused rather than guessed at. Nothing is ever defaulted to something
 *   that would claim more than is known: a missing count is not `0` and a missing SHA is not
 *   invented.
 * - SHAs. The store lets `sha: null` skip its identity check, so an adapted listing always
 *   carries a well-formed SHA or is refused.
 *
 * What the store already owns (path safety, sizes, kinds, folder SHAs, truncation policy, what
 * counts as complete) is passed through untouched, not checked a second time. In particular a
 * truncated *recursive* listing is passed on faithfully, and the store decides to reject it.
 */

export type AdaptFailure =
  /** The tree SHA is missing or is not a well-formed Git SHA. */
  | 'invalid-sha'
  /** A count, flag or list has the wrong type, so the listing cannot be trusted. */
  | 'malformed'
  /** The fields of a repository tree contradict each other (see {@link RepositoryTree}). */
  | 'inconsistent';

export type AdaptResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AdaptFailure };

const refuse = (reason: AdaptFailure): { ok: false; reason: AdaptFailure } => ({
  ok: false,
  reason,
});

/** The fields of a {@link TreeListing} the store reads. A `TreeListing` fits, rate limit and all. */
export type ListingInput = Pick<
  TreeListing,
  'sha' | 'recursive' | 'entries' | 'skipped' | 'truncated'
>;

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Re-reads every entry with the shared schema, as `parseGitTree` did. An entry that does not
 * parse is left out and counted, never silently lost; one whose `sha` is malformed keeps its place
 * with no SHA (the schema's rule), so the folder shows up but cannot be loaded.
 */
function readEntries(entries: unknown): { entries: GitHubTreeEntry[]; unreadable: number } | null {
  if (!Array.isArray(entries)) return null;
  const readable: GitHubTreeEntry[] = [];
  let unreadable = 0;
  for (const raw of entries as unknown[]) {
    const parsed = githubTreeEntrySchema.safeParse(raw);
    if (parsed.success) readable.push(parsed.data);
    else unreadable += 1;
  }
  return { entries: readable, unreadable };
}

function toStoreListing(
  sha: unknown,
  recursive: unknown,
  rawEntries: unknown,
  skipped: unknown,
  truncated: unknown,
): AdaptResult<StoreListing> {
  if (typeof recursive !== 'boolean' || typeof truncated !== 'boolean' || !isCount(skipped)) {
    return refuse('malformed');
  }
  if (!gitShaSchema.safeParse(sha).success) return refuse('invalid-sha');
  const read = readEntries(rawEntries);
  if (read === null) return refuse('malformed');
  return {
    ok: true,
    value: {
      sha: sha as string,
      recursive,
      entries: read.entries,
      skipped: skipped + read.unreadable,
      truncated,
    },
  };
}

/**
 * A directory's listing, as returned by `loadTreeListing`, in the form `TreeStore.attach` takes.
 * The listing keeps its own `recursive` and `truncated` flags exactly as GitHub reported them.
 */
export function directoryListingOf(listing: ListingInput): AdaptResult<StoreListing> {
  return toStoreListing(
    listing.sha,
    listing.recursive,
    listing.entries,
    listing.skipped,
    listing.truncated,
  );
}

/**
 * The root listing of a {@link RepositoryTree}, in the form `TreeStore.fromRootListing` takes.
 *
 * - `complete`: one recursive listing of the whole repository.
 * - `lazy`: the root's direct children only. It is cut off only if the root's own listing was
 *   (`rootTruncated`); that the *repository* is incomplete is what the unloaded folders say.
 *
 * A tree whose fields contradict its mode (a "complete" tree that says it was truncated, or a
 * "lazy" one that does not) is refused as `inconsistent`: its entries could be a cut-off listing.
 */
export function rootListingOf(tree: RepositoryTree): AdaptResult<StoreListing> {
  if (tree.mode === 'complete') {
    // `truncated` must be exactly `false`: anything else may be a cut-off recursive listing.
    if ((tree.truncated as unknown) !== false) {
      return refuse(typeof tree.truncated === 'boolean' ? 'inconsistent' : 'malformed');
    }
    return toStoreListing(tree.treeSha, true, tree.entries, tree.skipped, false);
  }
  if ((tree.mode as unknown) !== 'lazy') return refuse('malformed');
  if ((tree.truncated as unknown) !== true) {
    return refuse(typeof tree.truncated === 'boolean' ? 'inconsistent' : 'malformed');
  }
  return toStoreListing(tree.treeSha, false, tree.entries, tree.skipped, tree.rootTruncated);
}

/** A store started from a {@link RepositoryTree}, or why one could not be made. */
export function createTreeStore(tree: RepositoryTree): AdaptResult<TreeStore> {
  const root = rootListingOf(tree);
  if (!root.ok) return root;
  // The root listing is never both recursive and truncated here, so the store accepts it.
  return { ok: true, value: TreeStore.fromRootListing(root.value) };
}
