import { healthResponseSchema } from '@gvu/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const app = createApp({ allowedOrigins: ['http://localhost:5173'], version: '1.2.3' });

describe('GET /health', () => {
  it('returns a payload matching the shared contract', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const parsed = healthResponseSchema.parse(await res.json());
    expect(parsed.version).toBe('1.2.3');
  });

  it('sets security headers', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('CORS', () => {
  it('echoes an allowed origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });

  it('sends no CORS headers to a disallowed origin', async () => {
    const res = await app.request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('only advertises GET and OPTIONS on preflight', async () => {
    const res = await app.request('/health', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });
    const methods = res.headers.get('access-control-allow-methods') ?? '';
    expect(methods).toContain('GET');
    expect(methods).not.toContain('POST');
  });
});

describe('error handling', () => {
  it('returns a JSON 404 for unknown routes', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
