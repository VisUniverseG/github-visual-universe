import { SERVICE_NAME, type HealthResponse } from '@gvu/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';

export interface AppOptions {
  readonly allowedOrigins: readonly string[];
  readonly version: string;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.use(secureHeaders());

  // Exact-match allow-list. Requests from other origins receive no CORS headers.
  // Read-only for now: only GET (and preflight) is permitted.
  app.use(
    cors({
      origin: (origin) => (options.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  app.get('/health', (c) => {
    const body: HealthResponse = { status: 'ok', service: SERVICE_NAME, version: options.version };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  // Never leak internal error details to clients.
  app.onError((_err, c) => c.json({ error: 'internal_error' }, 500));

  return app;
}
