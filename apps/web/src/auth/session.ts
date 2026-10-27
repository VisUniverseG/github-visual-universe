/**
 * Browser-session storage for the sign-in flow.
 *
 * Everything lives in `sessionStorage` (per tab, cleared when the tab closes), never
 * `localStorage`. Only the short-lived access token is stored: the broker never sends a refresh
 * token to the browser. See ADR 0001 (D1).
 */

const PENDING_KEY = 'gvu.oauth.pending';
const TOKEN_KEY = 'gvu.auth.token';

/** A sign-in must finish within this window or the stored state and verifier are discarded. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
/** A token this close to expiry is treated as already expired. */
export const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;

export interface PendingAuthorization {
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly createdAt: number;
}

export interface StoredToken {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export type PendingResult =
  | { readonly kind: 'ok'; readonly pending: PendingAuthorization }
  | { readonly kind: 'missing' }
  | { readonly kind: 'expired' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(key: string): unknown {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function remove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

/** Throws if storage is unavailable, so the caller can refuse to start a flow it cannot finish. */
export function savePending(pending: PendingAuthorization): void {
  window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

/** Reads and removes the pending authorization in one step, so a callback can be used only once. */
export function consumePending(now: number = Date.now()): PendingResult {
  const value = readJson(PENDING_KEY);
  remove(PENDING_KEY);
  if (
    !isRecord(value) ||
    typeof value['state'] !== 'string' ||
    typeof value['codeVerifier'] !== 'string' ||
    typeof value['redirectUri'] !== 'string' ||
    typeof value['createdAt'] !== 'number'
  ) {
    return { kind: 'missing' };
  }
  const pending: PendingAuthorization = {
    state: value['state'],
    codeVerifier: value['codeVerifier'],
    redirectUri: value['redirectUri'],
    createdAt: value['createdAt'],
  };
  if (now - pending.createdAt > PENDING_TTL_MS || pending.createdAt > now) {
    return { kind: 'expired' };
  }
  return { kind: 'ok', pending };
}

export function clearPending(): void {
  remove(PENDING_KEY);
}

export function saveToken(token: StoredToken): void {
  window.sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

/** Returns the stored token, or `null` (clearing it) if absent, malformed or about to expire. */
export function loadToken(now: number = Date.now()): StoredToken | null {
  const value = readJson(TOKEN_KEY);
  if (
    !isRecord(value) ||
    typeof value['accessToken'] !== 'string' ||
    value['accessToken'] === '' ||
    typeof value['expiresAt'] !== 'number'
  ) {
    if (value !== null) remove(TOKEN_KEY);
    return null;
  }
  if (value['expiresAt'] - now <= TOKEN_EXPIRY_MARGIN_MS) {
    remove(TOKEN_KEY);
    return null;
  }
  return { accessToken: value['accessToken'], expiresAt: value['expiresAt'] };
}

export function clearToken(): void {
  remove(TOKEN_KEY);
}

/** Clears the token and any temporary OAuth data. This is the browser half of "Disconnect". */
export function clearAll(): void {
  clearToken();
  clearPending();
}
