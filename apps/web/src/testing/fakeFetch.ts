import { vi } from 'vitest';

/**
 * Test-only fake network. Routes are keyed `METHOD scheme://host/path` (query string ignored).
 * Any request that matches no route is recorded and rejected, so a test can never reach a real
 * server by accident. Nothing here talks to GitHub.
 */

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: unknown;
  readonly init: RequestInit;
}

export type Handler = (request: RecordedRequest) => Response | Promise<Response>;

export function createFakeFetch(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];

  const fetchMock = vi.fn<typeof fetch>((input, init = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const request: RecordedRequest = {
      method: (init.method ?? 'GET').toUpperCase(),
      url,
      headers: new Headers(init.headers),
      body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
      init,
    };
    requests.push(request);

    const handler = routes[`${request.method} ${url.origin}${url.pathname}`];
    if (!handler) {
      return Promise.reject(
        new TypeError(`unexpected request: ${request.method} ${url.origin}${url.pathname}`),
      );
    }
    return Promise.resolve(handler(request));
  });

  return {
    fetch: fetchMock,
    requests,
    /** Requests whose URL starts with the given origin, e.g. `https://api.github.com`. */
    to: (origin: string) => requests.filter((request) => request.url.origin === origin),
  };
}

export const TEST_TOKEN = `ghu_${'t'.repeat(36)}`;
export const TEST_CODE = 'one-time-code-abc123';
export const TEST_VERIFIER = 'v'.repeat(43);

export function fakeRepo(
  id: number,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name,
    full_name: `octo/${name}`,
    private: false,
    description: null,
    html_url: `https://github.com/octo/${name}`,
    owner: { login: 'octo', id: 1, type: 'User' },
    node_id: 'ignored-extra-field',
    ...extra,
  };
}
