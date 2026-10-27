import { describe, expect, it } from 'vitest';
import { DEFAULT_DEV_REDIRECT_URI, isCallbackLocation, readAuthSettings } from './config.ts';

describe('readAuthSettings', () => {
  it('reads the public settings', () => {
    expect(
      readAuthSettings({
        VITE_GITHUB_APP_CLIENT_ID: 'Iv1.testclientid',
        VITE_AUTH_REDIRECT_URI:
          'https://visuniverseg.github.io/github-visual-universe/auth/callback/',
        VITE_API_BASE_URL: 'https://api.example.com',
      }),
    ).toEqual({
      ok: true,
      settings: {
        clientId: 'Iv1.testclientid',
        redirectUri: 'https://visuniverseg.github.io/github-visual-universe/auth/callback/',
        apiBaseUrl: 'https://api.example.com',
      },
    });
  });

  it('is not configured without a client ID', () => {
    expect(readAuthSettings({ DEV: true }).ok).toBe(false);
    expect(readAuthSettings({ VITE_GITHUB_APP_CLIENT_ID: '  ', DEV: true }).ok).toBe(false);
  });

  it('rejects a malformed client ID', () => {
    expect(readAuthSettings({ VITE_GITHUB_APP_CLIENT_ID: 'a b', DEV: true }).ok).toBe(false);
    expect(readAuthSettings({ VITE_GITHUB_APP_CLIENT_ID: 'a&b=c', DEV: true }).ok).toBe(false);
  });

  it('defaults the redirect URI to the local callback in development only', () => {
    const dev = readAuthSettings({ VITE_GITHUB_APP_CLIENT_ID: 'id', DEV: true });
    expect(dev.ok && dev.settings.redirectUri).toBe(DEFAULT_DEV_REDIRECT_URI);
    expect(readAuthSettings({ VITE_GITHUB_APP_CLIENT_ID: 'id', DEV: false }).ok).toBe(false);
  });

  it('rejects redirect URIs with a query, fragment or non-http scheme', () => {
    for (const uri of [
      'http://localhost:5173/cb?x=1',
      'http://localhost:5173/cb#x',
      'javascript:alert(1)',
      'nope',
    ]) {
      expect(
        readAuthSettings({ VITE_GITHUB_APP_CLIENT_ID: 'id', VITE_AUTH_REDIRECT_URI: uri }).ok,
      ).toBe(false);
    }
  });

  it('does not rewrite the configured redirect URI', () => {
    const result = readAuthSettings({
      VITE_GITHUB_APP_CLIENT_ID: 'id',
      VITE_AUTH_REDIRECT_URI: 'http://localhost:5173/auth/callback',
    });
    expect(result.ok && result.settings.redirectUri).toBe('http://localhost:5173/auth/callback');
  });
});

describe('isCallbackLocation', () => {
  const redirectUri = 'https://example.github.io/app/auth/callback/';

  it('matches only the exact origin and path', () => {
    expect(
      isCallbackLocation(
        { origin: 'https://example.github.io', pathname: '/app/auth/callback/' },
        redirectUri,
      ),
    ).toBe(true);
    expect(
      isCallbackLocation(
        { origin: 'https://example.github.io', pathname: '/app/auth/callback' },
        redirectUri,
      ),
    ).toBe(false);
    expect(
      isCallbackLocation(
        { origin: 'https://evil.example', pathname: '/app/auth/callback/' },
        redirectUri,
      ),
    ).toBe(false);
    expect(
      isCallbackLocation({ origin: 'https://example.github.io', pathname: '/' }, redirectUri),
    ).toBe(false);
  });
});
