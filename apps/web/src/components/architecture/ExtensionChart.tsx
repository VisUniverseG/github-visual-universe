import { formatCount, formatPercent } from '../../dashboard/format.ts';
import type { ExtensionStat } from '../../architecture/model.ts';

/** Extensions beyond this many are folded into one "Other extensions" row. */
export const MAX_EXTENSION_ROWS = 8;

interface Props {
  readonly extensions: readonly ExtensionStat[];
  readonly totalFiles: number;
}

interface Row {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly muted: boolean;
}

function toRows(extensions: readonly ExtensionStat[]): Row[] {
  const named = extensions.filter((entry) => entry.extension !== null);
  const none = extensions.find((entry) => entry.extension === null);
  const folded = named.slice(MAX_EXTENSION_ROWS);

  const rows: Row[] = named.slice(0, MAX_EXTENSION_ROWS).map((entry) => ({
    key: `ext:${entry.extension ?? ''}`,
    label: `.${entry.extension ?? ''}`,
    count: entry.files,
    muted: false,
  }));
  if (folded.length > 0) {
    rows.push({
      key: 'other',
      label: `Other extensions (${String(folded.length)})`,
      count: folded.reduce((sum, entry) => sum + entry.files, 0),
      muted: true,
    });
  }
  if (none) rows.push({ key: 'none', label: 'No extension', count: none.files, muted: true });
  return rows;
}

/**
 * Files by extension: a count of files, not of lines or bytes, and a statement about file names
 * only (nothing is read from the files). Drawn with SVG attributes, like the language chart.
 */
export function ExtensionChart({ extensions, totalFiles }: Props) {
  const rows = toRows(extensions);
  if (rows.length === 0 || totalFiles === 0) return null;
  const max = Math.max(...rows.map((row) => row.count));

  return (
    <section aria-labelledby="extensions-heading" className="panel">
      <div className="panel-head">
        <h2 id="extensions-heading">File types</h2>
      </div>
      <p className="note">
        Files grouped by the extension in their name. Each file counts once. This is a file count,
        not lines of code.
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
              {formatCount(row.count)} · {formatPercent((row.count / totalFiles) * 100)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
