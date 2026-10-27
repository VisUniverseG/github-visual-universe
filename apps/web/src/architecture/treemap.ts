import type { ArchNode } from './model.ts';

/**
 * Squarified treemap layout (Bruls, Huizing and van Wijk, 2000), written out here so no chart
 * library is needed. Pure geometry: it takes values and a rectangle and returns rectangles.
 */

export type Metric = 'bytes' | 'files';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Tile {
  readonly key: string;
  /** The directory entry this tile stands for; `null` for the "smaller items" tile. */
  readonly node: ArchNode | null;
  readonly value: number;
  readonly rect: Rect;
  /** For the "smaller items" tile: how many items it stands for. `0` otherwise. */
  readonly restCount: number;
}

export interface TreemapLayout {
  readonly tiles: readonly Tile[];
  /** Entries with nothing to measure (empty directories, zero-byte files…): not drawn. */
  readonly undrawn: number;
}

/** The size of one entry under a metric. Entries with no measurable size return `0`. */
export function metricValue(node: ArchNode, metric: Metric): number {
  if (metric === 'bytes') return node.bytes ?? 0;
  if (node.kind === 'directory') return node.fileCount;
  return node.kind === 'file' || node.kind === 'symlink' ? 1 : 0;
}

/**
 * Lays out values (all greater than zero, already sorted descending) inside `bounds`, one
 * rectangle per value, in the same order. The areas are proportional to the values and together
 * fill `bounds`.
 */
export function squarify(values: readonly number[], bounds: Rect): Rect[] {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.length === 0 || total <= 0 || bounds.w <= 0 || bounds.h <= 0) return [];

  const scale = (bounds.w * bounds.h) / total;
  const areas = values.map((value) => value * scale);
  const rects: Rect[] = [];

  let { x, y, w, h } = bounds;
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(w, h);
    const worst = (sum: number, min: number, max: number) =>
      Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));

    // Grow the row while it keeps the worst aspect ratio from getting worse.
    let end = start + 1;
    let sum = areas[start] ?? 0;
    let min = sum;
    let max = sum;
    let current = worst(sum, min, max);
    while (end < areas.length) {
      const next = areas[end] ?? 0;
      const candidate = worst(sum + next, Math.min(min, next), Math.max(max, next));
      if (candidate > current) break;
      sum += next;
      min = Math.min(min, next);
      max = Math.max(max, next);
      current = candidate;
      end += 1;
    }

    if (w >= h) {
      // A column on the left edge.
      const columnWidth = sum / h;
      let top = y;
      for (let index = start; index < end; index += 1) {
        const height = (areas[index] ?? 0) / columnWidth;
        rects.push({ x, y: top, w: columnWidth, h: height });
        top += height;
      }
      x += columnWidth;
      w -= columnWidth;
    } else {
      // A row along the top edge.
      const rowHeight = sum / w;
      let left = x;
      for (let index = start; index < end; index += 1) {
        const width = (areas[index] ?? 0) / rowHeight;
        rects.push({ x: left, y, w: width, h: rowHeight });
        left += width;
      }
      y += rowHeight;
      h -= rowHeight;
    }
    start = end;
  }
  return rects;
}

/** At most this many tiles are drawn; the rest are merged into one "smaller items" tile. */
export const MAX_TILES = 40;

/** Lays out the direct children of a directory. */
export function layoutChildren(
  directory: ArchNode,
  metric: Metric,
  bounds: Rect,
  maxTiles: number = MAX_TILES,
): TreemapLayout {
  const measured = directory.children
    .map((node) => ({ node, value: metricValue(node, metric) }))
    .filter((item) => item.value > 0)
    // Biggest first; ties keep the (already sorted) directory order.
    .sort((a, b) => b.value - a.value);
  const undrawn = directory.children.length - measured.length;

  const shown = measured.length > maxTiles ? measured.slice(0, maxTiles - 1) : measured;
  const rest = measured.length > maxTiles ? measured.slice(maxTiles - 1) : [];

  const values = shown.map((item) => item.value);
  const restValue = rest.reduce((sum, item) => sum + item.value, 0);
  if (rest.length > 0) values.push(restValue);

  const rects = squarify(values, bounds);
  const tiles: Tile[] = [];
  shown.forEach((item, index) => {
    const rect = rects[index];
    if (rect) {
      tiles.push({
        key: `node:${String(item.node.id)}`,
        node: item.node,
        value: item.value,
        rect,
        restCount: 0,
      });
    }
  });
  const restRect = rects[shown.length];
  if (rest.length > 0 && restRect) {
    tiles.push({
      key: 'rest',
      node: null,
      value: restValue,
      rect: restRect,
      restCount: rest.length,
    });
  }
  return { tiles, undrawn };
}
