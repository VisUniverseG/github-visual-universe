import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_TOKEN, createFakeFetch } from '../testing/fakeFetch.ts';
import { loadViewerLogin } from './viewer.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadViewerLogin', () => {
  it('reads only the login from GET /user, using a read-only GET', async () => {
    const net = createFakeFetch({
      'GET https://api.github.com/user': () =>
        Response.json({ login: 'octo', email: 'private@example.com', id: 1 }),
    });
    vi.stubGlobal('fetch', net.fetch);

    await expect(loadViewerLogin(TEST_TOKEN)).resolves.toBe('octo');
    expect(net.requests).toHaveLength(1);
    expect(net.requests[0]?.method).toBe('GET');
    expect(net.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('rejects a malformed response and propagates API errors', async () => {
    vi.stubGlobal(
      'fetch',
      createFakeFetch({ 'GET https://api.github.com/user': () => Response.json({ nope: 1 }) })
        .fetch,
    );
    await expect(loadViewerLogin(TEST_TOKEN)).rejects.toMatchObject({ kind: 'invalid_response' });

    vi.stubGlobal(
      'fetch',
      createFakeFetch({
        'GET https://api.github.com/user': () => new Response('{}', { status: 401 }),
      }).fetch,
    );
    await expect(loadViewerLogin(TEST_TOKEN)).rejects.toMatchObject({ kind: 'unauthorized' });
  });
});
