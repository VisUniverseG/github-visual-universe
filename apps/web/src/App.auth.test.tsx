import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import type { AuthSettingsResult } from './auth/config.ts';
import { SESSION_MESSAGES } from './auth/useGitHubSession.ts';
import { loadToken, savePending, saveToken } from './auth/session.ts';
import { REPOSITORY_MESSAGES } from './dashboard/messages.ts';
import {
  TEST_CODE,
  TEST_TOKEN,
  TEST_VERIFIER,
  createFakeFetch,
  fakeRepo,
  type Handler,
} from './testing/fakeFetch.ts';

const API = 'http://localhost:8787';
const GH = 'https://api.github.com';
const REDIRECT_URI = `${window.location.origin}/auth/callback`;
const STATE = 'expected-state-value';

const settings: AuthSettingsResult = {
  ok: true,
  settings: { clientId: 'test-client-id', redirectUri: REDIRECT_URI, apiBaseUrl: API },
};

type Routes = Record<string, Handler>;

function network(overrides: Routes = {}) {
  const net = createFakeFetch({
    [`GET ${API}/health`]: () =>
      Response.json({ status: 'ok', service: 'gvu-api', version: '1.0.0' }),
    [`GET ${GH}/user`]: () => Response.json({ login: 'octo' }),
    [`GET ${GH}/user/installations`]: () =>
      Response.json({ total_count: 1, installations: [{ id: 7, account: { login: 'octo' } }] }),
    [`GET ${GH}/user/installations/7/repositories`]: () =>
      Response.json({ total_count: 1, repositories: [fakeRepo(1, 'alpha')] }),
    ...overrides,
  });
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

function repoResponse(repositories: Record<string, unknown>[], next?: string): Response {
  return Response.json(
    { total_count: repositories.length, repositories },
    next ? { headers: { Link: `<${next}>; rel="next"` } } : {},
  );
}

function signIn(): void {
  saveToken({ accessToken: TEST_TOKEN, expiresAt: Date.now() + 3_600_000 });
}

function arriveAtCallback(query: string): void {
  window.history.replaceState(null, '', `/auth/callback${query}`);
}

function renderApp(auth: Record<string, unknown> = {}, strict = true) {
  const tree = <App auth={{ settings, homeUrl: '/', ...auth }} />;
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

/** Collects everything printed to the console during a test. */
function captureConsole(): () => string {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
  return () =>
    spies
      .flatMap((spy) => spy.mock.calls.map((args: unknown[]) => args.map(String).join(' ')))
      .join('\n');
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('signed out', () => {
  it('explains when sign-in is not configured and offers no Connect button', () => {
    network();
    renderApp({ settings: { ok: false } });
    expect(screen.getByText('Sign-in is not configured for this deployment.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
  });

  it('starts sign-in: stores state + verifier, redirects to GitHub with S256 and no secret', async () => {
    network();
    const navigate = vi.fn();
    renderApp({ navigate, prewarm: () => Promise.resolve() });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledTimes(1);
    });

    const target = new URL(String(navigate.mock.calls[0]?.[0]));
    expect(target.origin + target.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(target.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('client_id')).toBe('test-client-id');

    const stored = JSON.parse(sessionStorage.getItem('gvu.oauth.pending') ?? '{}') as {
      state: string;
      codeVerifier: string;
    };
    expect(target.searchParams.get('state')).toBe(stored.state);
    expect(target.href).not.toContain(stored.codeVerifier);
    expect(localStorage.length).toBe(0);
  });

  it('shows an error and stays signed out if the API cannot be reached', async () => {
    network();
    const navigate = vi.fn();
    renderApp({ navigate, prewarm: () => Promise.reject(new Error('down')) });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect GitHub' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/API is unreachable/);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });
});

describe('OAuth callback', () => {
  function seedCallback(state = STATE) {
    savePending({
      state,
      codeVerifier: TEST_VERIFIER,
      redirectUri: REDIRECT_URI,
      createdAt: Date.now(),
    });
    arriveAtCallback(`?code=${TEST_CODE}&state=${state}`);
  }

  it('exchanges the code exactly once (even under StrictMode), scrubs the URL, stores the token and lists repositories', async () => {
    const printed = captureConsole();
    const net = network({
      [`POST ${API}/auth/token`]: () =>
        Response.json({ access_token: TEST_TOKEN, expires_in: 28800 }),
    });
    seedCallback();

    const { container } = renderApp();

    expect(await screen.findByText('octo/alpha')).toBeTruthy();

    const exchanges = net.requests.filter((r) => r.url.pathname === '/auth/token');
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.body).toEqual({
      code: TEST_CODE,
      code_verifier: TEST_VERIFIER,
      redirect_uri: REDIRECT_URI,
    });

    // URL scrubbed: no code or state remain anywhere in the address.
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(TEST_CODE);
    expect(window.location.href).not.toContain(STATE);

    // Token only in sessionStorage; temporary data gone; nothing in localStorage.
    expect(loadToken()?.accessToken).toBe(TEST_TOKEN);
    expect(sessionStorage.getItem('gvu.oauth.pending')).toBeNull();
    expect(localStorage.length).toBe(0);

    // No credential in the page or the console.
    for (const secret of [TEST_TOKEN, TEST_CODE, TEST_VERIFIER]) {
      expect(container.innerHTML).not.toContain(secret);
      expect(printed()).not.toContain(secret);
    }
  });

  it('rejects a mismatched state without sending the code to the broker', async () => {
    const net = network({
      [`POST ${API}/auth/token`]: () =>
        Response.json({ access_token: TEST_TOKEN, expires_in: 1000 }),
    });
    savePending({
      state: STATE,
      codeVerifier: TEST_VERIFIER,
      redirectUri: REDIRECT_URI,
      createdAt: Date.now(),
    });
    arriveAtCallback(`?code=${TEST_CODE}&state=attacker-state`);

    renderApp();

    expect((await screen.findByRole('alert')).textContent).toMatch(/did not match this session/);
    expect(net.requests.some((r) => r.url.pathname === '/auth/token')).toBe(false);
    expect(loadToken()).toBeNull();
    expect(sessionStorage.getItem('gvu.oauth.pending')).toBeNull();
    expect(window.location.search).toBe('');
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });

  it('handles the user cancelling on GitHub', async () => {
    const net = network();
    savePending({
      state: STATE,
      codeVerifier: TEST_VERIFIER,
      redirectUri: REDIRECT_URI,
      createdAt: Date.now(),
    });
    arriveAtCallback(`?error=access_denied&error_description=The+user+denied&state=${STATE}`);

    renderApp();

    expect((await screen.findByRole('alert')).textContent).toMatch(/cancelled/);
    expect(window.location.search).toBe('');
    expect(net.requests.some((r) => r.url.pathname === '/auth/token')).toBe(false);
  });

  it('does not echo attacker-controlled callback text into the page', async () => {
    network();
    arriveAtCallback('?error=access_denied&error_description=%3Cimg%20src%3Dx%3E');
    const { container } = renderApp();
    await screen.findByRole('alert');
    expect(container.innerHTML).not.toContain('<img');
    expect(container.innerHTML).not.toContain('error_description');
  });

  it('reports a rejected code from the broker', async () => {
    network({
      [`POST ${API}/auth/token`]: () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    });
    seedCallback();
    renderApp();
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or already used/);
    expect(loadToken()).toBeNull();
  });

  it('fails cleanly when the callback has no pending sign-in', async () => {
    const net = network();
    arriveAtCallback(`?code=${TEST_CODE}&state=${STATE}`);
    renderApp();
    expect((await screen.findByRole('alert')).textContent).toMatch(/No sign-in was in progress/);
    expect(net.requests.some((r) => r.url.pathname === '/auth/token')).toBe(false);
  });
});

describe('dashboard inside the signed-in app', () => {
  it('shows the connected state and the repository cards after sign-in', async () => {
    network({
      [`GET ${GH}/user/installations/7/repositories`]: () =>
        repoResponse([
          fakeRepo(1, 'alpha', {
            private: true,
            description: 'Secret sauce',
            language: 'TypeScript',
            stargazers_count: 5,
            updated_at: '2026-03-01T10:00:00Z',
          }),
          fakeRepo(2, 'beta'),
        ]),
    });
    signIn();
    renderApp();

    const title = await screen.findByRole('button', { name: 'octo/alpha' });
    expect(screen.getByText('Connected · read-only')).toBeTruthy();

    const card = title.closest('article');
    if (!card) throw new Error('expected a card');
    expect(within(card).getByText('Private')).toBeTruthy();
    expect(within(card).getByText('Owner: octo')).toBeTruthy();
    expect(within(card).getByText('Secret sauce')).toBeTruthy();
    expect(within(card).getByText('TypeScript')).toBeTruthy();
    expect(within(card).getByText('★ 5')).toBeTruthy();
    const link = within(card).getByRole('link', { name: 'Open octo/alpha on GitHub' });
    expect(link.getAttribute('href')).toBe('https://github.com/octo/alpha');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('renders a repository with an unsafe URL without a link', async () => {
    network({
      [`GET ${GH}/user/installations/7/repositories`]: () =>
        repoResponse([fakeRepo(1, 'evil', { html_url: 'javascript:alert(1)' })]),
    });
    signIn();
    renderApp();
    expect(await screen.findByRole('button', { name: 'octo/evil' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /octo\/evil/ })).toBeNull();
  });

  it('ends the session when GitHub rejects the token (401), without calling revoke', async () => {
    const net = network({
      [`GET ${GH}/user/installations`]: () =>
        Response.json({ message: 'Bad credentials' }, { status: 401 }),
    });
    signIn();
    renderApp();

    await screen.findByText(SESSION_MESSAGES.sessionExpired);
    expect(loadToken()).toBeNull();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
    expect(net.requests.some((r) => r.url.pathname === '/auth/revoke')).toBe(false);
  });

  it('ends the session when GET /user is rejected with 401', async () => {
    network({
      [`GET ${GH}/user`]: () => Response.json({ message: 'Bad credentials' }, { status: 401 }),
    });
    signIn();
    renderApp();
    await screen.findByText(SESSION_MESSAGES.sessionExpired);
    expect(loadToken()).toBeNull();
  });

  it('shows the install guidance when the App is installed nowhere', async () => {
    network({
      [`GET ${GH}/user/installations`]: () => Response.json({ total_count: 0, installations: [] }),
    });
    signIn();
    renderApp();
    expect(await screen.findByText(REPOSITORY_MESSAGES.empty)).toBeTruthy();
  });

  it('shows a rate-limit error and recovers on retry', async () => {
    // A flag rather than a call counter: StrictMode intentionally runs the first load twice.
    let limited = true;
    network({
      [`GET ${GH}/user/installations/7/repositories`]: () =>
        limited
          ? new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
          : repoResponse([fakeRepo(1, 'alpha')]),
    });
    signIn();
    renderApp();

    expect((await screen.findByRole('alert')).textContent).toContain(
      REPOSITORY_MESSAGES.rateLimited,
    );
    limited = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'octo/alpha' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('disconnect', () => {
  function deferred() {
    let release!: (response: Response) => void;
    const promise = new Promise<Response>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it('clears the browser session immediately, then reports GitHub confirmation separately', async () => {
    const revoke = deferred();
    const net = network({ [`POST ${API}/auth/revoke`]: () => revoke.promise });
    signIn();
    renderApp();
    await screen.findByText('octo/alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    // Browser half is done right away, while GitHub has not answered.
    expect(await screen.findByText(SESSION_MESSAGES.clearedRevoking)).toBeTruthy();
    expect(loadToken()).toBeNull();
    expect(sessionStorage.length).toBe(0);
    expect(screen.queryByText('octo/alpha')).toBeNull();
    expect(screen.queryByText(SESSION_MESSAGES.revoked)).toBeNull();

    revoke.release(Response.json({ revoked: true }));
    expect(await screen.findByText(SESSION_MESSAGES.revoked)).toBeTruthy();
    expect(net.requests.find((r) => r.url.pathname === '/auth/revoke')?.body).toEqual({
      access_token: TEST_TOKEN,
    });
  });

  it('does NOT claim revocation when GitHub did not confirm it, but the browser is still cleared', async () => {
    network({
      [`POST ${API}/auth/revoke`]: () =>
        Response.json({ error: 'revocation_not_confirmed' }, { status: 502 }),
    });
    signIn();
    renderApp();
    await screen.findByText('octo/alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText(SESSION_MESSAGES.revokeNotConfirmed)).toBeTruthy();
    expect(screen.queryByText(SESSION_MESSAGES.revoked)).toBeNull();
    expect(screen.queryByText(/GitHub confirmed/)).toBeNull();
    expect(loadToken()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  it('does NOT claim revocation when the API is down', async () => {
    network({ [`POST ${API}/auth/revoke`]: () => Promise.reject(new TypeError('offline')) });
    signIn();
    renderApp();
    await screen.findByText('octo/alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    expect(await screen.findByText(SESSION_MESSAGES.revokeNotConfirmed)).toBeTruthy();
    expect(screen.queryByText(SESSION_MESSAGES.revoked)).toBeNull();
    expect(loadToken()).toBeNull();
  });

  it('can connect again after disconnecting', async () => {
    network({ [`POST ${API}/auth/revoke`]: () => Response.json({ revoked: true }) });
    signIn();
    renderApp();
    await screen.findByText('octo/alpha');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await screen.findByText(SESSION_MESSAGES.revoked);
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeTruthy();
  });
});
