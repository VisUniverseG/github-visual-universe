export interface ApiConfig {
  readonly port: number;
  readonly host: string;
  readonly allowedOrigins: readonly string[];
}

const DEFAULT_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

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

export function loadConfig(env: Record<string, string | undefined>): ApiConfig {
  return {
    port: parsePort(env['PORT']),
    host: env['HOST'] && env['HOST'] !== '' ? env['HOST'] : '127.0.0.1',
    allowedOrigins: parseAllowedOrigins(env['ALLOWED_ORIGINS']),
  };
}
