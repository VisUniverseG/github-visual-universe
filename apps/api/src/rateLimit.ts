import type { Context } from 'hono';

export const RATE_LIMIT_POLICIES = {
  token: { limit: 10, windowMs: 10 * 60 * 1000 },
  revoke: { limit: 20, windowMs: 10 * 60 * 1000 },
} as const;

export const FALLBACK_RATE_LIMIT_POLICIES = {
  token: { limit: 60, windowMs: 10 * 60 * 1000 },
  revoke: { limit: 120, windowMs: 10 * 60 * 1000 },
} as const;

export const MAX_RATE_LIMIT_ENTRIES = 1024;

export type ClientIdentityResolver = (context: Context) => string | null;

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  readonly expiresAt: number;
}

interface RateLimiterOptions {
  readonly limit: number;
  readonly fallbackLimit: number;
  readonly windowMs: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

/**
 * A bounded fixed-window limiter. A null identity uses the separate conservative fallback bucket;
 * it is not an additional limit on requests with a trusted identity.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly limit: number;
  private readonly fallbackLimit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      !Number.isInteger(options.fallbackLimit) ||
      options.fallbackLimit < 1 ||
      !Number.isInteger(options.windowMs) ||
      options.windowMs < 1
    ) {
      throw new Error('Rate-limit policy values must be positive integers');
    }
    this.limit = options.limit;
    this.fallbackLimit = options.fallbackLimit;
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? MAX_RATE_LIMIT_ENTRIES;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error('Rate-limit entry capacity must be a positive integer');
    }
  }

  get size(): number {
    return this.buckets.size;
  }

  tryAcquire(identity: string | null): RateLimitDecision {
    const now = this.now();
    this.removeExpired(now);
    const key = normalizeIdentity(identity) ?? 'fallback';
    const limit = key === 'fallback' ? this.fallbackLimit : this.limit;
    const existing = this.buckets.get(key);
    const bucket =
      existing === undefined || existing.expiresAt <= now
        ? { count: 0, expiresAt: now + this.windowMs }
        : existing;

    if (existing === undefined && this.buckets.size >= this.maxEntries) {
      return {
        allowed: false,
        retryAfterSeconds: retryAfter(this.nextExpiry(), now),
      };
    }

    if (bucket.count >= limit) {
      return { allowed: false, retryAfterSeconds: retryAfter(bucket.expiresAt, now) };
    }

    bucket.count += 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private removeExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
  }

  private nextExpiry(): number {
    let next = Number.POSITIVE_INFINITY;
    for (const bucket of this.buckets.values()) {
      next = Math.min(next, bucket.expiresAt);
    }
    return next;
  }
}

function normalizeIdentity(identity: string | null): string | null {
  if (identity === null || identity.length === 0 || identity.length > 256) return null;
  for (const character of identity) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return identity;
}

function retryAfter(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000));
}
