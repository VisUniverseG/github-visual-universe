import { fetchApiHealth } from '../api.ts';
import { BrokerError, exchangeCode } from './broker.ts';
import type { AuthSettings } from './config.ts';
import { computeCodeChallenge, generateCodeVerifier, generateState } from './pkce.ts';
import {
  clearPending,
  consumePending,
  saveToken,
  savePending,
  type StoredToken,
} from './session.ts';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
/** Generous because the free-tier API can take a while to wake from sleep. */
const PREWARM_TIMEOUT_MS = 60_000;

export type AuthFailureCode =
  | 'not_configured'
  | 'storage_unavailable'
  | 'api_unreachable'
  | 'denied'
  | 'invalid_callback'
  | 'no_pending'
  | 'expired'
  | 'state_mismatch'
  | 'invalid_grant'
  | 'exchange_failed';

/** User-facing text. Fixed strings only: nothing from the URL or from GitHub is ever echoed. */
export const AUTH_FAILURE_MESSAGES: Record<AuthFailureCode, string> = {
  not_configured: 'Sign-in is not configured for this deployment.',
  storage_unavailable: 'Your browser blocked session storage, which sign-in needs.',
  api_unreachable: 'The API is unreachable. It may be waking up; try again shortly.',
  denied: 'GitHub authorization was cancelled. Nothing was connected.',
  invalid_callback: 'The sign-in response from GitHub was incomplete. Please try again.',
  no_pending: 'No sign-in was in progress in this tab. Please start again.',
  expired: 'The sign-in took too long and expired. Please try again.',
  state_mismatch:
    'The sign-in response did not match this session, so it was rejected. Please try again.',
  invalid_grant: 'GitHub rejected the sign-in code (expired or already used). Please try again.',
  exchange_failed: 'Sign-in could not be completed. Please try again.',
};

export class AuthFlowError extends Error {
  readonly code: AuthFailureCode;

  constructor(code: AuthFailureCode) {
    super(AUTH_FAILURE_MESSAGES[code]);
    this.name = 'AuthFlowError';
    this.code = code;
  }
}

export function buildAuthorizeUrl(args: {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.href;
}

export interface BeginDeps {
  /** Wakes the broker before the user leaves for GitHub. Defaults to `GET /health`. */
  readonly prewarm?: (apiBaseUrl: string) => Promise<void>;
  readonly navigate?: (url: string) => void;
  readonly now?: () => number;
}

/** Stores a fresh state and PKCE verifier, then sends the browser to GitHub. */
export async function beginAuthorization(
  settings: AuthSettings,
  deps: BeginDeps = {},
): Promise<void> {
  const prewarm =
    deps.prewarm ??
    (async (apiBaseUrl: string) => {
      await fetchApiHealth(apiBaseUrl, AbortSignal.timeout(PREWARM_TIMEOUT_MS));
    });
  const navigate = deps.navigate ?? ((url: string) => window.location.assign(url));

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await computeCodeChallenge(codeVerifier);

  try {
    savePending({
      state,
      codeVerifier,
      redirectUri: settings.redirectUri,
      createdAt: (deps.now ?? Date.now)(),
    });
  } catch {
    throw new AuthFlowError('storage_unavailable');
  }

  try {
    await prewarm(settings.apiBaseUrl);
  } catch {
    // Better to fail now than after the user has authorized and the one-time code is spent.
    clearPending();
    throw new AuthFlowError('api_unreachable');
  }

  navigate(
    buildAuthorizeUrl({
      clientId: settings.clientId,
      redirectUri: settings.redirectUri,
      state,
      codeChallenge,
    }),
  );
}

export interface CallbackParams {
  readonly code: string | null;
  readonly state: string | null;
  readonly error: string | null;
}

/**
 * Reads `code`, `state` and `error` from the callback URL and immediately replaces the address
 * bar (and the history entry) with `homeUrl`, before anything asynchronous happens. A reload,
 * back-navigation or copy of the URL can therefore never replay the one-time code.
 */
export function takeCallbackParams(
  location: Pick<Location, 'search'>,
  history: Pick<History, 'replaceState'>,
  homeUrl: string,
): CallbackParams {
  const query = new URLSearchParams(location.search);
  const params: CallbackParams = {
    code: query.get('code'),
    state: query.get('state'),
    error: query.get('error'),
  };
  history.replaceState(null, '', homeUrl);
  return params;
}

export interface CompleteDeps {
  readonly now?: () => number;
}

/** Validates the callback, then trades the code for a token and stores it. */
export async function completeAuthorization(
  params: CallbackParams,
  settings: AuthSettings,
  deps: CompleteDeps = {},
): Promise<StoredToken> {
  const now = (deps.now ?? Date.now)();

  // The pending record is consumed first, so every outcome (success or failure) is single-use.
  const pending = consumePending(now);

  if (params.error !== null) {
    throw new AuthFlowError(params.error === 'access_denied' ? 'denied' : 'invalid_callback');
  }
  if (!params.code || !params.state) throw new AuthFlowError('invalid_callback');
  if (pending.kind === 'missing') throw new AuthFlowError('no_pending');
  if (pending.kind === 'expired') throw new AuthFlowError('expired');

  // State is validated before the code is sent anywhere.
  if (params.state !== pending.pending.state) throw new AuthFlowError('state_mismatch');
  if (pending.pending.redirectUri !== settings.redirectUri) {
    throw new AuthFlowError('invalid_callback');
  }

  let response;
  try {
    response = await exchangeCode(settings.apiBaseUrl, {
      code: params.code,
      code_verifier: pending.pending.codeVerifier,
      redirect_uri: settings.redirectUri,
    });
  } catch (error) {
    if (error instanceof BrokerError) {
      if (error.code === 'network') throw new AuthFlowError('api_unreachable');
      if (error.code === 'invalid_grant') throw new AuthFlowError('invalid_grant');
      if (error.code === 'auth_not_configured') throw new AuthFlowError('not_configured');
    }
    throw new AuthFlowError('exchange_failed');
  }

  const token: StoredToken = {
    accessToken: response.access_token,
    expiresAt: now + response.expires_in * 1000,
  };
  try {
    saveToken(token);
  } catch {
    throw new AuthFlowError('storage_unavailable');
  }
  return token;
}
