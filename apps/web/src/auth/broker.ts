import {
  authErrorSchema,
  revokeResponseSchema,
  tokenExchangeResponseSchema,
  type AuthErrorCode,
  type TokenExchangeRequest,
  type TokenExchangeResponse,
} from '@gvu/shared';

/** Client for our own stateless auth broker (apps/api). It never sees or returns a client secret. */

const REQUEST_TIMEOUT_MS = 30_000;

export type BrokerErrorCode = AuthErrorCode | 'network' | 'invalid_response';

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode) {
    // The message carries only a fixed code, never request or response content.
    super(`Auth broker error: ${code}`);
    this.name = 'BrokerError';
    this.code = code;
  }
}

async function postJson(
  apiBaseUrl: string,
  path: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return fetch(new URL(path, apiBaseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Trades the one-time authorization code (plus PKCE verifier) for an access token. */
export async function exchangeCode(
  apiBaseUrl: string,
  request: TokenExchangeRequest,
  signal?: AbortSignal,
): Promise<TokenExchangeResponse> {
  let res: Response;
  try {
    res = await postJson(apiBaseUrl, '/auth/token', request, signal);
  } catch {
    throw new BrokerError('network');
  }
  const json = await readJson(res);

  if (!res.ok) {
    const error = authErrorSchema.safeParse(json);
    throw new BrokerError(error.success ? error.data.error : 'upstream_error');
  }
  const parsed = tokenExchangeResponseSchema.safeParse(json);
  if (!parsed.success) throw new BrokerError('invalid_response');
  return parsed.data;
}

/**
 * `confirmed`     the broker reports that GitHub itself confirmed the revocation.
 * `not_confirmed` anything else: GitHub refused, errored, was unreachable, or the broker is
 *                 down or unconfigured. The token may still be valid until it expires.
 */
export type RevokeOutcome = 'confirmed' | 'not_confirmed';

/** Asks GitHub, via the broker, to revoke the token. Never throws; success is never assumed. */
export async function revokeToken(
  apiBaseUrl: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RevokeOutcome> {
  try {
    const res = await postJson(apiBaseUrl, '/auth/revoke', { access_token: accessToken }, signal);
    if (!res.ok) return 'not_confirmed';
    return revokeResponseSchema.safeParse(await readJson(res)).success
      ? 'confirmed'
      : 'not_confirmed';
  } catch {
    return 'not_confirmed';
  }
}
