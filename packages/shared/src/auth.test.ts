import { describe, expect, it } from 'vitest';
import {
  authErrorSchema,
  githubInstallationRepositoriesResponseSchema,
  githubRepositorySchema,
  revokeRequestSchema,
  tokenExchangeRequestSchema,
  tokenExchangeResponseSchema,
} from './index.js';

const verifier = 'a'.repeat(43);

describe('tokenExchangeRequestSchema', () => {
  const valid = {
    code: 'abc123',
    code_verifier: verifier,
    redirect_uri: 'http://localhost:5173/auth/callback',
  };

  it('accepts a well-formed request', () => {
    expect(tokenExchangeRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects unknown fields, so a client cannot smuggle extra parameters', () => {
    expect(tokenExchangeRequestSchema.safeParse({ ...valid, client_secret: 'x' }).success).toBe(
      false,
    );
  });

  it('enforces the RFC 7636 verifier length and alphabet', () => {
    expect(
      tokenExchangeRequestSchema.safeParse({ ...valid, code_verifier: 'a'.repeat(42) }).success,
    ).toBe(false);
    expect(
      tokenExchangeRequestSchema.safeParse({ ...valid, code_verifier: 'a'.repeat(129) }).success,
    ).toBe(false);
    expect(
      tokenExchangeRequestSchema.safeParse({ ...valid, code_verifier: `${'a'.repeat(42)}!` })
        .success,
    ).toBe(false);
  });

  it('rejects codes with unexpected characters or missing values', () => {
    expect(tokenExchangeRequestSchema.safeParse({ ...valid, code: 'a b' }).success).toBe(false);
    expect(tokenExchangeRequestSchema.safeParse({ ...valid, code: '' }).success).toBe(false);
    expect(
      tokenExchangeRequestSchema.safeParse({ code: 'x', code_verifier: verifier }).success,
    ).toBe(false);
  });
});

describe('tokenExchangeResponseSchema', () => {
  it('requires a positive integer lifetime and refuses a refresh token', () => {
    expect(
      tokenExchangeResponseSchema.safeParse({ access_token: 't', expires_in: 28800 }).success,
    ).toBe(true);
    expect(tokenExchangeResponseSchema.safeParse({ access_token: 't' }).success).toBe(false);
    expect(
      tokenExchangeResponseSchema.safeParse({ access_token: 't', expires_in: 0 }).success,
    ).toBe(false);
    expect(
      tokenExchangeResponseSchema.safeParse({
        access_token: 't',
        expires_in: 1,
        refresh_token: 'r',
      }).success,
    ).toBe(false);
  });
});

describe('revoke and error contracts', () => {
  it('validates the revoke request', () => {
    expect(revokeRequestSchema.safeParse({ access_token: 't' }).success).toBe(true);
    expect(revokeRequestSchema.safeParse({ access_token: '' }).success).toBe(false);
  });

  it('only allows known error codes', () => {
    expect(authErrorSchema.safeParse({ error: 'invalid_grant' }).success).toBe(true);
    expect(authErrorSchema.safeParse({ error: 'something else' }).success).toBe(false);
  });
});

describe('GitHub response schemas', () => {
  it('keeps only the fields the UI needs', () => {
    const parsed = githubRepositorySchema.parse({
      id: 1,
      name: 'r',
      full_name: 'o/r',
      private: true,
      description: null,
      html_url: 'https://github.com/o/r',
      owner: { login: 'o', secret_field: 'x' },
      permissions: { admin: true },
    });
    expect(parsed).toEqual({
      id: 1,
      name: 'r',
      full_name: 'o/r',
      private: true,
      description: null,
      html_url: 'https://github.com/o/r',
      owner: { login: 'o' },
    });
  });

  it('rejects a malformed repository list', () => {
    expect(
      githubInstallationRepositoriesResponseSchema.safeParse({
        total_count: 1,
        repositories: [{ id: 'x' }],
      }).success,
    ).toBe(false);
  });
});
