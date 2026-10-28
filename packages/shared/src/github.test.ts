import { describe, expect, it } from 'vitest';
import {
  githubRepositorySchema,
  githubUserSchema,
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
