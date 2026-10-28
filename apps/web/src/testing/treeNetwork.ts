import { vi } from 'vitest';
import { createFakeFetch, type Handler } from './fakeFetch.ts';
import type { FixtureTree } from './treeFixtures.ts';

/** A fake GitHub tree API for one repository, answering with a fixture's direct listings. */

export const GH = 'https://api.github.com';
export const FAR_FUTURE_SECONDS = 2_000_000_000; // the year 2033

export const treeRoute = (owner: string, name: string, sha: string) =>
  `GET ${GH}/repos/${owner}/${name}/git/trees/${sha}`;

export const okResponse = (
  fixture: FixtureTree,
  path: string,
  headers: Record<string, string> = {},
) =>
  Response.json(
    { sha: fixture.shaOf(path), truncated: false, tree: fixture.listing(path).entries },
    {
      headers: {
        'x-ratelimit-remaining': '4000',
        'x-ratelimit-reset': String(FAR_FUTURE_SECONDS),
        ...headers,
      },
    },
  );

/** A route for every folder of the fixture, each answering with its own direct listing. */
export function routesFor(
  owner: string,
  name: string,
  fixture: FixtureTree,
  overrides: Record<string, Handler> = {},
): Record<string, Handler> {
  const routes: Record<string, Handler> = {};
  for (const path of fixture.directories()) {
    routes[treeRoute(owner, name, fixture.shaOf(path))] = () => okResponse(fixture, path);
  }
  return { ...routes, ...overrides };
}

/** Installs a fake `fetch` for the given repositories (the caller undoes it with `unstubAllGlobals`). */
export function stubNetwork(
  repositories: readonly { owner: string; name: string; fixture: FixtureTree }[],
  overrides: Record<string, Handler> = {},
) {
  const routes: Record<string, Handler> = {};
  for (const { owner, name, fixture } of repositories) {
    Object.assign(routes, routesFor(owner, name, fixture));
  }
  const net = createFakeFetch({ ...routes, ...overrides });
  vi.stubGlobal('fetch', net.fetch);
  return net;
}

/** A request that waits until `release()`, and fails if it is aborted first. */
export function gated(respond: () => Response) {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: Handler = async (request) => {
    const signal = request.init.signal;
    await Promise.race([
      opened,
      new Promise<void>((_resolve, reject) => {
        const abort = () => {
          reject(new DOMException('Aborted', 'AbortError'));
        };
        if (signal?.aborted === true) abort();
        else signal?.addEventListener('abort', abort, { once: true });
      }),
    ]);
    return respond();
  };
  return { handler, release: () => release() };
}
