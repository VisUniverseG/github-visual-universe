import { describe, expect, it } from 'vitest';
import { SAMPLE_VIEWER, makeItem, sampleRepos } from '../testing/fixtures.ts';
import { classifyOwnership, computeStats, languageDistribution } from './stats.ts';

describe('classifyOwnership', () => {
  it('is personal only when the owner is the signed-in user (case-insensitive)', () => {
    expect(classifyOwnership({ owner: 'octo', ownerType: 'User' }, 'octo')).toBe('personal');
    expect(classifyOwnership({ owner: 'OCTO', ownerType: 'User' }, 'octo')).toBe('personal');
    expect(classifyOwnership({ owner: 'octo', ownerType: null }, 'octo')).toBe('personal');
  });

  it('does NOT call every non-organization repository personal', () => {
    expect(classifyOwnership({ owner: 'friend', ownerType: 'User' }, 'octo')).toBe('other');
  });

  it('recognizes organizations from the owner type', () => {
    expect(classifyOwnership({ owner: 'acme', ownerType: 'Organization' }, 'octo')).toBe(
      'organization',
    );
    expect(classifyOwnership({ owner: 'acme', ownerType: 'Organization' }, null)).toBe(
      'organization',
    );
  });

  it('is unknown when it cannot be determined', () => {
    expect(classifyOwnership({ owner: 'x', ownerType: null }, 'octo')).toBeNull();
    expect(classifyOwnership({ owner: 'x', ownerType: 'User' }, null)).toBeNull();
  });
});

describe('computeStats', () => {
  it('counts totals, visibility and ownership over the whole dataset', () => {
    expect(computeStats(sampleRepos(), SAMPLE_VIEWER)).toEqual({
      total: 6,
      public: 4,
      private: 2,
      personal: 2,
      organization: 2,
      other: 1,
      unknownOwnership: 1,
    });
  });

  it('hides personal and other counts when the signed-in login is unknown', () => {
    const stats = computeStats(sampleRepos(), null);
    expect(stats.personal).toBeNull();
    expect(stats.other).toBeNull();
    expect(stats.organization).toBe(2);
    expect(stats.total).toBe(6);
    // alpha, beta, epsilon (users) and zeta (unknown type) cannot be placed without the login.
    expect(stats.unknownOwnership).toBe(4);
  });

  it('handles an empty dataset', () => {
    expect(computeStats([], SAMPLE_VIEWER)).toEqual({
      total: 0,
      public: 0,
      private: 0,
      personal: 0,
      organization: 0,
      other: 0,
      unknownOwnership: 0,
    });
  });

  it('treats internal repositories as non-public', () => {
    const stats = computeStats(
      [makeItem({ id: 1, name: 'a', isPrivate: true, visibility: 'internal' })],
      'octo',
    );
    expect(stats.private).toBe(1);
    expect(stats.public).toBe(0);
  });

  it('counts the complete dataset, not a page of it', () => {
    const many = Array.from({ length: 250 }, (_, i) =>
      makeItem({ id: i + 1, name: `repo-${String(i)}`, isPrivate: i % 5 === 0 }),
    );
    const stats = computeStats(many, 'octo');
    expect(stats.total).toBe(250);
    expect(stats.private).toBe(50);
    expect(stats.public).toBe(200);
    expect(stats.personal).toBe(250);
  });
});

describe('languageDistribution', () => {
  it('counts repositories by primary language, highest first, ties by name', () => {
    const dist = languageDistribution(sampleRepos());
    expect(dist.entries.map((e) => [e.language, e.count])).toEqual([
      ['TypeScript', 2],
      ['JavaScript', 1],
      ['Python', 1],
      [null, 2],
    ]);
    expect(dist.total).toBe(6);
    expect(dist.withLanguage).toBe(4);
    expect(dist.withoutLanguage).toBe(2);
  });

  it('reports shares of all repositories, including those with no language', () => {
    const dist = languageDistribution(sampleRepos());
    const ts = dist.entries.find((e) => e.language === 'TypeScript');
    const none = dist.entries.find((e) => e.language === null);
    expect(ts?.percent).toBeCloseTo(33.33, 1);
    expect(none?.percent).toBeCloseTo(33.33, 1);
    expect(dist.entries.reduce((sum, e) => sum + e.percent, 0)).toBeCloseTo(100, 5);
  });

  it('puts "no language" last even when it is the largest group', () => {
    const dist = languageDistribution([
      makeItem({ id: 1, name: 'a' }),
      makeItem({ id: 2, name: 'b' }),
      makeItem({ id: 3, name: 'c', language: 'Go' }),
    ]);
    expect(dist.entries.map((e) => e.language)).toEqual(['Go', null]);
  });

  it('has no "no language" entry when every repository has one', () => {
    const dist = languageDistribution([makeItem({ id: 1, name: 'a', language: 'Go' })]);
    expect(dist.entries).toHaveLength(1);
    expect(dist.withoutLanguage).toBe(0);
  });

  it('is empty for an empty dataset', () => {
    expect(languageDistribution([])).toEqual({
      entries: [],
      total: 0,
      withLanguage: 0,
      withoutLanguage: 0,
    });
  });
});
