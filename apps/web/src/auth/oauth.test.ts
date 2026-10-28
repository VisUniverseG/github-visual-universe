import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_CODE, TEST_TOKEN, TEST_VERIFIER, createFakeFetch } from '../testing/fakeFetch.ts';
import type { AuthSettings } from './config.ts';
import {
  AuthFlowError,
  beginAuthorization,
  buildAuthorizeUrl,
  completeAuthorization,
  takeCallbackParams,
} from './oauth.ts';
import { computeCodeChallenge } from './pkce.ts';
import { consumePending, loadToken, savePending } from './session.ts';

const settings: AuthSettings = {
  clientId: 'test-client-id',
  redirectUri: 'http://localhost:5173/auth/callback',
  apiBaseUrl: 'http://localhost:8787',
};
const NOW = 2_000_000;

function seedPending(overrides: Partial<Parameters<typeof savePending>[0]> = {}) {
  savePending({
    state: 'expected-state',
    codeVerifier: TEST_VERIFIER,
    redirectUri: settings.redirectUri,
    createdAt: NOW,
    ...overrides,
  });
}

function exchangeNetwork(
  respond = () => Response.json({ access_token: TEST_TOKEN, expires_in: 28800 }),
) {
  const net = createFakeFetch({ [`POST ${settings.apiBaseUrl}/auth/token`]: respond });
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('buildAuthorizeUrl', () => {
  it('asks for S256 PKCE with the exact redirect URI and no secret', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: 'test-client-id',
        redirectUri: settings.redirectUri,
        state: 's',
        codeChallenge: 'c',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'test-client-id',
      redirect_uri: settings.redirectUri,
      state: 's',
      code_challenge: 'c',
      code_challenge_method: 'S256',
    });
  });
});

describe('beginAuthorization', () => {
  it('stores state and verifier, wakes the API, then redirects with the matching challenge', async () => {
    const prewarm = vi.fn(() => Promise.resolve());
    const navigate = vi.fn();
    await beginAuthorization(settings, { prewarm, navigate, now: () => NOW });

    expect(prewarm).toHaveBeenCalledWith(settings.apiBaseUrl);
    expect(navigate).toHaveBeenCalledTimes(1);
    const target = new URL(String(navigate.mock.calls[0]?.[0]));
    const stored = consumePending(NOW);
    if (stored.kind !== 'ok') throw new Error('expected a pending authorization');

    expect(target.searchParams.get('state')).toBe(stored.pending.state);
    expect(target.searchParams.get('code_challenge')).toBe(
      await computeCodeChallenge(stored.pending.codeVerifier),
    );
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.href).not.toContain(stored.pending.codeVerifier);
    expect(stored.pending.redirectUri).toBe(settings.redirectUri);
  });

  it('does not redirect, and clears what it stored, if the API cannot be reached', async () => {
    const navigate = vi.fn();
    const failure = await beginAuthorization(settings, {
      prewarm: () => Promise.reject(new Error('down')),
      navigate,
    }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(AuthFlowError);
    expect((failure as AuthFlowError).code).toBe('api_unreachable');
    expect(navigate).not.toHaveBeenCalled();
    expect(consumePending(NOW)).toEqual({ kind: 'missing' });
  });

  it('refuses to start when session storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const navigate = vi.fn();
    const failure = await beginAuthorization(settings, {
      prewarm: () => Promise.resolve(),
      navigate,
    }).catch((e: unknown) => e);
    vi.restoreAllMocks();

    expect((failure as AuthFlowError).code).toBe('storage_unavailable');
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('takeCallbackParams', () => {
  it('reads the parameters and immediately replaces the URL with the home URL', () => {
    const replaceState = vi.fn();
    const params = takeCallbackParams(
      { search: `?code=${TEST_CODE}&state=abc` },
      { replaceState },
      '/app/',
    );
    expect(params).toEqual({ code: TEST_CODE, state: 'abc', error: null });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/app/');
  });
});

describe('completeAuthorization', () => {
  it('exchanges the code and stores only the token and its expiry', async () => {
    seedPending();
    const net = exchangeNetwork();

    const token = await completeAuthorization(
      { code: TEST_CODE, state: 'expected-state', error: null },
      settings,
      { now: () => NOW },
    );

    expect(token).toEqual({ accessToken: TEST_TOKEN, expiresAt: NOW + 28_800_000 });
    expect(loadToken(NOW)).toEqual(token);
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]?.body).toEqual({
      code: TEST_CODE,
      code_verifier: TEST_VERIFIER,
      redirect_uri: settings.redirectUri,
    });
    // The pending state/verifier cannot be used again.
    expect(consumePending(NOW)).toEqual({ kind: 'missing' });
  });

  it('rejects a state mismatch BEFORE sending the code anywhere, and burns the pending record', async () => {
    seedPending();
    const net = exchangeNetwork();

    await expect(
      completeAuthorization({ code: TEST_CODE, state: 'attacker-state', error: null }, settings, {
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'state_mismatch' });

    expect(net.requests).toHaveLength(0);
    expect(loadToken(NOW)).toBeNull();
    expect(consumePending(NOW)).toEqual({ kind: 'missing' });
  });

  it('fails when there is no pending sign-in (e.g. a forged or replayed callback)', async () => {
    const net = exchangeNetwork();
    await expect(
      completeAuthorization({ code: TEST_CODE, state: 'expected-state', error: null }, settings, {
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'no_pending' });
    expect(net.requests).toHaveLength(0);
  });

  it('fails when the pending sign-in has expired', async () => {
    seedPending({ createdAt: NOW - 11 * 60 * 1000 });
    const net = exchangeNetwork();
    await expect(
      completeAuthorization({ code: TEST_CODE, state: 'expected-state', error: null }, settings, {
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(net.requests).toHaveLength(0);
  });

  it('treats a replay of the same callback as a failure with no second exchange', async () => {
    seedPending();
    const net = exchangeNetwork();
    const params = { code: TEST_CODE, state: 'expected-state', error: null };
    await completeAuthorization(params, settings, { now: () => NOW });
    await expect(completeAuthorization(params, settings, { now: () => NOW })).rejects.toMatchObject(
      {
        code: 'no_pending',
      },
    );
    expect(net.requests).toHaveLength(1);
  });

  it('handles the user denying access', async () => {
    seedPending();
    const net = exchangeNetwork();
    await expect(
      completeAuthorization(
        { code: null, state: 'expected-state', error: 'access_denied' },
        settings,
      ),
    ).rejects.toMatchObject({ code: 'denied' });
    expect(net.requests).toHaveLength(0);
    expect(consumePending()).toEqual({ kind: 'missing' });
  });

  it.each([
    ['another GitHub error', { code: null, state: 'expected-state', error: 'something_else' }],
    ['a missing code', { code: null, state: 'expected-state', error: null }],
    ['a missing state', { code: TEST_CODE, state: null, error: null }],
    ['an empty code', { code: '', state: 'expected-state', error: null }],
  ])('rejects %s as an invalid callback', async (_name, params) => {
    seedPending();
    const net = exchangeNetwork();
    await expect(completeAuthorization(params, settings, { now: () => NOW })).rejects.toMatchObject(
      {
        code: 'invalid_callback',
      },
    );
    expect(net.requests).toHaveLength(0);
  });

  it('rejects a pending record created for a different redirect URI', async () => {
    seedPending({ redirectUri: 'http://localhost:5173/other' });
    const net = exchangeNetwork();
    await expect(
      completeAuthorization({ code: TEST_CODE, state: 'expected-state', error: null }, settings, {
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid_callback' });
    expect(net.requests).toHaveLength(0);
  });

  it.each([
    ['invalid_grant', 400, 'invalid_grant'],
    ['auth_not_configured', 503, 'not_configured'],
    ['upstream_error', 502, 'exchange_failed'],
    ['invalid_redirect_uri', 400, 'exchange_failed'],
  ])('maps broker error %s to %s', async (brokerCode, status, expected) => {
    seedPending();
    exchangeNetwork(() => Response.json({ error: brokerCode }, { status }));
    await expect(
      completeAuthorization({ code: TEST_CODE, state: 'expected-state', error: null }, settings, {
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: expected });
    expect(loadToken(NOW)).toBeNull();
  });

  it('maps an unreachable broker to api_unreachable', async () => {
    seedPending();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(
      completeAuthorization({ code: TEST_CODE, state: 'expected-state', error: null }, settings, {
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'api_unreachable' });
  });

  it('never puts the code, verifier or token in an error message', async () => {
    seedPending();
    exchangeNetwork(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const error = await completeAuthorization(
      { code: TEST_CODE, state: 'expected-state', error: null },
      settings,
      { now: () => NOW },
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    for (const secret of [TEST_CODE, TEST_VERIFIER, TEST_TOKEN, 'expected-state']) {
      expect(message).not.toContain(secret);
    }
  });
});
