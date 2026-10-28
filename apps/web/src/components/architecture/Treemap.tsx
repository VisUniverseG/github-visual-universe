import { useMemo } from 'react';
import { formatBytes, formatCount, lowerBound } from '../../dashboard/format.ts';
import type { TreeNode } from '../../architecture/store.ts';
import {
  isLowerBound,
  layoutChildren,
  metricValue,
  type Metric,
  type Tile,
} from '../../architecture/treemap.ts';

const WIDTH = 1000;
const HEIGHT = 520;
const PADDING = 8;
/** Rough width of one label character in drawing units (the label font is 13 units tall). */
const CHAR_WIDTH = 7.5;

interface Props {
  readonly directory: TreeNode;
  readonly metric: Metric;
  readonly onOpen: (id: number) => void;
}

function formatValue(tile: Tile<TreeNode>, metric: Metric): string {
  const { value } = tile;
  const text =
    metric === 'bytes'
      ? formatBytes(value)
      : `${formatCount(value)} ${value === 1 ? 'file' : 'files'}`;
  return lowerBound(text, !tile.lowerBound);
}

function fit(text: string, width: number): string {
  const room = Math.floor((width - PADDING * 2) / CHAR_WIDTH);
  if (room < 3) return '';
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`;
}

function tileLabel(tile: Tile<TreeNode>): string {
  if (tile.node === null) return `${formatCount(tile.restCount)} smaller items`;
  return tile.node.kind === 'directory' ? `${tile.node.name}/` : tile.node.name;
}

/**
 * Says why entries are not drawn, keeping three cases apart: folders whose size is not known yet
 * (not loaded, or listed with everything below still to load, so only a zero is known), files
 * GitHub reported no size for, and entries that have nothing to measure (an empty folder that is
 * completely listed, a zero-byte file, a submodule). None of these is drawn; only the last is
 * "zero".
 * `null` when everything is drawn.
 */
function undrawnReasons(
  children: readonly TreeNode[],
  metric: Metric,
  undrawn: number,
  unit: string,
): { readonly unknown: number; readonly text: string } | null {
  if (undrawn === 0) return null;
  // A folder is unknown, not empty, when it has not been listed or when what has been listed adds
  // up to zero but more may be below (a lower bound of zero). Only an exact zero is empty.
  const folders = children.filter(
    (node) =>
      node.kind === 'directory' && metricValue(node, metric) === 0 && isLowerBound(node, metric),
  ).length;
  const files =
    metric === 'bytes'
      ? children.filter(
          (node) => (node.kind === 'file' || node.kind === 'symlink') && node.bytes === null,
        ).length
      : 0;
  const nothing = undrawn - folders - files;

  const parts: string[] = [];
  if (folders > 0) {
    parts.push(
      `${formatCount(folders)} ${folders === 1 ? 'folder has' : 'folders have'} no known ${unit} yet`,
    );
  }
  if (files > 0) {
    parts.push(
      `${formatCount(files)} ${files === 1 ? 'file has' : 'files have'} no size from GitHub`,
    );
  }
  if (nothing > 0) {
    parts.push(
      `${formatCount(nothing)} ${nothing === 1 ? 'entry has' : 'entries have'} no ${unit} to measure`,
    );
  }
  return { unknown: folders + files, text: parts.join('. ') };
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

  const undrawn = undrawnReasons(directory.children, metric, layout.undrawn, unit);

  if (layout.tiles.length === 0) {
    // Unknown is not empty: say "yet" when something here simply has not been measured.
    return (
      <p className="note">
        {undrawn !== null && undrawn.unknown > 0
          ? `Nothing to draw here yet. ${undrawn.text}. See the table below.`
          : `Nothing to draw here: nothing in this folder has a ${unit} to measure. See the table below.`}
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
          const detail = h >= 44 ? fit(formatValue(tile, metric), w) : '';
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
              <title>{`${tileLabel(tile)}: ${formatValue(tile, metric)}`}</title>
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
      {undrawn !== null && (
        <p className="note">{undrawn.text}. They are not drawn; the table lists every entry.</p>
      )}
    </div>
  );
}
