import { SERVICE_NAME, type HealthResponse } from '@gvu/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createAuthRoutes, type AuthLogReason } from './auth.js';
import type { AuthConfig } from './config.js';

export interface AppOptions {
  readonly allowedOrigins: readonly string[];
  readonly version: string;
  /** GitHub App credentials. Omit or pass `null` to run without auth (`/auth/*` answers 503). */
  readonly auth?: AuthConfig | null;
  /** Injectable for tests so no real GitHub request is ever made. */
  readonly fetchImpl?: typeof fetch;
  /** Receives fixed reason strings only. Never request or response content. */
  readonly log?: (reason: AuthLogReason) => void;
  readonly upstreamTimeoutMs?: number;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();
  const isAllowedOrigin = (origin: string): string | null =>
    options.allowedOrigins.includes(origin) ? origin : null;

  app.use(secureHeaders());

  // Exact-match allow-lists. Requests from other origins receive no CORS headers.
  // `/health` is read-only: only GET (and preflight) is permitted.
  app.use(
    '/health',
    cors({ origin: isAllowedOrigin, allowMethods: ['GET', 'OPTIONS'], maxAge: 600 }),
  );

  // The auth broker accepts JSON POSTs only, from the same exact origins, without credentials
  // or cookies.
  app.use(
    '/auth/*',
    cors({
      origin: isAllowedOrigin,
      allowMethods: ['POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
      maxAge: 600,
    }),
  );

  app.get('/health', (c) => {
    const body: HealthResponse = { status: 'ok', service: SERVICE_NAME, version: options.version };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  app.route(
    '/auth',
    createAuthRoutes({
      allowedOrigins: options.allowedOrigins,
      auth: options.auth ?? null,
      fetchImpl: options.fetchImpl ?? fetch,
      log: options.log ?? ((reason) => console.warn(`[auth] ${reason}`)),
      timeoutMs: options.upstreamTimeoutMs ?? 10_000,
    }),
  );

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Never leak internal error details to clients.
  app.onError((_err, c) => c.json({ error: 'internal_error' }, 500));

  return app;
}
