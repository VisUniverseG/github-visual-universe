import { formatCount, formatPercent } from '../../dashboard/format.ts';
import type { LanguageDistribution, LanguageEntry } from '../../dashboard/stats.ts';

/** Languages beyond this many are folded into one "Other languages" row. */
export const MAX_CHART_ROWS = 10;

interface Props {
  readonly distribution: LanguageDistribution;
  readonly complete: boolean;
}

interface Row {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly percent: number;
  readonly muted: boolean;
}

function toRows(entries: readonly LanguageEntry[]): Row[] {
  const named = entries.filter((entry) => entry.language !== null);
  const none = entries.find((entry) => entry.language === null);

  const shown = named.slice(0, MAX_CHART_ROWS);
  const folded = named.slice(MAX_CHART_ROWS);
  const rows: Row[] = shown.map((entry) => ({
    key: `lang:${entry.language ?? ''}`,
    label: entry.language ?? '',
    count: entry.count,
    percent: entry.percent,
    muted: false,
  }));
  if (folded.length > 0) {
    rows.push({
      key: 'other',
      label: `Other languages (${String(folded.length)})`,
      count: folded.reduce((sum, entry) => sum + entry.count, 0),
      percent: folded.reduce((sum, entry) => sum + entry.percent, 0),
      muted: true,
    });
  }
  if (none) {
    rows.push({
      key: 'none',
      label: 'No language detected',
      count: none.count,
      percent: none.percent,
      muted: true,
    });
  }
  return rows;
}

/**
 * Horizontal bar chart, drawn with SVG attributes (no inline `style`, which the CSP forbids and
 * no chart library). Bar length is relative to the largest row; the percentage is the share of
 * all loaded repositories.
 */
export function LanguageChart({ distribution, complete }: Props) {
  if (distribution.total === 0) return null;
  const rows = toRows(distribution.entries);
  const max = Math.max(...rows.map((row) => row.count));

  return (
    <section aria-labelledby="languages-heading" className="panel">
      <div className="panel-head">
        <h2 id="languages-heading">Languages</h2>
        {!complete && <span className="chip chip-warn">Partial</span>}
      </div>
      <p className="note">
        Repositories by GitHub&rsquo;s primary language. Each repository counts once, under one
        language. This is a repository count, not lines of code.
      </p>
      <ul className="lang-list">
        {rows.map((row) => (
          <li key={row.key} className="lang-row">
            <span className="lang-name">{row.label}</span>
            <svg
              className="lang-bar"
              viewBox="0 0 100 10"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              <rect className="lang-track" x="0" y="0" width="100" height="10" />
              <rect
                className={row.muted ? 'lang-fill lang-fill-muted' : 'lang-fill'}
                x="0"
                y="0"
                width={(row.count / max) * 100}
                height="10"
              />
            </svg>
            <span className="lang-value">
              {formatCount(row.count)} · {formatPercent(row.percent)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
