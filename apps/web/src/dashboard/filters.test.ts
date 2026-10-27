import { describe, expect, it } from 'vitest';
import { SAMPLE_VIEWER, makeItem, sampleRepos } from '../testing/fixtures.ts';
import {
  DEFAULT_FILTERS,
  NO_LANGUAGE,
  applyFilters,
  hasActiveFilters,
  type Filters,
} from './filters.ts';

const names = (filters: Partial<Filters>, viewer: string | null = SAMPLE_VIEWER) =>
  applyFilters(sampleRepos(), { ...DEFAULT_FILTERS, ...filters }, viewer).map((r) => r.name);

describe('search', () => {
  it('matches the repository name, case-insensitively, as a substring', () => {
    expect(names({ query: 'ALP' })).toEqual(['alpha']);
    expect(names({ query: 'ta' })).toEqual(['beta', 'delta', 'zeta']);
  });

  it('ignores surrounding whitespace and matches everything when empty', () => {
    expect(names({ query: '  gamma ' })).toEqual(['gamma']);
    expect(names({ query: '   ' })).toHaveLength(6);
  });

  it('does not match on the owner unless the query is "owner/name"', () => {
    expect(names({ query: 'acme' })).toEqual([]);
    expect(names({ query: 'acme/' })).toEqual(['delta', 'gamma']);
    expect(names({ query: 'acme/gam' })).toEqual(['gamma']);
  });

  it('returns nothing when nothing matches', () => {
    expect(names({ query: 'does-not-exist' })).toEqual([]);
  });
});

describe('visibility filter', () => {
  it('shows only public or only private repositories', () => {
    expect(names({ visibility: 'public' })).toEqual(['alpha', 'epsilon', 'gamma', 'zeta']);
    expect(names({ visibility: 'private' })).toEqual(['beta', 'delta']);
  });
});

describe('ownership filter', () => {
  it('separates personal, organization and other-account repositories', () => {
    expect(names({ ownership: 'personal' })).toEqual(['alpha', 'beta']);
    expect(names({ ownership: 'organization' })).toEqual(['delta', 'gamma']);
    expect(names({ ownership: 'other' })).toEqual(['epsilon']);
  });

  it('leaves repositories of unknown ownership out of every specific bucket but "all"', () => {
    for (const ownership of ['personal', 'organization', 'other'] as const) {
      expect(names({ ownership })).not.toContain('zeta');
    }
    expect(names({ ownership: 'all' })).toContain('zeta');
  });

  it('cannot match personal or other without the signed-in login', () => {
    expect(names({ ownership: 'personal' }, null)).toEqual([]);
    expect(names({ ownership: 'other' }, null)).toEqual([]);
    expect(names({ ownership: 'organization' }, null)).toEqual(['delta', 'gamma']);
  });
});

describe('language filter', () => {
  it('matches an exact language', () => {
    expect(names({ language: 'TypeScript' })).toEqual(['alpha', 'beta']);
    expect(names({ language: 'Python' })).toEqual(['epsilon']);
  });

  it('finds repositories with no language via the sentinel', () => {
    expect(names({ language: NO_LANGUAGE })).toEqual(['delta', 'zeta']);
  });

  it('does not match a language that no repository has', () => {
    expect(names({ language: 'Rust' })).toEqual([]);
  });
});

describe('sorting', () => {
  it('sorts by name, case-insensitively and naturally', () => {
    const sorted = applyFilters(
      [
        makeItem({ id: 1, name: 'repo-10' }),
        makeItem({ id: 2, name: 'Repo-2' }),
        makeItem({ id: 3, name: 'alpha' }),
      ],
      DEFAULT_FILTERS,
      null,
    ).map((r) => r.name);
    expect(sorted).toEqual(['alpha', 'Repo-2', 'repo-10']);
  });

  it('sorts by most recently updated, undated last, ties by name', () => {
    expect(names({ sort: 'updated' })).toEqual([
      'beta',
      'zeta',
      'epsilon',
      'alpha',
      'delta',
      'gamma',
    ]);
  });

  it('does not mutate the input array', () => {
    const input = sampleRepos();
    const before = input.map((r) => r.name);
    applyFilters(input, { ...DEFAULT_FILTERS, sort: 'updated' }, null);
    expect(input.map((r) => r.name)).toEqual(before);
  });
});

describe('combined filters', () => {
  it('applies search, visibility, ownership and language together (AND)', () => {
    expect(names({ query: 'a', visibility: 'public', ownership: 'personal' })).toEqual(['alpha']);
    expect(names({ visibility: 'private', language: 'TypeScript' })).toEqual(['beta']);
    expect(
      names({ ownership: 'organization', language: 'JavaScript', visibility: 'public' }),
    ).toEqual(['gamma']);
  });

  it('can combine to an empty result', () => {
    expect(names({ visibility: 'private', language: 'Python' })).toEqual([]);
    expect(names({ query: 'alpha', ownership: 'organization' })).toEqual([]);
  });

  it('applies a filter together with a sort', () => {
    expect(names({ visibility: 'public', sort: 'updated' })).toEqual([
      'zeta',
      'epsilon',
      'alpha',
      'gamma',
    ]);
  });
});

describe('hasActiveFilters', () => {
  it('is false for the defaults and for a different sort alone', () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, sort: 'updated' })).toBe(false);
  });

  it('is true when any search or filter is set', () => {
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, query: 'x' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, visibility: 'private' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, ownership: 'personal' })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, language: 'Go' })).toBe(true);
  });
});
