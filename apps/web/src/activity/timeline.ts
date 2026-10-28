/**
 * Groups commits into UTC buckets for the Activity timeline.
 *
 * A commit date is whatever the commit's author (or committer) wrote: Git lets anyone set any
 * date. A date is therefore only usable when it can be read and falls between the first Git
 * release and the end of tomorrow (UTC; the extra day absorbs clock skew). Anything else is
 * counted as unusable and left off the timeline, so one absurd date cannot stretch the axis. The
 * buckets cover only the commits that were loaded: they say nothing about older history.
 */

export const DAY_MS = 86_400_000;

/** Git's first release (2005-04-07). A commit cannot honestly be older than this. */
export const EARLIEST_USABLE_TIME = Date.UTC(2005, 3, 7);

/** Longest span (in days) drawn one bar per day, and one bar per week. */
export const MAX_DAILY_SPAN_DAYS = 120;
export const MAX_WEEKLY_SPAN_DAYS = 3 * 366;

export type Granularity = 'day' | 'week' | 'month';

export interface TimelineBucket {
  /** Epoch milliseconds of the bucket's first instant (UTC). */
  readonly start: number;
  /** `YYYY-MM-DD` (the first day of the bucket), or `YYYY-MM` for a month. */
  readonly label: string;
  readonly count: number;
}

export interface Timeline {
  /** `null` when no commit has a usable date, so there is nothing to draw. */
  readonly granularity: Granularity | null;
  /** Consecutive buckets from the earliest to the latest usable commit, empty ones included. */
  readonly buckets: readonly TimelineBucket[];
  /** Commits on the timeline. */
  readonly plotted: number;
  /** Commits left off because their date is missing, unreadable, too old or in the future. */
  readonly unusable: number;
  /** The earliest and latest usable commit times; `null` when none is usable. */
  readonly firstTime: number | null;
  readonly lastTime: number | null;
  /** The highest bucket count (0 when there is nothing to draw). */
  readonly maxCount: number;
}

function startOfUtcDay(time: number): number {
  return Math.floor(time / DAY_MS) * DAY_MS;
}

/**
 * The commit's time in epoch milliseconds, or `null` when it cannot be used: missing, unreadable,
 * before {@link EARLIEST_USABLE_TIME}, or after the end of tomorrow (UTC) relative to `now`.
 */
export function usableTime(iso: string | null, now: number): number | null {
  if (iso === null) return null;
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  if (time < EARLIEST_USABLE_TIME) return null;
  if (time >= startOfUtcDay(now) + 2 * DAY_MS) return null;
  return time;
}

export function granularityFor(spanDays: number): Granularity {
  if (spanDays <= MAX_DAILY_SPAN_DAYS) return 'day';
  if (spanDays <= MAX_WEEKLY_SPAN_DAYS) return 'week';
  return 'month';
}

/** The start of the UTC day, ISO week (Monday) or month that contains `time`. */
function bucketStart(time: number, granularity: Granularity): number {
  const day = startOfUtcDay(time);
  if (granularity === 'day') return day;
  if (granularity === 'week') {
    const sinceMonday = (new Date(day).getUTCDay() + 6) % 7;
    return day - sinceMonday * DAY_MS;
  }
  const date = new Date(day);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextBucketStart(start: number, granularity: Granularity): number {
  if (granularity === 'day') return start + DAY_MS;
  if (granularity === 'week') return start + 7 * DAY_MS;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function labelFor(start: number, granularity: Granularity): string {
  const iso = new Date(start).toISOString();
  return granularity === 'month' ? iso.slice(0, 7) : iso.slice(0, 10);
}

export function buildTimeline(
  commits: readonly { readonly date: string | null }[],
  now: number,
): Timeline {
  const times: number[] = [];
  for (const commit of commits) {
    const time = usableTime(commit.date, now);
    if (time !== null) times.push(time);
  }
  const unusable = commits.length - times.length;

  if (times.length === 0) {
    return {
      granularity: null,
      buckets: [],
      plotted: 0,
      unusable,
      firstTime: null,
      lastTime: null,
      maxCount: 0,
    };
  }

  const firstTime = Math.min(...times);
  const lastTime = Math.max(...times);
  const spanDays = (startOfUtcDay(lastTime) - startOfUtcDay(firstTime)) / DAY_MS + 1;
  const granularity = granularityFor(spanDays);

  const counts = new Map<number, number>();
  for (const time of times) {
    const start = bucketStart(time, granularity);
    counts.set(start, (counts.get(start) ?? 0) + 1);
  }

  const buckets: TimelineBucket[] = [];
  const last = bucketStart(lastTime, granularity);
  let maxCount = 0;
  for (
    let start = bucketStart(firstTime, granularity);
    start <= last;
    start = nextBucketStart(start, granularity)
  ) {
    const count = counts.get(start) ?? 0;
    if (count > maxCount) maxCount = count;
    buckets.push({ start, label: labelFor(start, granularity), count });
  }

  return {
    granularity,
    buckets,
    plotted: times.length,
    unusable,
    firstTime,
    lastTime,
    maxCount,
  };
}
