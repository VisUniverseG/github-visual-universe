import { describe, expect, it } from 'vitest';
import {
  EARLIEST_USABLE_TIME,
  MAX_DAILY_SPAN_DAYS,
  MAX_WEEKLY_SPAN_DAYS,
  buildTimeline,
  granularityFor,
  usableTime,
} from './timeline.ts';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0); // 2026-10-28T12:00:00Z (a Wednesday)
const at = (iso: string) => ({ date: iso });

describe('usableTime', () => {
  it('reads an ISO date', () => {
    expect(usableTime('2026-10-01T10:00:00Z', NOW)).toBe(Date.UTC(2026, 9, 1, 10));
  });

  it.each([
    ['missing', null],
    ['unreadable', 'last tuesday'],
    ['empty', ''],
    ['before Git existed', '2005-04-06T23:59:59Z'],
    ['the Unix epoch', '1970-01-01T00:00:00Z'],
    ['the day after tomorrow', '2026-10-30T00:00:00Z'],
    ['far in the future', '2099-01-01T00:00:00Z'],
  ])('rejects a date that is %s', (_label, value) => {
    expect(usableTime(value, NOW)).toBeNull();
  });

  it('accepts the first Git day and any moment up to the end of tomorrow (UTC)', () => {
    expect(usableTime(new Date(EARLIEST_USABLE_TIME).toISOString(), NOW)).toBe(
      EARLIEST_USABLE_TIME,
    );
    expect(usableTime('2026-10-29T23:59:59Z', NOW)).not.toBeNull();
  });
});

describe('granularityFor', () => {
  it('draws days for a short span, weeks for a medium one and months beyond', () => {
    expect(granularityFor(1)).toBe('day');
    expect(granularityFor(MAX_DAILY_SPAN_DAYS)).toBe('day');
    expect(granularityFor(MAX_DAILY_SPAN_DAYS + 1)).toBe('week');
    expect(granularityFor(MAX_WEEKLY_SPAN_DAYS)).toBe('week');
    expect(granularityFor(MAX_WEEKLY_SPAN_DAYS + 1)).toBe('month');
  });
});

describe('buildTimeline', () => {
  it('has nothing to draw for no commits', () => {
    expect(buildTimeline([], NOW)).toEqual({
      granularity: null,
      buckets: [],
      plotted: 0,
      unusable: 0,
      firstTime: null,
      lastTime: null,
      maxCount: 0,
    });
  });

  it('has nothing to draw, and counts every commit as unusable, when no date can be used', () => {
    const timeline = buildTimeline(
      [{ date: null }, at('garbage'), at('1999-01-01T00:00:00Z')],
      NOW,
    );
    expect(timeline.granularity).toBeNull();
    expect(timeline.buckets).toEqual([]);
    expect(timeline.plotted).toBe(0);
    expect(timeline.unusable).toBe(3);
  });

  it('draws a single commit as one day', () => {
    const timeline = buildTimeline([at('2026-10-01T10:00:00Z')], NOW);
    expect(timeline.granularity).toBe('day');
    expect(timeline.buckets).toEqual([
      { start: Date.UTC(2026, 9, 1), label: '2026-10-01', count: 1 },
    ]);
    expect(timeline.maxCount).toBe(1);
  });

  it('puts commits either side of midnight UTC into different days', () => {
    const timeline = buildTimeline(
      [at('2026-10-01T23:59:59Z'), at('2026-10-02T00:00:00Z'), at('2026-10-02T00:00:01Z')],
      NOW,
    );
    expect(timeline.buckets.map((b) => [b.label, b.count])).toEqual([
      ['2026-10-01', 1],
      ['2026-10-02', 2],
    ]);
  });

  it('puts a commit by its UTC date, whatever the offset it was written with', () => {
    // 23:30 on Oct 1 at UTC-05:00 is 04:30 on Oct 2 in UTC.
    const timeline = buildTimeline([at('2026-10-01T23:30:00-05:00')], NOW);
    expect(timeline.buckets.map((b) => b.label)).toEqual(['2026-10-02']);
  });

  it('fills the days between commits with empty buckets', () => {
    const timeline = buildTimeline([at('2026-10-01T10:00:00Z'), at('2026-10-04T10:00:00Z')], NOW);
    expect(timeline.buckets.map((b) => [b.label, b.count])).toEqual([
      ['2026-10-01', 1],
      ['2026-10-02', 0],
      ['2026-10-03', 0],
      ['2026-10-04', 1],
    ]);
  });

  it('does not depend on the order of the commits', () => {
    const a = buildTimeline([at('2026-10-04T10:00:00Z'), at('2026-10-01T10:00:00Z')], NOW);
    const b = buildTimeline([at('2026-10-01T10:00:00Z'), at('2026-10-04T10:00:00Z')], NOW);
    expect(a).toEqual(b);
  });

  it('leaves unusable commits off the timeline and counts them', () => {
    const timeline = buildTimeline(
      [
        at('2026-10-01T10:00:00Z'),
        { date: null },
        at('2099-01-01T00:00:00Z'),
        at('1970-01-01T00:00:00Z'),
      ],
      NOW,
    );
    expect(timeline.plotted).toBe(1);
    expect(timeline.unusable).toBe(3);
    expect(timeline.buckets).toHaveLength(1);
  });

  it('is not stretched by a commit with an absurd date', () => {
    const timeline = buildTimeline([at('2026-10-01T10:00:00Z'), at('2099-01-01T00:00:00Z')], NOW);
    expect(timeline.buckets).toHaveLength(1);
  });

  it('draws weeks that start on Monday once the span passes the daily limit', () => {
    // 2026-06-01 is a Monday; 2026-10-28 is 150 days later.
    const timeline = buildTimeline([at('2026-06-03T10:00:00Z'), at('2026-10-28T10:00:00Z')], NOW);
    expect(timeline.granularity).toBe('week');
    const first = timeline.buckets[0];
    const last = timeline.buckets[timeline.buckets.length - 1];
    expect(first?.label).toBe('2026-06-01');
    expect(last?.label).toBe('2026-10-26');
    expect(new Date(first?.start ?? 0).getUTCDay()).toBe(1);
    expect(timeline.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(2);
  });

  it('counts a Sunday in the week that began the Monday before', () => {
    const timeline = buildTimeline([at('2026-06-07T12:00:00Z'), at('2026-10-28T10:00:00Z')], NOW);
    expect(timeline.buckets[0]).toMatchObject({ label: '2026-06-01', count: 1 });
  });

  it('draws months for a span of several years', () => {
    const timeline = buildTimeline([at('2020-01-15T10:00:00Z'), at('2026-10-28T10:00:00Z')], NOW);
    expect(timeline.granularity).toBe('month');
    expect(timeline.buckets[0]).toMatchObject({ label: '2020-01', count: 1 });
    expect(timeline.buckets[timeline.buckets.length - 1]).toMatchObject({
      label: '2026-10',
      count: 1,
    });
    // 2020-01 through 2026-10 inclusive, with no month skipped across year ends.
    expect(timeline.buckets).toHaveLength(6 * 12 + 10);
    expect(new Set(timeline.buckets.map((b) => b.label)).size).toBe(timeline.buckets.length);
  });

  it('reports the highest bucket and the first and last commit times', () => {
    const timeline = buildTimeline(
      [at('2026-10-01T01:00:00Z'), at('2026-10-01T02:00:00Z'), at('2026-10-03T10:00:00Z')],
      NOW,
    );
    expect(timeline.maxCount).toBe(2);
    expect(timeline.firstTime).toBe(Date.UTC(2026, 9, 1, 1));
    expect(timeline.lastTime).toBe(Date.UTC(2026, 9, 3, 10));
  });

  it('never produces an unbounded number of buckets', () => {
    const timeline = buildTimeline([at('2005-04-07T00:00:00Z'), at('2026-10-29T12:00:00Z')], NOW);
    expect(timeline.granularity).toBe('month');
    expect(timeline.buckets.length).toBeLessThan(400);
  });
});
