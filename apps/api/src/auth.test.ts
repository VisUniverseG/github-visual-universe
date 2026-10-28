import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { AuthLogReason } from './auth.js';
import type { AuthConfig } from './config.js';

// Everything below is synthetic test data. No real credential, and no real GitHub call: GitHub is
// replaced by a mocked fetch.
const SECRET = 'fake-secret-for-tests';
const CLIENT_ID = 'test-client-id';
const GOOD_REDIRECT = 'http://localhost:5173/auth/callback';
const ORIGIN = 'http://localhost:5173';
const CODE = 'code-one-time-1234';
const VERIFIER = 'v'.repeat(43);
const ACCESS_TOKEN = `ghu_${'t'.repeat(36)}`;
const REFRESH_TOKEN = `ghr_${'r'.repeat(36)}`;

const auth: AuthConfig = {
  clientId: CLIENT_ID,
  clientSecret: SECRET,
  allowedRedirectUris: [GOOD_REDIRECT],
};

const validBody = { code: CODE, code_verifier: VERIFIER, redirect_uri: GOOD_REDIRECT };
const SENSITIVE = [SECRET, CODE, VERIFIER, ACCESS_TOKEN, REFRESH_TOKEN];

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function githubOk(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    refresh_token_expires_in: 15811200,
    expires_in: 28800,
    token_type: 'bearer',
    scope: '',
    ...extra,
  });
}

function setup(
  options: { auth?: AuthConfig | null; github?: () => Response | Promise<Response> } = {},
) {
  const logs: AuthLogReason[] = [];
  const fetchImpl: FetchMock = vi.fn<typeof fetch>(() =>
    Promise.resolve(options.github ? options.github() : githubOk()),
  );
  const app = createApp({
    allowedOrigins: [ORIGIN],
    version: '1.0.0',
    auth: options.auth === undefined ? auth : options.auth,
    fetchImpl,
    log: (reason) => logs.push(reason),
  });
  return { app, fetchImpl, logs };
}

function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const init: RequestInit = {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
  return app.request(path, init);
}

/** Describes the first upstream request the broker made, in a lint-safe shape. */
function firstCall(mock: FetchMock) {
  const [input, init] = mock.mock.calls[0] ?? [];
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
  const rawBody = typeof init?.body === 'string' ? init.body : '';
  return {
    url,
    method: init?.method,
    redirect: init?.redirect,
    headers: new Headers(init?.headers),
    body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
  };
}

function expectNoSensitive(text: string): void {
  for (const value of SENSITIVE) expect(text).not.toContain(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /auth/token: success', () => {
  it('exchanges the code and returns only the access token and its lifetime', async () => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', validBody);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ access_token: ACCESS_TOKEN, expires_in: 28800 });

    const call = firstCall(fetchImpl);
    expect(call.url).toBe('https://github.com/login/oauth/access_token');
    expect(call.method).toBe('POST');
    expect(call.redirect).toBe('manual');
    expect(call.body).toEqual({
      client_id: CLIENT_ID,
      client_secret: SECRET,
      code: CODE,
      redirect_uri: GOOD_REDIRECT,
      code_verifier: VERIFIER,
    });
  });

  it('discards the refresh token and every other field from GitHub', async () => {
    const { app } = setup();
    const text = await (await post(app, '/auth/token', validBody)).text();
    expect(text).not.toContain(REFRESH_TOKEN);
    expect(text).not.toContain('refresh');
    expect(text).not.toContain('scope');
    expect(text).not.toContain(SECRET);
  });
});

describe('POST /auth/token: input validation', () => {
  it.each([
    ['missing code', { code_verifier: VERIFIER, redirect_uri: GOOD_REDIRECT }],
    ['missing verifier', { code: CODE, redirect_uri: GOOD_REDIRECT }],
    ['missing redirect_uri', { code: CODE, code_verifier: VERIFIER }],
    ['short verifier', { ...validBody, code_verifier: 'short' }],
    ['code with illegal characters', { ...validBody, code: 'a b/c' }],
    ['unknown extra field', { ...validBody, client_secret: 'attacker-supplied' }],
    ['non-object body', ['x']],
  ])('rejects %s with a generic 400 and never contacts GitHub', async (_name, body) => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON', async () => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', '{not json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON content type', async () => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', JSON.stringify(validBody), {
      'Content-Type': 'text/plain',
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: 'unsupported_media_type' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an oversized body', async () => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', { ...validBody, code: 'a'.repeat(10_000) });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'payload_too_large' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POST /auth/token: redirect URI', () => {
  it.each([
    ['a trailing-slash variant', `${GOOD_REDIRECT}/`],
    ['the 127.0.0.1 host', 'http://127.0.0.1:5173/auth/callback'],
    ['another port', 'http://localhost:5174/auth/callback'],
    ['another path', 'http://localhost:5173/other'],
    ['a different scheme', 'https://localhost:5173/auth/callback'],
    ['an attacker site', 'https://evil.example/auth/callback'],
    ['a query string', `${GOOD_REDIRECT}?x=1`],
    ['a different letter case', 'http://localhost:5173/Auth/Callback'],
  ])('rejects %s (exact string match only)', async (_name, redirect_uri) => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', { ...validBody, redirect_uri });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_redirect_uri' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('POST /auth/token: origin and CORS', () => {
  it('rejects a request with no Origin header', async () => {
    const { app, fetchImpl } = setup();
    const res = await app.request('/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'origin_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a disallowed origin and sends it no CORS headers', async () => {
    const { app, fetchImpl } = setup();
    const res = await post(app, '/auth/token', validBody, { Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('answers a preflight from the allowed origin: POST and Content-Type only, no credentials', async () => {
    const { app } = setup();
    const res = await app.request('/auth/token', {
      method: 'OPTIONS',
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-methods')).not.toContain('GET');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'content-type',
    );
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('gives no CORS headers to a preflight from another origin', async () => {
    const { app } = setup();
    const res = await app.request('/auth/token', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('leaves /health CORS unchanged: GET only', async () => {
    const { app } = setup();
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    const methods = res.headers.get('access-control-allow-methods') ?? '';
    expect(methods).toContain('GET');
    expect(methods).not.toContain('POST');
  });
});

describe('missing configuration', () => {
  it.each(['/auth/token', '/auth/revoke'])('%s answers a generic 503', async (path) => {
    const { app, fetchImpl } = setup({ auth: null });
    const res = await post(app, path, validBody);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'auth_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps /health working', async () => {
    const { app } = setup({ auth: null });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
  });

  it('starts with the old two-option signature and no auth', async () => {
    const app = createApp({ allowedOrigins: [ORIGIN], version: '1.0.0' });
    expect((await post(app, '/auth/token', validBody)).status).toBe(503);
  });
});

describe('POST /auth/token: GitHub errors', () => {
  it.each([
    [
      'bad_verification_code reported with HTTP 200',
      () => Response.json({ error: 'bad_verification_code', error_description: 'x' }),
      400,
      'invalid_grant',
      'github_bad_verification_code',
    ],
    [
      'redirect_uri_mismatch reported with HTTP 200',
      () => Response.json({ error: 'redirect_uri_mismatch' }),
      400,
      'invalid_redirect_uri',
      'github_redirect_uri_mismatch',
    ],
    [
      'bad_verification_code reported with HTTP 400',
      () => Response.json({ error: 'bad_verification_code' }, { status: 400 }),
      400,
      'invalid_grant',
      'github_bad_verification_code',
    ],
    [
      'incorrect client credentials (a server misconfiguration)',
      () => Response.json({ error: 'incorrect_client_credentials' }),
      502,
      'upstream_error',
      'github_client_credentials',
    ],
    [
      'an unknown GitHub error',
      () => Response.json({ error: 'something_new' }),
      502,
      'upstream_error',
      'github_error_other',
    ],
    [
      'an HTTP 500 with a non-JSON body',
      () => new Response('<html>oops</html>', { status: 500 }),
      502,
      'upstream_error',
      'github_http_error',
    ],
    [
      'a 200 response that is not JSON',
      () => new Response('not json', { status: 200 }),
      502,
      'upstream_error',
      'github_unexpected_body',
    ],
    [
      'a 200 response without an access token',
      () => Response.json({ token_type: 'bearer' }),
      502,
      'upstream_error',
      'github_unexpected_body',
    ],
    [
      'a token with no expiry (token expiration disabled on the app)',
      () => Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer' }),
      502,
      'upstream_error',
      'github_missing_expires_in',
    ],
    [
      'a token with a non-numeric expiry',
      () => Response.json({ access_token: ACCESS_TOKEN, expires_in: '28800' }),
      502,
      'upstream_error',
      'github_missing_expires_in',
    ],
  ])('maps %s without leaking detail', async (_name, github, status, error, reason) => {
    const { app, logs } = setup({ github });
    const res = await post(app, '/auth/token', validBody);
    const text = await res.text();

    expect(res.status).toBe(status);
    expect(JSON.parse(text)).toEqual({ error });
    expectNoSensitive(text);
    expect(logs).toEqual([reason]);
  });

  it('maps a network failure and a timeout to a generic 502', async () => {
    for (const failure of [
      new TypeError('connect ECONNREFUSED'),
      new DOMException('t', 'TimeoutError'),
    ]) {
      const logs: AuthLogReason[] = [];
      const app = createApp({
        allowedOrigins: [ORIGIN],
        version: '1.0.0',
        auth,
        fetchImpl: () => Promise.reject(failure),
        log: (reason) => logs.push(reason),
      });
      const res = await post(app, '/auth/token', validBody);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: 'upstream_error' });
      expect(logs).toEqual(['github_unreachable']);
    }
  });
});

describe('no credential leakage', () => {
  it('never writes request or response content to the console (default logger)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const cases: Array<() => Response> = [
      () => githubOk(),
      () => Response.json({ error: 'bad_verification_code', error_description: CODE }),
      () => new Response(`${SECRET} ${ACCESS_TOKEN}`, { status: 500 }),
    ];
    for (const github of cases) {
      const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(github()));
      const app = createApp({ allowedOrigins: [ORIGIN], version: '1.0.0', auth, fetchImpl });
      await post(app, '/auth/token', validBody);
      await post(app, '/auth/revoke', { access_token: ACCESS_TOKEN });
    }
    const printed = spies
      .flatMap((spy) => spy.mock.calls.map((args: unknown[]) => args.map(String).join(' ')))
      .join('\n');
    expectNoSensitive(printed);
    // The only thing ever printed is a fixed reason string.
    expect(printed).toMatch(/\[auth\] (github_|revoke_)/);
  });

  it('keeps the client secret out of every response body and header', async () => {
    const { app } = setup();
    const responses = [
      await post(app, '/auth/token', validBody),
      await post(app, '/auth/token', { nope: 1 }),
      await post(app, '/auth/revoke', { access_token: ACCESS_TOKEN }),
      await app.request('/health'),
      await app.request('/auth/unknown', { headers: { Origin: ORIGIN } }),
    ];
    for (const res of responses) {
      const headers = [...res.headers.entries()].flat().join('\n');
      expect(headers).not.toContain(SECRET);
      expect(await res.text()).not.toContain(SECRET);
    }
  });

  it('turns an unexpected exception into a generic 500 that does not echo the error', async () => {
    // The log hook throwing is a stand-in for any unforeseen internal failure.
    const app = createApp({
      allowedOrigins: [ORIGIN],
      version: '1.0.0',
      auth,
      fetchImpl: () => Promise.resolve(Response.json({ error: 'bad_verification_code' })),
      log: () => {
        throw new Error(`boom ${SECRET}`);
      },
    });
    const res = await post(app, '/auth/token', validBody);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
    expect(text).not.toContain(SECRET);
  });
});

describe('POST /auth/revoke', () => {
  it('reports revoked only when GitHub confirms with 204', async () => {
    const { app, fetchImpl } = setup({ github: () => new Response(null, { status: 204 }) });
    const res = await post(app, '/auth/revoke', { access_token: ACCESS_TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });

    const call = firstCall(fetchImpl);
    expect(call.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
    expect(call.method).toBe('DELETE');
    expect(call.body).toEqual({ access_token: ACCESS_TOKEN });
    const basic = call.headers.get('authorization') ?? '';
    expect(Buffer.from(basic.replace('Basic ', ''), 'base64').toString()).toBe(
      `${CLIENT_ID}:${SECRET}`,
    );
  });

  it.each([
    ['404', () => new Response('{}', { status: 404 })],
    ['422', () => new Response('{}', { status: 422 })],
    ['500', () => new Response('{}', { status: 500 })],
    ['a 200 that is not a 204', () => Response.json({ revoked: true })],
    ['a 202', () => new Response(null, { status: 202 })],
  ])('does NOT report success when GitHub answers %s', async (_name, github) => {
    const { app, logs } = setup({ github });
    const res = await post(app, '/auth/revoke', { access_token: ACCESS_TOKEN });
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(JSON.parse(text)).toEqual({ error: 'revocation_not_confirmed' });
    expect(text).not.toContain('"revoked"');
    expectNoSensitive(text);
    expect(logs).toEqual(['revoke_not_confirmed']);
  });

  it('does NOT report success when GitHub cannot be reached', async () => {
    const app = createApp({
      allowedOrigins: [ORIGIN],
      version: '1.0.0',
      auth,
      fetchImpl: () => Promise.reject(new TypeError('offline')),
      log: () => undefined,
    });
    const res = await post(app, '/auth/revoke', { access_token: ACCESS_TOKEN });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'revocation_not_confirmed' });
  });

  it('validates input and the origin like the token endpoint', async () => {
    const { app, fetchImpl } = setup();
    expect((await post(app, '/auth/revoke', {})).status).toBe(400);
    expect((await post(app, '/auth/revoke', { access_token: ACCESS_TOKEN, extra: 1 })).status).toBe(
      400,
    );
    expect(
      (
        await post(
          app,
          '/auth/revoke',
          { access_token: ACCESS_TOKEN },
          { Origin: 'https://evil.example' },
        )
      ).status,
    ).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
