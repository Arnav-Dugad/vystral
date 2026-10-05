import { describe, expect, it } from 'vitest';
import { neighbor, squarify, type TreemapItem } from './treemap';

const items = (values: number[]): TreemapItem<null>[] => values.map((value, i) => ({ id: `g${i}`, value, data: null }));
const area = (r: { w: number; h: number }) => r.w * r.h;

describe('squarify', () => {
  it('returns nothing for empty input or a degenerate rectangle', () => {
    expect(squarify([], 100, 100)).toEqual([]);
    expect(squarify(items([1, 2]), 0, 100)).toEqual([]);
    expect(squarify(items([0, -3, Number.NaN]), 100, 100)).toEqual([]);
  });

  it('gives a single item the whole rectangle', () => {
    const [r] = squarify(items([42]), 300, 200, 10, 20);
    expect(r).toMatchObject({ x: 10, y: 20, w: 300, h: 200 });
  });

  it('keeps areas proportional to values and covers the rectangle exactly', () => {
    const values = [60, 60, 40, 30, 20, 20, 10, 6, 4, 1];
    const out = squarify(items(values), 600, 400);
    const total = values.reduce((a, b) => a + b, 0);
    expect(out).toHaveLength(values.length);
    for (const r of out) {
      const v = values[Number(r.id.slice(1))];
      expect(area(r)).toBeCloseTo((v / total) * 600 * 400, 6);
    }
    expect(out.reduce((s, r) => s + area(r), 0)).toBeCloseTo(600 * 400, 6);
  });

  it('keeps every tile inside the bounds without overlaps', () => {
    const out = squarify(items([13, 8, 8, 5, 3, 3, 2, 1, 1, 1, 0.5]), 500, 300, 5, 7);
    for (const r of out) {
      expect(r.x).toBeGreaterThanOrEqual(5 - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(7 - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(505 + 1e-6);
      expect(r.y + r.h).toBeLessThanOrEqual(307 + 1e-6);
    }
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i], b = out[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        expect(ox > 1e-6 && oy > 1e-6).toBe(false);
      }
  });

  it('produces reasonably square tiles (the point of squarifying)', () => {
    const out = squarify(items([6, 6, 4, 3, 2, 2, 1]), 600, 400);
    const worst = Math.max(...out.map((r) => Math.max(r.w / r.h, r.h / r.w)));
    expect(worst).toBeLessThan(3);
  });

  it('orders tiles largest first and is deterministic for equal values', () => {
    const a = squarify(items([5, 9, 5]), 300, 300).map((r) => r.id);
    const b = squarify(items([5, 9, 5]), 300, 300).map((r) => r.id);
    expect(a).toEqual(['g1', 'g0', 'g2']);
    expect(b).toEqual(a);
  });

  it('matches the classic example from the paper', () => {
    // Values 6,6,4,3,2,2,1 in a 6x4 rectangle: first column holds the two 6s.
    const out = squarify(items([6, 6, 4, 3, 2, 2, 1]), 6, 4);
    expect(out[0]).toMatchObject({ x: 0, y: 0 });
    expect(out[0].w).toBeCloseTo(3);
    expect(out[0].h).toBeCloseTo(2);
    expect(out[1]).toMatchObject({ x: 0 });
    expect(out[1].y).toBeCloseTo(2);
  });
});

describe('neighbor', () => {
  // 2x2 grid plus a wide tile underneath.
  const grid = [
    { x: 0, y: 0, w: 50, h: 50 },
    { x: 50, y: 0, w: 50, h: 50 },
    { x: 0, y: 50, w: 50, h: 50 },
    { x: 50, y: 50, w: 50, h: 50 },
    { x: 0, y: 100, w: 100, h: 20 },
  ];

  it('moves in each direction', () => {
    expect(neighbor(grid, 0, 'right')).toBe(1);
    expect(neighbor(grid, 1, 'left')).toBe(0);
    expect(neighbor(grid, 0, 'down')).toBe(2);
    expect(neighbor(grid, 3, 'up')).toBe(1);
    expect(neighbor(grid, 3, 'down')).toBe(4);
    expect(neighbor(grid, 4, 'up')).toBe(2);
  });

  it('stays put at an edge', () => {
    expect(neighbor(grid, 0, 'left')).toBe(0);
    expect(neighbor(grid, 1, 'up')).toBe(1);
    expect(neighbor(grid, 4, 'down')).toBe(4);
  });

  it('works on a real treemap layout so every tile is reachable', () => {
    const out = squarify(items([30, 20, 15, 10, 8, 6, 5, 3, 2, 1]), 800, 400);
    const reached = new Set<number>([0]);
    const queue = [0];
    while (queue.length) {
      const i = queue.shift()!;
      for (const d of ['left', 'right', 'up', 'down'] as const) {
        const n = neighbor(out, i, d);
        if (!reached.has(n)) {
          reached.add(n);
          queue.push(n);
        }
      }
    }
    expect(reached.size).toBe(out.length);
  });

  it('returns the start index for an unknown tile', () => {
    expect(neighbor(grid, 99, 'left')).toBe(99);
  });
});
