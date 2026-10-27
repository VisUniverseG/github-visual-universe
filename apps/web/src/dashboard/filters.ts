import type { RepositoryItem } from '../github/repositories.ts';
import { classifyOwnership, type Ownership } from './stats.ts';

/** Sentinel for the "no language detected" option; a real language can never be named this. */
export const NO_LANGUAGE = '__none__';

export type VisibilityFilter = 'all' | 'public' | 'private';
export type OwnershipFilter = 'all' | Ownership;
export type SortOrder = 'name' | 'updated';

export interface Filters {
  readonly query: string;
  readonly visibility: VisibilityFilter;
  readonly ownership: OwnershipFilter;
  /** `'all'`, {@link NO_LANGUAGE}, or an exact language name. */
  readonly language: string;
  readonly sort: SortOrder;
}

export const DEFAULT_FILTERS: Filters = {
  query: '',
  visibility: 'all',
  ownership: 'all',
  language: 'all',
  sort: 'name',
};

/** True when any search or filter is active. Sorting alone does not count. */
export function hasActiveFilters(filters: Filters): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.visibility !== 'all' ||
    filters.ownership !== 'all' ||
    filters.language !== 'all'
  );
}

function matchesQuery(repo: RepositoryItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  // "owner/name" searches the full name; anything else searches the repository name only.
  return (needle.includes('/') ? repo.fullName : repo.name).toLowerCase().includes(needle);
}

function matchesLanguage(repo: RepositoryItem, language: string): boolean {
  if (language === 'all') return true;
  if (language === NO_LANGUAGE) return repo.language === null;
  return repo.language === language;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

function compareByName(a: RepositoryItem, b: RepositoryItem): number {
  return collator.compare(a.name, b.name) || collator.compare(a.fullName, b.fullName);
}

function compareByUpdated(a: RepositoryItem, b: RepositoryItem): number {
  const timeA = a.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(a.updatedAt);
  const timeB = b.updatedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(b.updatedAt);
  if (timeA === timeB) return compareByName(a, b);
  return timeB > timeA ? 1 : -1; // newest first; repositories with no date sort last
}

/**
 * Applies search, every filter and the sort order together (all conditions must hold).
 * Ownership filters need the signed-in login: without it nothing matches `personal` or `other`,
 * and repositories with undeterminable ownership match only `all`.
 */
export function applyFilters(
  repos: readonly RepositoryItem[],
  filters: Filters,
  viewerLogin: string | null,
): RepositoryItem[] {
  return repos
    .filter((repo) => {
      if (!matchesQuery(repo, filters.query)) return false;
      if (filters.visibility === 'public' && repo.isPrivate) return false;
      if (filters.visibility === 'private' && !repo.isPrivate) return false;
      if (
        filters.ownership !== 'all' &&
        classifyOwnership(repo, viewerLogin) !== filters.ownership
      ) {
        return false;
      }
      return matchesLanguage(repo, filters.language);
    })
    .sort(filters.sort === 'updated' ? compareByUpdated : compareByName);
}
