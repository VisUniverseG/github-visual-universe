import { useMemo } from 'react';
import { formatBytes, formatCount } from '../../dashboard/format.ts';
import type { ArchNode } from '../../architecture/model.ts';
import { layoutChildren, type Metric, type Tile } from '../../architecture/treemap.ts';

const WIDTH = 1000;
const HEIGHT = 520;
const PADDING = 8;
/** Rough width of one label character in drawing units (the label font is 13 units tall). */
const CHAR_WIDTH = 7.5;

interface Props {
  readonly directory: ArchNode;
  readonly metric: Metric;
  readonly onOpen: (id: number) => void;
}

function formatValue(value: number, metric: Metric): string {
  return metric === 'bytes'
    ? formatBytes(value)
    : `${formatCount(value)} ${value === 1 ? 'file' : 'files'}`;
}

function fit(text: string, width: number): string {
  const room = Math.floor((width - PADDING * 2) / CHAR_WIDTH);
  if (room < 3) return '';
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

function tileLabel(tile: Tile): string {
  if (tile.node === null) return `${formatCount(tile.restCount)} smaller items`;
  return tile.node.kind === 'directory' ? `${tile.node.name}/` : tile.node.name;
}

/**
 * Treemap of one directory's direct children, drawn with SVG attributes only (the CSP forbids
 * inline `style`, and no chart library is used). It is a visual summary: the table next to it
 * lists the same entries and is the keyboard and screen-reader route, so the drawing is exposed
 * as a single labelled image and folders can also be opened by clicking their tile.
 */
export function Treemap({ directory, metric, onOpen }: Props) {
  const layout = useMemo(
    () => layoutChildren(directory, metric, { x: 0, y: 0, w: WIDTH, h: HEIGHT }),
    [directory, metric],
  );
  const where = directory.path === '' ? 'the repository root' : directory.path;
  const unit = metric === 'bytes' ? 'size' : 'file count';

  if (layout.tiles.length === 0) {
    return (
      <p className="note">
        Nothing to draw here: nothing in this folder has a {unit} to measure. See the table below.
      </p>
    );
  }

  return (
    <div className="treemap">
      <svg
        className="treemap-svg"
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        aria-label={`Treemap of ${where}, tiles sized by ${unit}. The table below lists the same entries.`}
      >
        {layout.tiles.map((tile) => {
          const { x, y, w, h } = tile.rect;
          const openable = tile.node?.kind === 'directory';
          const kindClass = tile.node === null ? 'tile-rest' : openable ? 'tile-dir' : 'tile-file';
          const label = fit(tileLabel(tile), w);
          const detail = h >= 44 ? fit(formatValue(tile.value, metric), w) : '';
          return (
            <g
              key={tile.key}
              className={`tile ${kindClass}`}
              data-tile-id={tile.node?.id ?? 'rest'}
              onClick={
                openable && tile.node
                  ? () => {
                      onOpen(tile.node?.id ?? 0);
                    }
                  : undefined
              }
            >
              <title>{`${tileLabel(tile)}: ${formatValue(tile.value, metric)}`}</title>
              <rect x={x} y={y} width={w} height={h} className="tile-rect" />
              {label !== '' && h >= 24 && (
                <text x={x + PADDING} y={y + 18} className="tile-label">
                  {label}
                </text>
              )}
              {label !== '' && detail !== '' && (
                <text x={x + PADDING} y={y + 36} className="tile-detail">
                  {detail}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {layout.undrawn > 0 && (
        <p className="note">
          {formatCount(layout.undrawn)} {layout.undrawn === 1 ? 'entry has' : 'entries have'} no{' '}
          {unit} to measure and {layout.undrawn === 1 ? 'is' : 'are'} not drawn. The table lists{' '}
          {layout.undrawn === 1 ? 'it' : 'them'}.
        </p>
      )}
    </div>
  );
}
