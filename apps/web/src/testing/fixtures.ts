import type { RepositoryItem } from '../github/repositories.ts';

/** Builds a `RepositoryItem` for logic tests. Unspecified optional fields are genuinely absent. */
export function makeItem(
  overrides: Partial<RepositoryItem> & { readonly id: number; readonly name: string },
): RepositoryItem {
  const owner = overrides.owner ?? 'octo';
  const isPrivate = overrides.isPrivate ?? false;
  return {
    owner,
    fullName: `${owner}/${overrides.name}`,
    isPrivate,
    description: null,
    url: `https://github.com/${owner}/${overrides.name}`,
    ownerType: 'User',
    visibility: isPrivate ? 'private' : 'public',
    language: null,
    stars: null,
    forks: null,
    openIssues: null,
    updatedAt: null,
    pushedAt: null,
    isFork: null,
    isArchived: null,
    defaultBranch: null,
    topics: [],
    ...overrides,
  };
}

/**
 * A small account used across the logic tests (signed-in user: `octo`):
 *
 *   alpha    octo    public   TypeScript  2026-01-01  personal
 *   beta     octo    private  TypeScript  2026-03-01  personal
 *   gamma    acme    public   JavaScript  (no date)   organization
 *   delta    acme    private  (none)      2025-12-01  organization
 *   epsilon  friend  public   Python      2026-02-01  other user
 *   zeta     mystery public   (none)      2026-03-01  owner type unknown
 */
export const SAMPLE_VIEWER = 'octo';

export function sampleRepos(): RepositoryItem[] {
  return [
    makeItem({ id: 1, name: 'alpha', language: 'TypeScript', updatedAt: '2026-01-01T00:00:00Z' }),
    makeItem({
      id: 2,
      name: 'beta',
      isPrivate: true,
      language: 'TypeScript',
      updatedAt: '2026-03-01T00:00:00Z',
    }),
    makeItem({
      id: 3,
      name: 'gamma',
      owner: 'acme',
      ownerType: 'Organization',
      language: 'JavaScript',
    }),
    makeItem({
      id: 4,
      name: 'delta',
      owner: 'acme',
      ownerType: 'Organization',
      isPrivate: true,
      updatedAt: '2025-12-01T00:00:00Z',
    }),
    makeItem({
      id: 5,
      name: 'epsilon',
      owner: 'friend',
      language: 'Python',
      updatedAt: '2026-02-01T00:00:00Z',
    }),
    makeItem({
      id: 6,
      name: 'zeta',
      owner: 'mystery',
      ownerType: null,
      updatedAt: '2026-03-01T00:00:00Z',
    }),
  ];
}
