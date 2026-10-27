import { DEFAULT_API_BASE_URL } from '../api.ts';

/** The local callback; it must match the API's default `ALLOWED_REDIRECT_URIS`. */
export const DEFAULT_DEV_REDIRECT_URI = 'http://localhost:5173/auth/callback';

export interface AuthSettings {
  /** Public identifier of the GitHub App. Not a secret. */
  readonly clientId: string;
  /** Exact callback URI registered on the GitHub App. Never derived or normalized. */
  readonly redirectUri: string;
  readonly apiBaseUrl: string;
}

export interface AuthEnv {
  readonly VITE_GITHUB_APP_CLIENT_ID?: string | undefined;
  readonly VITE_AUTH_REDIRECT_URI?: string | undefined;
  readonly VITE_API_BASE_URL?: string | undefined;
  readonly DEV?: boolean | undefined;
}

export type AuthSettingsResult =
  { readonly ok: true; readonly settings: AuthSettings } | { readonly ok: false };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Reads the public sign-in settings from build-time env. Returns `{ ok: false }` rather than
 * throwing when they are missing or malformed, so the page can still render and explain.
 * The redirect URI is only defaulted in development; a production build must set it explicitly.
 */
export function readAuthSettings(env: AuthEnv): AuthSettingsResult {
  const clientId = env.VITE_GITHUB_APP_CLIENT_ID?.trim() ?? '';
  const redirectUri =
    env.VITE_AUTH_REDIRECT_URI?.trim() ?? (env.DEV === true ? DEFAULT_DEV_REDIRECT_URI : '');
  const apiBaseUrl = env.VITE_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL;

  if (!/^[A-Za-z0-9._-]+$/.test(clientId)) return { ok: false };
  if (!isHttpUrl(redirectUri) || redirectUri.includes('#') || redirectUri.includes('?')) {
    return { ok: false };
  }
  if (!isHttpUrl(apiBaseUrl)) return { ok: false };
  return { ok: true, settings: { clientId, redirectUri, apiBaseUrl } };
}

/** True when the page is at exactly the configured callback URI (query and hash aside). */
export function isCallbackLocation(
  location: Pick<Location, 'origin' | 'pathname'>,
  redirectUri: string,
): boolean {
  return `${location.origin}${location.pathname}` === redirectUri;
}
