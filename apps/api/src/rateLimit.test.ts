import { describe, expect, it } from 'vitest';
import {
  FALLBACK_RATE_LIMIT_POLICIES,
  MAX_RATE_LIMIT_ENTRIES,
  RATE_LIMIT_POLICIES,
  RateLimiter,
} from './rateLimit.js';

describe('RateLimiter', () => {
  it('allows the configured number of trusted requests and reports the reset time', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({
      ...RATE_LIMIT_POLICIES.token,
      fallbackLimit: 60,
      now: () => now,
    });

    for (let count = 0; count < RATE_LIMIT_POLICIES.token.limit; count += 1) {
      expect(limiter.tryAcquire('client-a')).toEqual({ allowed: true, retryAfterSeconds: 0 });
    }
    expect(limiter.tryAcquire('client-a')).toEqual({
      allowed: false,
      retryAfterSeconds: RATE_LIMIT_POLICIES.token.windowMs / 1000,
    });

    now += RATE_LIMIT_POLICIES.token.windowMs;
    expect(limiter.tryAcquire('client-a').allowed).toBe(true);
  });

  it('keeps trusted identities and the fallback bucket independent', () => {
    const limiter = new RateLimiter({
      ...RATE_LIMIT_POLICIES.token,
      fallbackLimit: FALLBACK_RATE_LIMIT_POLICIES.token.limit,
    });

    for (let count = 0; count < RATE_LIMIT_POLICIES.token.limit; count += 1) {
      limiter.tryAcquire('client-a');
    }
    expect(limiter.tryAcquire('client-b').allowed).toBe(true);
    expect(limiter.tryAcquire(null).allowed).toBe(true);
  });

  it('uses the fallback bucket for malformed identities', () => {
    const limiter = new RateLimiter({ ...RATE_LIMIT_POLICIES.token, fallbackLimit: 1 });
    expect(limiter.tryAcquire('\u0000bad').allowed).toBe(true);
    expect(limiter.tryAcquire('\u0000bad').allowed).toBe(false);
  });

  it('does not evict active buckets and rejects new identities at capacity', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({
      ...RATE_LIMIT_POLICIES.token,
      fallbackLimit: 60,
      maxEntries: 2,
      now: () => now,
    });

    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    expect(limiter.tryAcquire('c')).toEqual({
      allowed: false,
      retryAfterSeconds: RATE_LIMIT_POLICIES.token.windowMs / 1000,
    });
    expect(limiter.size).toBe(2);

    expect(limiter.tryAcquire('a').allowed).toBe(true);
    expect(limiter.size).toBe(2);

    now += RATE_LIMIT_POLICIES.token.windowMs;
    expect(limiter.tryAcquire('d').allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });

  it('keeps the fallback safe when all capacity is occupied', () => {
    const limiter = new RateLimiter({
      ...RATE_LIMIT_POLICIES.token,
      fallbackLimit: 60,
      maxEntries: 2,
    });

    limiter.tryAcquire('a');
    limiter.tryAcquire('b');
    expect(limiter.tryAcquire(null).allowed).toBe(false);
    expect(limiter.size).toBe(2);
  });

  it('never exceeds the configured capacity for concurrent attempts', async () => {
    const limiter = new RateLimiter({
      ...RATE_LIMIT_POLICIES.token,
      fallbackLimit: 60,
    });
    const decisions = await Promise.all(
      Array.from({ length: MAX_RATE_LIMIT_ENTRIES }, () =>
        Promise.resolve().then(() => limiter.tryAcquire('same-client')),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(
      RATE_LIMIT_POLICIES.token.limit,
    );
  });
});
