import type { RepositoryItem } from '../github/repositories.ts';

/**
 * Pure statistics over the repositories loaded so far. These functions never invent data: a
 * number that cannot be known from the loaded data is `null`, and the UI hides it.
 */

export type Ownership = 'personal' | 'organization' | 'other';

/**
 * - `personal`: owned by the signed-in user (login from `GET /user`).
 * - `organization`: GitHub says the owner is an Organization.
 * - `other`: owned by a different user account (e.g. you collaborate on it).
 * - `null`: cannot be determined from the data we have.
 */
export function classifyOwnership(
  repo: Pick<RepositoryItem, 'owner' | 'ownerType'>,
  viewerLogin: string | null,
): Ownership | null {
  if (viewerLogin !== null && repo.owner.toLowerCase() === viewerLogin.toLowerCase()) {
    return 'personal';
  }
  if (repo.ownerType === 'Organization') return 'organization';
  if (repo.ownerType === 'User' && viewerLogin !== null) return 'other';
  return null;
}

export interface RepositoryStats {
  readonly total: number;
  readonly public: number;
  readonly private: number;
  /** `null` when the signed-in login is unknown, so personal repositories cannot be identified. */
  readonly personal: number | null;
  readonly organization: number;
  /** `null` when the signed-in login is unknown. */
  readonly other: number | null;
  /** Repositories whose ownership could not be determined. */
  readonly unknownOwnership: number;
}

export function computeStats(
  repos: readonly RepositoryItem[],
  viewerLogin: string | null,
): RepositoryStats {
  let publicCount = 0;
  let privateCount = 0;
  let personal = 0;
  let organization = 0;
  let other = 0;
  let unknown = 0;

  for (const repo of repos) {
    if (repo.isPrivate) privateCount += 1;
    else publicCount += 1;

    switch (classifyOwnership(repo, viewerLogin)) {
      case 'personal':
        personal += 1;
        break;
      case 'organization':
        organization += 1;
        break;
      case 'other':
        other += 1;
        break;
      case null:
        unknown += 1;
        break;
    }
  }

  return {
    total: repos.length,
    public: publicCount,
    private: privateCount,
    personal: viewerLogin === null ? null : personal,
    organization,
    other: viewerLogin === null ? null : other,
    unknownOwnership: unknown,
  };
}

export interface LanguageEntry {
  /** `null` is the "no language detected" bucket. */
  readonly language: string | null;
  readonly count: number;
  /** Share of all loaded repositories, 0–100. */
  readonly percent: number;
}

export interface LanguageDistribution {
  /** Languages by count (descending, then name), with the "no language" bucket always last. */
  readonly entries: readonly LanguageEntry[];
  readonly total: number;
  readonly withLanguage: number;
  readonly withoutLanguage: number;
}

/**
 * Counts repositories by GitHub's primary `language` field. This is a count of repositories,
 * not of bytes of code: a repository counts once, under its single primary language.
 */
export function languageDistribution(repos: readonly RepositoryItem[]): LanguageDistribution {
  const counts = new Map<string, number>();
  let without = 0;
  for (const repo of repos) {
    if (repo.language === null) without += 1;
    else counts.set(repo.language, (counts.get(repo.language) ?? 0) + 1);
  }

  const total = repos.length;
  const percent = (count: number) => (total === 0 ? 0 : (count / total) * 100);
  const entries: LanguageEntry[] = [...counts.entries()]
    .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB))
    .map(([language, count]) => ({ language, count, percent: percent(count) }));
  if (without > 0) entries.push({ language: null, count: without, percent: percent(without) });

  return {
    entries,
    total,
    withLanguage: total - without,
    withoutLanguage: without,
  };
}
