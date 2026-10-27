import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrokerError, exchangeCode, revokeToken } from './broker.ts';
import { TEST_CODE, TEST_TOKEN, TEST_VERIFIER, createFakeFetch } from '../testing/fakeFetch.ts';

const API = 'http://localhost:8787';
const request = {
  code: TEST_CODE,
  code_verifier: TEST_VERIFIER,
  redirect_uri: 'http://localhost:5173/auth/callback',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('exchangeCode', () => {
  it('posts the code and verifier to the broker and returns the validated token response', async () => {
    const net = createFakeFetch({
      [`POST ${API}/auth/token`]: () =>
        Response.json({ access_token: TEST_TOKEN, expires_in: 28800 }),
    });
    vi.stubGlobal('fetch', net.fetch);

    await expect(exchangeCode(API, request)).resolves.toEqual({
      access_token: TEST_TOKEN,
      expires_in: 28800,
    });

    const sent = net.requests[0];
    expect(sent?.body).toEqual(request);
    expect(sent?.init.credentials).toBe('omit');
    expect(sent?.init.redirect).toBe('error');
    expect(sent?.headers.get('authorization')).toBeNull();
  });

  it('maps broker error codes', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`POST ${API}/auth/token`]: () =>
          Response.json({ error: 'invalid_grant' }, { status: 400 }),
      }).fetch,
    );
    await expect(exchangeCode(API, request)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('falls back to upstream_error for an unrecognised error body', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`POST ${API}/auth/token`]: () => new Response('<html>', { status: 500 }),
      }).fetch,
    );
    await expect(exchangeCode(API, request)).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('rejects a success response that breaks the shared contract (e.g. carries a refresh token)', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        [`POST ${API}/auth/token`]: () =>
          Response.json({ access_token: TEST_TOKEN, expires_in: 1, refresh_token: 'ghr_x' }),
      }).fetch,
    );
    await expect(exchangeCode(API, request)).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reports a network failure without leaking request content in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError(`failed ${TEST_CODE}`))),
    );
    const error = await exchangeCode(API, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe('network');
    expect((error as BrokerError).message).not.toContain(TEST_CODE);
  });
});

describe('revokeToken', () => {
  it('is confirmed only when the broker reports revoked: true', async () => {
    const net = createFakeFetch({
      [`POST ${API}/auth/revoke`]: () => Response.json({ revoked: true }),
    });
    vi.stubGlobal('fetch', net.fetch);
    await expect(revokeToken(API, TEST_TOKEN)).resolves.toBe('confirmed');
    expect(net.requests[0]?.body).toEqual({ access_token: TEST_TOKEN });
  });

  it.each([
    [
      'revocation_not_confirmed (502)',
      () => Response.json({ error: 'revocation_not_confirmed' }, { status: 502 }),
    ],
    [
      'auth not configured (503)',
      () => Response.json({ error: 'auth_not_configured' }, { status: 503 }),
    ],
    ['a 200 without revoked: true', () => Response.json({ revoked: false })],
    ['a 200 with a non-JSON body', () => new Response('ok')],
  ])('is not confirmed for %s', async (_name, respond) => {
    vi.stubGlobal('fetch', createFakeFetch({ [`POST ${API}/auth/revoke`]: respond }).fetch);
    await expect(revokeToken(API, TEST_TOKEN)).resolves.toBe('not_confirmed');
  });

  it('is not confirmed, and does not throw, when the broker is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await expect(revokeToken(API, TEST_TOKEN)).resolves.toBe('not_confirmed');
  });
});
