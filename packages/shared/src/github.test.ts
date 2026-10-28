import { describe, expect, it } from 'vitest';
import {
  githubBranchListEntrySchema,
  githubBranchSchema,
  githubCommitSchema,
  githubDefaultBranchSchema,
  githubRepositorySchema,
  githubTreeEntrySchema,
  githubUserSchema,
  gitShaSchema,
  parseBranchList,
  parseCommitList,
  parseGitTree,
  parseInstallationRepositories,
} from './index.js';

const base = {
  id: 1,
  name: 'alpha',
  full_name: 'octo/alpha',
  private: false,
  html_url: 'https://github.com/octo/alpha',
  owner: { login: 'octo' },
};

describe('githubRepositorySchema', () => {
  it('needs only the core fields; every dashboard field is optional', () => {
    const parsed = githubRepositorySchema.parse(base);
    expect(parsed.language).toBeUndefined();
    expect(parsed.stargazers_count).toBeUndefined();
    expect(parsed.updated_at).toBeUndefined();
    expect(parsed.owner.type).toBeUndefined();
  });

  it('reads the dashboard fields when present, including null language', () => {
    const parsed = githubRepositorySchema.parse({
      ...base,
      owner: { login: 'octo', type: 'Organization' },
      language: null,
      stargazers_count: 7,
      forks_count: 2,
      open_issues_count: 3,
      updated_at: '2026-01-02T03:04:05Z',
      pushed_at: '2026-01-01T00:00:00Z',
      visibility: 'internal',
      fork: true,
      archived: false,
      default_branch: 'main',
      topics: ['a', 'b'],
    });
    expect(parsed.owner.type).toBe('Organization');
    expect(parsed.language).toBeNull();
    expect(parsed.stargazers_count).toBe(7);
    expect(parsed.topics).toEqual(['a', 'b']);
  });

  it('turns a malformed optional field into "missing" instead of failing', () => {
    const parsed = githubRepositorySchema.parse({
      ...base,
      language: 42,
      stargazers_count: 'many',
      topics: 'nope',
      fork: 'yes',
    });
    expect(parsed.language).toBeUndefined();
    expect(parsed.stargazers_count).toBeUndefined();
    expect(parsed.topics).toBeUndefined();
    expect(parsed.fork).toBeUndefined();
  });

  it('still requires the core fields', () => {
    expect(githubRepositorySchema.safeParse({ ...base, id: undefined }).success).toBe(false);
    expect(githubRepositorySchema.safeParse({ ...base, private: undefined }).success).toBe(false);
  });

  it('strips fields it does not know', () => {
    const parsed = githubRepositorySchema.parse({ ...base, temp_clone_token: 'secret-ish' });
    expect(JSON.stringify(parsed)).not.toContain('secret-ish');
  });
});

describe('parseInstallationRepositories', () => {
  it('keeps the readable repositories and counts the unreadable ones', () => {
    const result = parseInstallationRepositories({
      total_count: 3,
      repositories: [
        base,
        { garbage: true },
        { ...base, id: 2, name: 'beta', full_name: 'octo/beta' },
      ],
    });
    expect(result.repositories.map((r) => r.name)).toEqual(['alpha', 'beta']);
    expect(result.skipped).toBe(1);
  });

  it('rejects a response that is not a repositories envelope', () => {
    expect(() => parseInstallationRepositories({ nope: true })).toThrow();
    expect(() => parseInstallationRepositories({ total_count: 1, repositories: 'x' })).toThrow();
  });
});

describe('githubUserSchema', () => {
  it('reads only the login', () => {
    const parsed = githubUserSchema.parse({ login: 'octo', email: 'private@example.com', id: 1 });
    expect(parsed).toEqual({ login: 'octo' });
  });
});

const SHA = 'a'.repeat(40);
const SHA_256 = 'b'.repeat(64);

describe('gitShaSchema', () => {
  it.each([
    ['a SHA-1', SHA],
    ['a SHA-256', SHA_256],
  ])('accepts %s', (_name, value) => {
    expect(gitShaSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['too short', 'a'.repeat(39)],
    ['an in-between length', 'a'.repeat(41)],
    ['too long', 'a'.repeat(65)],
    ['upper case', 'A'.repeat(40)],
    ['non-hex', 'g'.repeat(40)],
    ['path-like', `../${'a'.repeat(37)}`],
    ['with a query', `${'a'.repeat(38)}?x`],
    ['with a trailing newline', `${SHA}\n`],
    ['padded with spaces', ` ${SHA} `],
    ['a number', 123],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(gitShaSchema.safeParse(value).success).toBe(false);
  });
});

describe('githubTreeEntrySchema', () => {
  it('keeps a well-formed SHA', () => {
    const parsed = githubTreeEntrySchema.parse({ path: 'src', type: 'tree', sha: SHA });
    expect(parsed.sha).toBe(SHA);
  });

  it.each([
    ['a path-like value', '../../user'],
    ['an unexpected length', 'abc123'],
    ['a number', 7],
    ['null', null],
  ])('treats %s as an absent SHA instead of failing the entry', (_name, sha) => {
    const parsed = githubTreeEntrySchema.safeParse({ path: 'src', type: 'tree', sha });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.sha ?? undefined).toBeUndefined();
  });

  it('treats a missing SHA as absent', () => {
    const parsed = githubTreeEntrySchema.parse({ path: 'a', type: 'blob', size: 1 });
    expect(parsed.sha).toBeUndefined();
  });
});

describe('githubBranchSchema / githubDefaultBranchSchema', () => {
  it('reads the head commit and its tree, ignoring everything else', () => {
    const parsed = githubBranchSchema.parse({
      name: 'main',
      protected: true,
      commit: {
        sha: SHA,
        author: { login: 'x' },
        commit: { tree: { sha: SHA_256 }, message: 'm' },
      },
    });
    expect(parsed).toEqual({ commit: { sha: SHA, commit: { tree: { sha: SHA_256 } } } });
  });

  it.each([
    ['a missing tree', { commit: { sha: SHA, commit: {} } }],
    ['a non-hex SHA', { commit: { sha: 'zz', commit: { tree: { sha: SHA } } } }],
    ['a path-like SHA', { commit: { sha: SHA, commit: { tree: { sha: '../../user' } } } }],
  ])('rejects %s', (_name, body) => {
    expect(githubBranchSchema.safeParse(body).success).toBe(false);
  });

  it('needs a non-empty default branch', () => {
    expect(githubDefaultBranchSchema.parse({ default_branch: 'main', id: 1 })).toEqual({
      default_branch: 'main',
    });
    expect(githubDefaultBranchSchema.safeParse({ default_branch: '' }).success).toBe(false);
    expect(githubDefaultBranchSchema.safeParse({}).success).toBe(false);
  });
});

describe('parseGitTree', () => {
  const entry = (path: string, type: string, extra: Record<string, unknown> = {}) => ({
    path,
    mode: '100644',
    type,
    sha: SHA,
    url: 'https://api.github.com/ignored',
    ...extra,
  });

  it('reads entries, the truncated flag and the tree SHA', () => {
    const result = parseGitTree({
      sha: SHA,
      truncated: false,
      tree: [entry('src', 'tree', { mode: '040000' }), entry('src/a.ts', 'blob', { size: 12 })],
    });
    expect(result.sha).toBe(SHA);
    expect(result.truncated).toBe(false);
    expect(result.skipped).toBe(0);
    expect(result.entries.map((e) => [e.path, e.type, e.size])).toEqual([
      ['src', 'tree', undefined],
      ['src/a.ts', 'blob', 12],
    ]);
    expect(JSON.stringify(result)).not.toContain('ignored');
  });

  it('keeps entries whose optional fields are missing or malformed', () => {
    const result = parseGitTree({
      sha: SHA,
      truncated: false,
      tree: [{ path: 'a', type: 'blob', size: 'big', mode: 7 }],
    });
    expect(result.skipped).toBe(0);
    expect(result.entries[0]).toMatchObject({ path: 'a', type: 'blob' });
    expect(result.entries[0]?.size).toBeUndefined();
    expect(result.entries[0]?.mode).toBeUndefined();
  });

  it('counts entries it cannot read instead of dropping them silently', () => {
    const result = parseGitTree({
      sha: SHA,
      truncated: false,
      tree: [
        entry('ok', 'blob'),
        entry('weird', 'something-new'),
        { type: 'blob' },
        entry('', 'blob'),
        entry('x'.repeat(5000), 'blob'),
        'not an object',
      ],
    });
    expect(result.entries.map((e) => e.path)).toEqual(['ok']);
    expect(result.skipped).toBe(5);
  });

  it('drops a malformed entry SHA but keeps the entry', () => {
    const result = parseGitTree({
      sha: SHA,
      truncated: false,
      tree: [entry('src', 'tree', { sha: '../../user' }), entry('lib', 'tree')],
    });
    expect(result.skipped).toBe(0);
    expect(result.entries.map((e) => [e.path, e.sha])).toEqual([
      ['src', undefined],
      ['lib', SHA],
    ]);
  });

  it('reports a truncated listing', () => {
    expect(parseGitTree({ sha: SHA, truncated: true, tree: [] }).truncated).toBe(true);
  });

  it.each([
    ['no truncated flag', { sha: SHA, tree: [] }],
    ['a non-boolean truncated flag', { sha: SHA, truncated: 'no', tree: [] }],
    ['no tree array', { sha: SHA, truncated: false }],
    ['a bad tree SHA', { sha: 'nope', truncated: false, tree: [] }],
    ['a non-object', 'tree'],
  ])('rejects an envelope with %s', (_name, body) => {
    expect(() => parseGitTree(body)).toThrow();
  });
});

const commit = (extra: Record<string, unknown> = {}) => ({
  sha: SHA,
  node_id: 'ignored',
  commit: {
    message: 'Fix the thing\n\nLonger explanation.',
    author: { name: 'Ada', email: 'ada@example.com', date: '2026-10-01T10:00:00Z' },
    committer: { name: 'Bot', email: 'bot@example.com', date: '2026-10-01T11:00:00Z' },
  },
  author: { login: 'ada', id: 1 },
  committer: { login: 'web-flow' },
  parents: [{ sha: 'b'.repeat(40) }],
  ...extra,
});

describe('githubCommitSchema', () => {
  it('reads the fields the Activity view shows', () => {
    const parsed = githubCommitSchema.parse(commit());
    expect(parsed.sha).toBe(SHA);
    expect(parsed.commit.message).toBe('Fix the thing\n\nLonger explanation.');
    expect(parsed.commit.author?.name).toBe('Ada');
    expect(parsed.commit.author?.date).toBe('2026-10-01T10:00:00Z');
    expect(parsed.commit.committer?.date).toBe('2026-10-01T11:00:00Z');
    expect(parsed.author?.login).toBe('ada');
    expect(parsed.parents).toHaveLength(1);
  });

  it('never lets an email address, or any unlisted field, through', () => {
    const parsed = githubCommitSchema.parse(commit());
    const text = JSON.stringify(parsed);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('@');
    expect(text).not.toContain('node_id');
    expect(text).not.toContain('web-flow');
  });

  it('treats a commit whose email matches no GitHub account (author: null) as having no login', () => {
    const parsed = githubCommitSchema.parse(commit({ author: null }));
    expect(parsed.author?.login).toBeUndefined();
  });

  it('needs only a well-formed sha and a commit object', () => {
    const parsed = githubCommitSchema.parse({ sha: SHA, commit: {} });
    expect(parsed.commit.message).toBeUndefined();
    expect(parsed.commit.author?.name).toBeUndefined();
    expect(parsed.parents).toBeUndefined();
  });

  it.each([
    ['a malformed sha', commit({ sha: 'not-a-sha' })],
    ['a missing sha', { commit: {} }],
    ['a missing commit object', { sha: SHA }],
    ['a non-object', 'commit'],
  ])('rejects %s', (_name, body) => {
    expect(githubCommitSchema.safeParse(body).success).toBe(false);
  });

  it('turns malformed optional fields into absent ones instead of failing', () => {
    const parsed = githubCommitSchema.parse(
      commit({ parents: 'many', author: 42, commit: { message: 7, author: 'x', committer: [] } }),
    );
    expect(parsed.parents).toBeUndefined();
    expect(parsed.author?.login).toBeUndefined();
    expect(parsed.commit.message).toBeUndefined();
    expect(parsed.commit.author?.name).toBeUndefined();
    expect(parsed.commit.committer?.date).toBeUndefined();
  });
});

describe('parseCommitList', () => {
  it('keeps readable commits and counts the ones it had to skip', () => {
    const result = parseCommitList([
      commit(),
      { sha: 'bad' },
      null,
      commit({ sha: 'c'.repeat(40) }),
    ]);
    expect(result.commits.map((c) => c.sha)).toEqual([SHA, 'c'.repeat(40)]);
    expect(result.skipped).toBe(2);
  });

  it('accepts an empty list', () => {
    expect(parseCommitList([])).toEqual({ commits: [], skipped: 0 });
  });

  it.each([
    ['an object', {}],
    ['null', null],
    ['a string', 'commits'],
  ])('rejects a response that is %s rather than a list', (_name, body) => {
    expect(() => parseCommitList(body)).toThrow();
  });
});

describe('githubBranchListEntrySchema and parseBranchList', () => {
  const branch = (extra: Record<string, unknown> = {}) => ({
    name: 'main',
    commit: { sha: SHA, url: 'https://api.github.com/ignored' },
    protected: true,
    ...extra,
  });

  it('reads the name, the head sha and the protected flag', () => {
    expect(githubBranchListEntrySchema.parse(branch())).toEqual({
      name: 'main',
      commit: { sha: SHA },
      protected: true,
    });
  });

  it('treats a missing or malformed protected flag as unknown', () => {
    expect(githubBranchListEntrySchema.parse(branch({ protected: undefined })).protected).toBe(
      undefined,
    );
    expect(githubBranchListEntrySchema.parse(branch({ protected: 'yes' })).protected).toBe(
      undefined,
    );
  });

  it('skips and counts entries without a name or a well-formed head sha', () => {
    const result = parseBranchList([
      branch(),
      branch({ name: '' }),
      branch({ commit: { sha: 'zz' } }),
      { name: 'x' },
      branch({ name: 'feature/a-b' }),
    ]);
    expect(result.branches.map((b) => b.name)).toEqual(['main', 'feature/a-b']);
    expect(result.skipped).toBe(3);
  });

  it('rejects a response that is not a list', () => {
    expect(() => parseBranchList({ branches: [] })).toThrow();
  });
});
