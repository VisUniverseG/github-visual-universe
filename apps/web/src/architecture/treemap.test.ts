import { describe, expect, it } from 'vitest';
import { buildArchitecture } from './model.ts';
import { layoutChildren, metricValue, squarify, type Rect } from './treemap.ts';

const BOUNDS: Rect = { x: 0, y: 0, w: 1000, h: 500 };
const area = (r: Rect) => r.w * r.h;
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - 1e-6 &&
  b.x < a.x + a.w - 1e-6 &&
  a.y < b.y + b.h - 1e-6 &&
  b.y < a.y + a.h - 1e-6;

describe('squarify', () => {
  const values = [60, 30, 20, 10, 5, 5, 2, 1];

  it('fills the bounds exactly, with areas proportional to the values', () => {
    const rects = squarify(values, BOUNDS);
    const total = values.reduce((a, b) => a + b, 0);
    expect(rects).toHaveLength(values.length);
    expect(rects.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(area(BOUNDS), 3);
    rects.forEach((r, index) => {
      expect(area(r) / area(BOUNDS)).toBeCloseTo((values[index] ?? 0) / total, 6);
    });
  });

  it('keeps every rectangle inside the bounds and none overlapping', () => {
    const rects = squarify(values, BOUNDS);
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-1e-6);
      expect(r.y).toBeGreaterThanOrEqual(-1e-6);
      expect(r.x + r.w).toBeLessThanOrEqual(BOUNDS.w + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(BOUNDS.h + 1e-6);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        expect(overlaps(rects[i] as Rect, rects[j] as Rect)).toBe(false);
      }
    }
  });

  it('handles a single value and degenerate input', () => {
    expect(squarify([5], BOUNDS)).toEqual([{ x: 0, y: 0, w: 1000, h: 500 }]);
    expect(squarify([], BOUNDS)).toEqual([]);
    expect(squarify([0, 0], BOUNDS)).toEqual([]);
    expect(squarify([1], { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });

  it('keeps tiles reasonably square for even values', () => {
    const rects = squarify([1, 1, 1, 1], { x: 0, y: 0, w: 100, h: 100 });
    for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeLessThan(2.01);
  });
});

describe('layoutChildren', () => {
  const file = (path: string, size?: number) => ({
    path,
    type: 'blob' as const,
    mode: '100644',
    ...(size === undefined ? {} : { size }),
  });

  const model = buildArchitecture([
    file('big/a.ts', 900),
    file('big/b.ts', 100),
    file('small/c.ts', 50),
    file('top.md', 10),
    file('zero.txt', 0),
    { path: 'empty', type: 'tree' as const, mode: '040000' },
    { path: 'sub', type: 'commit' as const, mode: '160000' },
  ]);

  it('sizes tiles by bytes, biggest first, and reports what it cannot draw', () => {
    const layout = layoutChildren(model.root, 'bytes', BOUNDS);
    expect(layout.tiles.map((t) => t.node?.name)).toEqual(['big', 'small', 'top.md']);
    expect(layout.tiles.map((t) => t.value)).toEqual([1000, 50, 10]);
    // zero.txt (0 bytes), the empty directory and the submodule have nothing to measure.
    expect(layout.undrawn).toBe(3);
  });

  it('can size tiles by file count instead', () => {
    const layout = layoutChildren(model.root, 'files', BOUNDS);
    expect(layout.tiles.map((t) => [t.node?.name, t.value])).toEqual([
      ['big', 2],
      ['small', 1],
      ['top.md', 1],
      ['zero.txt', 1],
    ]);
  });

  it('merges the smallest entries into one "smaller items" tile beyond the cap', () => {
    const many = buildArchitecture(
      Array.from({ length: 10 }, (_unused, index) => file(`f${String(index)}.txt`, 10 + index)),
    );
    const layout = layoutChildren(many.root, 'bytes', BOUNDS, 4);
    expect(layout.tiles).toHaveLength(4);
    const rest = layout.tiles[3];
    expect(rest?.node).toBeNull();
    expect(rest?.restCount).toBe(7);
    const total = many.root.bytes ?? 0;
    expect(layout.tiles.reduce((sum, t) => sum + t.value, 0)).toBe(total);
  });

  it('returns no tiles for an empty directory', () => {
    const empty = model.nodes.find((n) => n.path === 'empty');
    expect(layoutChildren(empty ?? model.root, 'bytes', BOUNDS)).toEqual({ tiles: [], undrawn: 0 });
  });

  it('metricValue is zero for entries with no size or count', () => {
    const sub = model.nodes.find((n) => n.path === 'sub');
    expect(sub && metricValue(sub, 'bytes')).toBe(0);
    expect(sub && metricValue(sub, 'files')).toBe(0);
  });
});
