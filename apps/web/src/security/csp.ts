/**
 * Content-Security-Policy for the built site.
 *
 * The access token lives in sessionStorage, so any script that runs in our origin can read it.
 * The CSP is the main defence against that: no inline script, no third-party script, and network
 * access limited to our own API and api.github.com, so even a successful injection has nowhere
 * to send a token.
 *
 * It is delivered as a <meta> tag because GitHub Pages cannot set headers. It is injected at
 * build time only (see vite.config.ts): the dev server needs inline scripts for hot reload.
 * `frame-ancestors` is deliberately absent because browsers ignore it in a <meta> tag.
 */

export const GITHUB_API_ORIGIN = 'https://api.github.com';

export interface CspOptions {
  /** Origin (scheme + host + port, no path) of our own API. */
  readonly apiOrigin: string;
}

export function buildCsp({ apiOrigin }: CspOptions): string {
  const origin = new URL(apiOrigin).origin;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${origin} ${GITHUB_API_ORIGIN}`,
    "base-uri 'self'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}
