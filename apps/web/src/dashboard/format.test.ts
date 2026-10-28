import { describe, expect, it } from 'vitest';
import { boundedFigure, formatBytes, formatCount, formatDate, formatPercent } from './format.ts';

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

describe('formatBytes', () => {
  it('uses decimal units and keeps whole bytes below 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1000)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(250_000)).toBe('250 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
    expect(formatBytes(3_200_000_000)).toBe('3.2 GB');
  });

  it('rolls over at the unit boundary instead of printing 1000 KB', () => {
    expect(formatBytes(999_999)).toBe('1 MB');
  });
});

describe('boundedFigure', () => {
  it('shows an exact figure as it is, an exact zero included', () => {
    expect(boundedFigure(1500, formatBytes, true)).toBe('1.5 KB');
    expect(boundedFigure(0, formatBytes, true)).toBe('0 B');
    expect(boundedFigure(0, formatCount, true)).toBe('0');
  });

  it('marks an inexact positive figure as a lower bound', () => {
    expect(boundedFigure(1500, formatBytes, false)).toBe('≥ 1.5 KB');
    expect(boundedFigure(1, formatCount, false)).toBe('≥ 1');
  });

  it('shows an inexact zero as unknown, never as "≥ 0"', () => {
    expect(boundedFigure(0, formatBytes, false)).toBe('—');
    expect(boundedFigure(0, formatCount, false)).toBe('—');
  });
});
