import {
  revokeRequestSchema,
  tokenExchangeRequestSchema,
  type AuthErrorCode,
  type RevokeResponse,
  type TokenExchangeResponse,
} from '@gvu/shared';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthConfig } from './config.js';

// The stateless auth broker (ADR 0001).
//
// What this module may do with credentials:
//  - receive an authorization code + PKCE verifier and swap them for an access token using the
//    GitHub App client secret, returning ONLY `{access_token, expires_in}` (the refresh token that
//    GitHub also returns is dropped and never stored or forwarded);
//  - revoke an access token at GitHub on request.
// It stores nothing, never reads repository data, and never logs request or response content.

export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_URL = 'https://api.github.com';

/**
 * The only things the broker ever logs. These are fixed strings chosen by us, never values taken
 * from a request or from GitHub, so they cannot carry a secret.
 */
export type AuthLogReason =
  | 'github_unreachable'
  | 'github_http_error'
  | 'github_bad_verification_code'
  | 'github_redirect_uri_mismatch'
  | 'github_client_credentials'
  | 'github_error_other'
  | 'github_unexpected_body'
  | 'github_missing_expires_in'
  | 'revoke_not_confirmed';

export interface AuthRoutesOptions {
  readonly allowedOrigins: readonly string[];
  readonly auth: AuthConfig | null;
  readonly fetchImpl: typeof fetch;
  readonly log: (reason: AuthLogReason) => void;
  readonly timeoutMs: number;
}

const MAX_BODY_BYTES = 4 * 1024;
const JSON_CONTENT_TYPE = /^application\/json\s*(;|$)/i;

type Failure = {
  readonly ok: false;
  readonly status: ContentfulStatusCode;
  readonly error: AuthErrorCode;
};
type Exchanged = {
  readonly ok: true;
  readonly token: TokenExchangeResponse;
};

const fail = (status: ContentfulStatusCode, error: AuthErrorCode): Failure => ({
  ok: false,
  status,
  error,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the JSON body, or returns `undefined` when it is missing or malformed. */
async function readJson(c: Context): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '')) return undefined;
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

async function exchangeCode(
  options: AuthRoutesOptions,
  auth: AuthConfig,
  request: { code: string; code_verifier: string; redirect_uri: string },
): Promise<Exchanged | Failure> {
  let response: Response;
  try {
    response = await options.fetchImpl(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'gvu-auth-broker',
      },
      body: JSON.stringify({
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
        code: request.code,
        redirect_uri: request.redirect_uri,
        code_verifier: request.code_verifier,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    options.log('github_unreachable');
    return fail(502, 'upstream_error');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  // GitHub can report errors with HTTP 200 and an `error` field (U6), so check the body first.
  if (isRecord(body) && typeof body['error'] === 'string') {
    switch (body['error']) {
      case 'bad_verification_code':
        options.log('github_bad_verification_code');
        return fail(400, 'invalid_grant');
      case 'redirect_uri_mismatch':
        options.log('github_redirect_uri_mismatch');
        return fail(400, 'invalid_redirect_uri');
      case 'incorrect_client_credentials':
      case 'unauthorized_client':
        // A server misconfiguration. The caller learns nothing about it.
        options.log('github_client_credentials');
        return fail(502, 'upstream_error');
      default:
        options.log('github_error_other');
        return fail(502, 'upstream_error');
    }
  }
  if (!response.ok) {
    options.log('github_http_error');
    return fail(502, 'upstream_error');
  }
  if (!isRecord(body) || typeof body['access_token'] !== 'string' || body['access_token'] === '') {
    options.log('github_unexpected_body');
    return fail(502, 'upstream_error');
  }
  const expiresIn = body['expires_in'];
  if (typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0) {
    // Token expiration must be enabled on the GitHub App; refuse to hand out a non-expiring token.
    options.log('github_missing_expires_in');
    return fail(502, 'upstream_error');
  }

  // Build the response explicitly. Nothing else from GitHub's reply (notably `refresh_token`)
  // is copied.
  return { ok: true, token: { access_token: body['access_token'], expires_in: expiresIn } };
}

async function revokeToken(
  options: AuthRoutesOptions,
  auth: AuthConfig,
  accessToken: string,
): Promise<boolean> {
  const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64');
  try {
    const response = await options.fetchImpl(
      `${GITHUB_API_URL}/applications/${encodeURIComponent(auth.clientId)}/token`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'gvu-auth-broker',
          Authorization: `Basic ${basic}`,
        },
        body: JSON.stringify({ access_token: accessToken }),
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs),
      },
    );
    // Only GitHub's own confirmation counts: 204 No Content.
    return response.status === 204;
  } catch {
    return false;
  }
}

export function createAuthRoutes(options: AuthRoutesOptions): Hono {
  const routes = new Hono();

  routes.use('*', async (c, next) => {
    // Requests without an allowed Origin never reach the handlers (preflights are answered
    // earlier by the CORS middleware).
    if (!options.allowedOrigins.includes(c.req.header('origin') ?? '')) {
      return c.json({ error: 'origin_not_allowed' satisfies AuthErrorCode }, 403);
    }
    c.header('Cache-Control', 'no-store');
    await next();
    return undefined;
  });

  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large' satisfies AuthErrorCode }, 413),
  });

  routes.post('/token', limitBody, async (c) => {
    if (!options.auth) return c.json({ error: 'auth_not_configured' satisfies AuthErrorCode }, 503);

    const raw = await readJson(c);
    if (raw === undefined) {
      const wrongType = !JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '');
      return wrongType
        ? c.json({ error: 'unsupported_media_type' satisfies AuthErrorCode }, 415)
        : c.json({ error: 'invalid_request' satisfies AuthErrorCode }, 400);
    }
    const parsed = tokenExchangeRequestSchema.safeParse(raw);
    if (!parsed.success) {
      // Validation details are not echoed back.
      return c.json({ error: 'invalid_request' satisfies AuthErrorCode }, 400);
    }
    // Exact string comparison against the configured list: no normalization, no wildcards.
    if (!options.auth.allowedRedirectUris.includes(parsed.data.redirect_uri)) {
      return c.json({ error: 'invalid_redirect_uri' satisfies AuthErrorCode }, 400);
    }

    const result = await exchangeCode(options, options.auth, parsed.data);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json(result.token);
  });

  routes.post('/revoke', limitBody, async (c) => {
    if (!options.auth) return c.json({ error: 'auth_not_configured' satisfies AuthErrorCode }, 503);

    const raw = await readJson(c);
    if (raw === undefined) {
      const wrongType = !JSON_CONTENT_TYPE.test(c.req.header('content-type') ?? '');
      return wrongType
        ? c.json({ error: 'unsupported_media_type' satisfies AuthErrorCode }, 415)
        : c.json({ error: 'invalid_request' satisfies AuthErrorCode }, 400);
    }
    const parsed = revokeRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: 'invalid_request' satisfies AuthErrorCode }, 400);

    // `revoked: true` is only ever sent when GitHub itself confirmed (HTTP 204).
    if (await revokeToken(options, options.auth, parsed.data.access_token)) {
      const body: RevokeResponse = { revoked: true };
      return c.json(body);
    }
    options.log('revoke_not_confirmed');
    return c.json({ error: 'revocation_not_confirmed' satisfies AuthErrorCode }, 502);
  });

  return routes;
}
