import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PENDING_TTL_MS,
  TOKEN_EXPIRY_MARGIN_MS,
  clearAll,
  consumePending,
  loadToken,
  savePending,
  saveToken,
} from './session.ts';

const pending = {
  state: 'state-1',
  codeVerifier: 'verifier-1',
  redirectUri: 'http://localhost:5173/auth/callback',
  createdAt: 1_000_000,
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});

describe('pending authorization', () => {
  it('is consumed exactly once', () => {
    savePending(pending);
    expect(consumePending(pending.createdAt + 1)).toEqual({ kind: 'ok', pending });
    expect(consumePending(pending.createdAt + 2)).toEqual({ kind: 'missing' });
  });

  it('expires after the TTL, and is still removed', () => {
    savePending(pending);
    expect(consumePending(pending.createdAt + PENDING_TTL_MS + 1)).toEqual({ kind: 'expired' });
    expect(consumePending(pending.createdAt + 1)).toEqual({ kind: 'missing' });
  });

  it('rejects a record dated in the future', () => {
    savePending(pending);
    expect(consumePending(pending.createdAt - 5)).toEqual({ kind: 'expired' });
  });

  it('treats malformed storage as missing', () => {
    sessionStorage.setItem('gvu.oauth.pending', '{"state": 1}');
    expect(consumePending()).toEqual({ kind: 'missing' });
    sessionStorage.setItem('gvu.oauth.pending', 'not json');
    expect(consumePending()).toEqual({ kind: 'missing' });
  });
});

describe('access token', () => {
  it('round-trips and lives only in sessionStorage', () => {
    const token = { accessToken: 'tok', expiresAt: Date.now() + 3_600_000 };
    saveToken(token);
    expect(loadToken()).toEqual(token);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
  });

  it('does not store anything beyond the access token and its expiry', () => {
    saveToken({ accessToken: 'tok', expiresAt: Date.now() + 3_600_000 });
    const raw = sessionStorage.getItem('gvu.auth.token') ?? '';
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual(['accessToken', 'expiresAt']);
  });

  it('drops an expired token, including one inside the safety margin', () => {
    const now = 5_000_000;
    saveToken({ accessToken: 'tok', expiresAt: now + TOKEN_EXPIRY_MARGIN_MS });
    expect(loadToken(now)).toBeNull();
    expect(sessionStorage.getItem('gvu.auth.token')).toBeNull();
  });

  it('drops a malformed token', () => {
    sessionStorage.setItem('gvu.auth.token', '{"accessToken":"","expiresAt":1}');
    expect(loadToken()).toBeNull();
    expect(sessionStorage.getItem('gvu.auth.token')).toBeNull();
  });
});

describe('clearAll', () => {
  it('removes the token and temporary OAuth data', () => {
    saveToken({ accessToken: 'tok', expiresAt: Date.now() + 3_600_000 });
    savePending({ ...pending, createdAt: Date.now() });
    clearAll();
    expect(sessionStorage.length).toBe(0);
  });
});
