import { useCallback, useEffect, useRef, useState } from 'react';
import { revokeToken } from './broker.ts';
import { isCallbackLocation, type AuthSettingsResult } from './config.ts';
import {
  AUTH_FAILURE_MESSAGES,
  AuthFlowError,
  beginAuthorization,
  completeAuthorization,
  takeCallbackParams,
  type BeginDeps,
} from './oauth.ts';
import { clearAll, loadToken, type StoredToken } from './session.ts';

/**
 * Disconnect has two separate halves, and the UI reports them separately:
 *   1. Clearing the browser session: immediate, local, always succeeds.
 *   2. Revoking the token at GitHub: asked of the broker afterwards, and reported as done only
 *      if GitHub confirmed it.
 */
export const SESSION_MESSAGES = {
  clearedRevoking:
    'Disconnected in this browser: the session was cleared. Asking GitHub to revoke the token…',
  revoked: 'Disconnected in this browser, and GitHub confirmed the token was revoked.',
  revokeNotConfirmed:
    'Disconnected in this browser, but GitHub did not confirm the token was revoked. It may stay valid until it expires (up to 8 hours). To revoke it now, use GitHub → Settings → Applications → Authorized GitHub Apps.',
  sessionExpired: 'Your GitHub session expired or was revoked. Connect again to continue.',
} as const;

export type SessionState =
  | { readonly kind: 'signed_out' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'completing' }
  | { readonly kind: 'signed_in'; readonly token: StoredToken };

export interface SessionNotice {
  readonly tone: 'error' | 'info' | 'warning';
  readonly text: string;
}

export interface SessionDeps extends BeginDeps {
  readonly settings: AuthSettingsResult;
  /** Where the address bar is sent once a callback has been read. */
  readonly homeUrl: string;
}

type CallbackResult =
  | { readonly ok: true; readonly token: StoredToken }
  | { readonly ok: false; readonly message: string };

function initialState(settings: AuthSettingsResult): SessionState {
  if (settings.ok && isCallbackLocation(window.location, settings.settings.redirectUri)) {
    return { kind: 'completing' };
  }
  const token = loadToken();
  return token ? { kind: 'signed_in', token } : { kind: 'signed_out' };
}

export function useGitHubSession(deps: SessionDeps) {
  const { settings, homeUrl } = deps;
  const [state, setState] = useState<SessionState>(() => initialState(settings));
  const [notice, setNotice] = useState<SessionNotice | null>(null);
  // Holds the single in-flight callback so React StrictMode's double effect run cannot make
  // a second exchange with the same one-time code.
  const callbackRef = useRef<Promise<CallbackResult> | null>(null);

  useEffect(() => {
    if (!settings.ok) return;
    let promise = callbackRef.current;
    if (!promise) {
      if (!isCallbackLocation(window.location, settings.settings.redirectUri)) return;
      const config = settings.settings;
      // Reads and scrubs the URL synchronously, before any await.
      const params = takeCallbackParams(window.location, window.history, homeUrl);
      promise = completeAuthorization(params, config).then(
        (token): CallbackResult => ({ ok: true, token }),
        (error: unknown): CallbackResult => ({
          ok: false,
          message:
            error instanceof AuthFlowError ? error.message : AUTH_FAILURE_MESSAGES.exchange_failed,
        }),
      );
      callbackRef.current = promise;
    }

    let cancelled = false;
    void promise.then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setNotice(null);
        setState({ kind: 'signed_in', token: result.token });
      } else {
        setNotice({ tone: 'error', text: result.message });
        setState({ kind: 'signed_out' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settings, homeUrl]);

  const connect = useCallback(async () => {
    if (!settings.ok) {
      setNotice({ tone: 'error', text: AUTH_FAILURE_MESSAGES.not_configured });
      return;
    }
    setNotice(null);
    setState({ kind: 'connecting' });
    try {
      // On success the browser navigates to GitHub and this page goes away.
      await beginAuthorization(settings.settings, deps);
    } catch (error) {
      setNotice({
        tone: 'error',
        text:
          error instanceof AuthFlowError ? error.message : AUTH_FAILURE_MESSAGES.exchange_failed,
      });
      setState({ kind: 'signed_out' });
    }
  }, [settings, deps]);

  const disconnect = useCallback(async () => {
    if (state.kind !== 'signed_in' || !settings.ok) return;
    const { accessToken } = state.token;

    clearAll();
    setState({ kind: 'signed_out' });
    setNotice({ tone: 'info', text: SESSION_MESSAGES.clearedRevoking });

    const outcome = await revokeToken(settings.settings.apiBaseUrl, accessToken);
    setNotice(
      outcome === 'confirmed'
        ? { tone: 'info', text: SESSION_MESSAGES.revoked }
        : { tone: 'warning', text: SESSION_MESSAGES.revokeNotConfirmed },
    );
  }, [state, settings]);

  /** The token was rejected by GitHub (401). It is already dead, so there is nothing to revoke. */
  const expireSession = useCallback(() => {
    clearAll();
    setState({ kind: 'signed_out' });
    setNotice({ tone: 'warning', text: SESSION_MESSAGES.sessionExpired });
  }, []);

  return { state, notice, connect, disconnect, expireSession };
}
