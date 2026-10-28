/** GitHub App credentials and the redirect URIs the broker will accept. Server-side only. */
export interface AuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exact-match allow-list. Entries are compared as plain strings, never normalized. */
  readonly allowedRedirectUris: readonly string[];
}

export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  readonly allowedOrigins: readonly string[];
  /** `null` when the GitHub App client ID or secret is not configured (the API still starts). */
  readonly auth: AuthConfig | null;
}

const DEFAULT_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
const DEFAULT_REDIRECT_URIS = 'http://localhost:5173/auth/callback';

function parsePort(raw: string | undefined): number {
  const value = raw === undefined || raw === '' ? 8787 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`Invalid PORT: ${String(raw)}`);
  }
  return value;
}

/** Parses a comma-separated list of exact origins. Wildcards and paths are rejected. */
export function parseAllowedOrigins(raw: string | undefined): readonly string[] {
  const entries = (raw === undefined || raw.trim() === '' ? DEFAULT_ORIGINS : raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.map((entry) => {
    if (entry.includes('*')) {
      throw new Error(`ALLOWED_ORIGINS must not contain wildcards: ${entry}`);
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`ALLOWED_ORIGINS contains an invalid origin: ${entry}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`ALLOWED_ORIGINS must be http(s) origins: ${entry}`);
    }
    if (url.origin !== entry) {
      throw new Error(
        `ALLOWED_ORIGINS entries must be bare origins (no path or trailing slash): ${entry}`,
      );
    }
    return url.origin;
  });
}

/**
 * Parses the redirect URI allow-list. Each entry must already be in canonical URL form, so
 * what is configured is exactly what is compared: nothing is silently normalized.
 */
export function parseAllowedRedirectUris(raw: string | undefined): readonly string[] {
  const entries = (raw === undefined || raw.trim() === '' ? DEFAULT_REDIRECT_URIS : raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return entries.map((entry) => {
    if (entry.includes('*')) {
      throw new Error(`ALLOWED_REDIRECT_URIS must not contain wildcards: ${entry}`);
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`ALLOWED_REDIRECT_URIS contains an invalid URI: ${entry}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`ALLOWED_REDIRECT_URIS must be http(s) URIs: ${entry}`);
    }
    if (url.hash !== '' || url.search !== '' || url.username !== '' || url.password !== '') {
      throw new Error(
        `ALLOWED_REDIRECT_URIS entries must not contain a fragment, query or credentials: ${entry}`,
      );
    }
    if (url.href !== entry) {
      throw new Error(
        `ALLOWED_REDIRECT_URIS entries must be in canonical form (expected "${url.href}"): ${entry}`,
      );
    }
    return entry;
  });
}

const CREDENTIAL_PATTERN = /^[\x21-\x7e]+$/; // printable ASCII, no whitespace

/**
 * Reads the GitHub App credentials. Returns `null` (never throws) when either value is
 * missing, so the API can start without them. Error messages never contain the values.
 */
function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig | null {
  // Validated even when credentials are absent, so a typo is caught early.
  const allowedRedirectUris = parseAllowedRedirectUris(env['ALLOWED_REDIRECT_URIS']);
  const clientId = env['GITHUB_APP_CLIENT_ID']?.trim() ?? '';
  const clientSecret = env['GITHUB_APP_CLIENT_SECRET']?.trim() ?? '';
  if (clientId === '' || clientSecret === '') return null;
  if (!CREDENTIAL_PATTERN.test(clientId) || !CREDENTIAL_PATTERN.test(clientSecret)) {
    throw new Error('GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET must be printable ASCII');
  }
  return { clientId, clientSecret, allowedRedirectUris };
}

export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  return {
    port: parsePort(env['PORT']),
    host: env['HOST'] && env['HOST'] !== '' ? env['HOST'] : '127.0.0.1',
    allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS']),
    auth: loadAuthConfig(env),
  };
}
