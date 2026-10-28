import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { readVersion } from './version.js';

const config = loadConfig(process.env);
const app = createApp({
  allowedOrigins: config.allowedOrigins,
  version: readVersion(),
  auth: config.auth,
});

// Never print credentials. Only say whether sign-in is available.
console.log(
  config.auth
    ? 'auth: GitHub App credentials loaded; /auth/* is enabled'
    : 'auth: GitHub App credentials not set; /auth/* will answer 503 until configured',
);

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`gvu-api listening on http://${info.address}:${String(info.port)}`);
});

// Render stops services with SIGTERM; close cleanly.
function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down`);
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
