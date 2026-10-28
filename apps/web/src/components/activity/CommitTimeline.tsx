import type { Granularity, Timeline } from '../../activity/timeline.ts';
import { formatCount } from '../../dashboard/format.ts';

const WIDTH = 1000;
const HEIGHT = 220;
const LEFT = 44;
const RIGHT = 8;
const TOP = 12;
const BOTTOM = 34;

const UNIT: Record<Granularity, string> = { day: 'day', week: 'week', month: 'month' };

function bucketTitle(granularity: Granularity, label: string, count: number): string {
  const when = granularity === 'week' ? `Week starting ${label}` : label;
  return `${when} (UTC): ${formatCount(count)} ${count === 1 ? 'commit' : 'commits'}`;
}

interface Props {
  readonly timeline: Timeline;
}

/**
 * Commits per UTC day, week or month, drawn with SVG attributes only (the CSP forbids inline
 * `style`, and no chart library is used). It is a visual summary of the commits that were
 * **loaded**: the commit table lists the same commits and is the keyboard and screen-reader
 * route, so the drawing is exposed as a single labelled image.
 */
export function CommitTimeline({ timeline }: Props) {
  const { granularity, buckets, maxCount } = timeline;
  const first = buckets[0];
  const last = buckets[buckets.length - 1];
  if (granularity === null || first === undefined || last === undefined) return null;

  const unit = UNIT[granularity];
  const plotWidth = WIDTH - LEFT - RIGHT;
  const plotHeight = HEIGHT - TOP - BOTTOM;
  const baseline = TOP + plotHeight;
  const slot = plotWidth / buckets.length;
  const barWidth = Math.max(slot - 1, slot * 0.6);

  return (
    <svg
      className="timeline-svg"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      role="img"
      aria-label={`Bar chart of commits per ${unit}, in UTC, from ${first.label} to ${last.label}. The most in one ${unit} is ${formatCount(maxCount)}. It shows only the commits that have been loaded. The table below lists them.`}
    >
      <line className="timeline-axis" x1={LEFT} y1={baseline} x2={WIDTH - RIGHT} y2={baseline} />
      <text className="timeline-text" x={LEFT - 6} y={TOP + 10} textAnchor="end">
        {formatCount(maxCount)}
      </text>
      <text className="timeline-text" x={LEFT - 6} y={baseline} textAnchor="end">
        0
      </text>
      {buckets.map((bucket, index) => {
        if (bucket.count === 0) return null;
        const height = (bucket.count / maxCount) * plotHeight;
        return (
          <rect
            key={bucket.start}
            className="timeline-bar"
            x={LEFT + index * slot}
            y={baseline - height}
            width={barWidth}
            height={height}
          >
            <title>{bucketTitle(granularity, bucket.label, bucket.count)}</title>
          </rect>
        );
      })}
      <text className="timeline-text" x={LEFT} y={HEIGHT - 10} textAnchor="start">
        {first.label}
      </text>
      <text className="timeline-text" x={WIDTH - RIGHT} y={HEIGHT - 10} textAnchor="end">
        {last.label}
      </text>
    </svg>
  );
}
