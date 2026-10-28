import { describe, expect, it } from 'vitest';
import { loadConfig, parseAllowedOrigins, parseAllowedRedirectUris } from './config.js';

// Synthetic placeholders, not real credentials.
const FAKE_ID = 'test-client-id';
const FAKE_SECRET = 'fake-secret-for-tests';

describe('loadConfig', () => {
  it('uses safe local defaults', () => {
    const config = loadConfig({});
    expect(config.port).toBe(8787);
    expect(config.host).toBe('127.0.0.1');
    expect(config.allowedOrigins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('reads PORT and HOST', () => {
    const config = loadConfig({ PORT: '10000', HOST: '0.0.0.0' });
    expect(config.port).toBe(10000);
    expect(config.host).toBe('0.0.0.0');
  });

  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });
});

describe('parseAllowedOrigins', () => {
  it('accepts exact origins and trims whitespace', () => {
    expect(parseAllowedOrigins(' https://a.example , http://localhost:5173 ')).toEqual([
      'https://a.example',
      'http://localhost:5173',
    ]);
  });

  it('rejects wildcards', () => {
    expect(() => parseAllowedOrigins('*')).toThrow(/wildcards/);
    expect(() => parseAllowedOrigins('https://*.example.com')).toThrow(/wildcards/);
  });

  it('rejects origins with paths or trailing slashes', () => {
    expect(() => parseAllowedOrigins('https://a.example/')).toThrow(/bare origins/);
    expect(() => parseAllowedOrigins('https://a.example/app')).toThrow(/bare origins/);
  });

  it('rejects non-http(s) and malformed values', () => {
    expect(() => parseAllowedOrigins('ftp://a.example')).toThrow(/http\(s\)/);
    expect(() => parseAllowedOrigins('not a url')).toThrow(/invalid origin/);
  });
});

describe('GitHub App credentials (loadConfig)', () => {
  it('starts without credentials: auth is null, nothing throws', () => {
    expect(loadConfig({}).auth).toBeNull();
    expect(loadConfig({ GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '' }).auth).toBeNull();
  });

  it('treats a half-configured pair as missing', () => {
    expect(loadConfig({ GITHUB_APP_CLIENT_ID: FAKE_ID }).auth).toBeNull();
    expect(loadConfig({ GITHUB_APP_CLIENT_SECRET: FAKE_SECRET }).auth).toBeNull();
  });

  it('loads both values and defaults the redirect URI to the local callback', () => {
    const { auth } = loadConfig({
      GITHUB_APP_CLIENT_ID: FAKE_ID,
      GITHUB_APP_CLIENT_SECRET: FAKE_SECRET,
    });
    expect(auth).toEqual({
      clientId: FAKE_ID,
      clientSecret: FAKE_SECRET,
      allowedRedirectUris: ['http://localhost:5173/auth/callback'],
    });
  });

  it('never puts a credential in an error message', () => {
    const badSecret = 'has a space';
    let message = '';
    try {
      loadConfig({ GITHUB_APP_CLIENT_ID: FAKE_ID, GITHUB_APP_CLIENT_SECRET: badSecret });
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(badSecret);
    expect(message).not.toContain(FAKE_ID);
  });

  it('validates the redirect list even when credentials are absent', () => {
    expect(() => loadConfig({ ALLOWED_REDIRECT_URIS: 'http://localhost:5173' })).toThrow(
      /canonical/,
    );
  });
});

describe('parseAllowedRedirectUris', () => {
  it('accepts the configured local and production callbacks exactly', () => {
    expect(
      parseAllowedRedirectUris(
        'http://localhost:5173/auth/callback, https://visuniverseg.github.io/github-visual-universe/auth/callback/',
      ),
    ).toEqual([
      'http://localhost:5173/auth/callback',
      'https://visuniverseg.github.io/github-visual-universe/auth/callback/',
    ]);
  });

  it('rejects wildcards, fragments, queries and credentials', () => {
    expect(() => parseAllowedRedirectUris('https://*.example.com/cb')).toThrow(/wildcards/);
    expect(() => parseAllowedRedirectUris('http://localhost:5173/cb#x')).toThrow(/fragment/);
    expect(() => parseAllowedRedirectUris('http://localhost:5173/cb?x=1')).toThrow(/fragment/);
    expect(() => parseAllowedRedirectUris('http://u:p@localhost:5173/cb')).toThrow(/fragment/);
  });

  it('refuses to silently normalize: entries must already be canonical', () => {
    expect(() => parseAllowedRedirectUris('http://localhost:5173')).toThrow(/canonical/);
    expect(() => parseAllowedRedirectUris('HTTP://LOCALHOST:5173/auth/callback')).toThrow(
      /canonical/,
    );
  });

  it('rejects non-http(s) and malformed values', () => {
    expect(() => parseAllowedRedirectUris('ftp://a.example/cb')).toThrow(/http\(s\)/);
    expect(() => parseAllowedRedirectUris('not a url')).toThrow(/invalid URI/);
  });
});
