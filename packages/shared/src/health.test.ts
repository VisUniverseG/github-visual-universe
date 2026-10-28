import { describe, expect, it } from 'vitest';
import { SERVICE_NAME, healthResponseSchema } from './index.js';

describe('healthResponseSchema', () => {
  it('accepts a valid health payload', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'ok',
      service: SERVICE_NAME,
      version: '0.0.0',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unexpected status', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'degraded',
      service: SERVICE_NAME,
      version: '0.0.0',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a payload from a different service', () => {
    const parsed = healthResponseSchema.safeParse({
      status: 'ok',
      service: 'something-else',
      version: '0.0.0',
    });
    expect(parsed.success).toBe(false);
  });
});
