import { describe, expect, it } from 'vitest';
import { formatCount, formatDate, formatPercent } from './format.ts';

describe('formatDate', () => {
  it('formats a valid ISO date', () => {
    expect(formatDate('2026-10-27T10:00:00Z', { locale: 'en-US', timeZone: 'UTC' })).toBe(
      'Oct 27, 2026',
    );
  });

  it('returns null for missing or invalid input rather than a made-up date', () => {
    expect(formatDate(null)).toBeNull();
    expect(formatDate('not a date')).toBeNull();
  });
});

describe('formatCount / formatPercent', () => {
  it('groups thousands', () => {
    expect(formatCount(12345, 'en-US')).toBe('12,345');
  });

  it('shows a decimal only for small shares', () => {
    expect(formatPercent(33.333)).toBe('33%');
    expect(formatPercent(4.26)).toBe('4.3%');
    expect(formatPercent(0)).toBe('0%');
  });
});
