import { describe, expect, it } from 'vitest';
import { cellPosition, FLIP_MAX_MS, FLIP_MIN_MS, flipDuration, planFlip, sameGeometry, sameOrder, visibleRange, type GridGeometry } from './flip';

const GRID: GridGeometry = { columns: 4, cellW: 180, rowH: 350, gap: 20 };
const ids = (n: number, prefix = 'g') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('FLIP bookkeeping', () => {
  it('computes cell positions from indices', () => {
    expect(cellPosition(0, GRID)).toEqual({ x: 0, y: 0 });
    expect(cellPosition(5, GRID)).toEqual({ x: 200, y: 350 });
  });

  it('finds the visible index range for a band', () => {
    expect(visibleRange(100, GRID, { top: 0, bottom: 700 })).toEqual([0, 7]);
    expect(visibleRange(100, GRID, { top: 400, bottom: 900 })).toEqual([4, 11]);
    expect(visibleRange(6, GRID, { top: 0, bottom: 2000 })).toEqual([0, 5]);
    expect(visibleRange(0, GRID, { top: 0, bottom: 700 })).toEqual([0, -1]);
  });

  it('glides cards visible before and after, by the difference in their cells', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const after = ['b', 'a', 'c', 'd', 'h', 'f', 'g', 'e'];
    const band = { top: 0, bottom: 700 };
    const plan = planFlip(before, after, GRID, GRID, band, band)!;
    expect(plan.enters).toEqual([]);
    expect(plan.leaves).toEqual([]);
    const byId = Object.fromEntries(plan.moves.map((m) => [m.id, m]));
    expect(byId.a).toEqual({ id: 'a', dx: -200, dy: 0 }); // was in column 0, now column 1
    expect(byId.b).toEqual({ id: 'b', dx: 200, dy: 0 });
    expect(byId.e).toEqual({ id: 'e', dx: -600, dy: 0 });
    expect(byId.h).toEqual({ id: 'h', dx: 600, dy: 0 });
    expect(byId.c).toBeUndefined(); // didn't move
  });

  it('fades in newcomers and cards arriving from off screen, and ghosts the ones that leave', () => {
    const before = ids(40);
    const after = ['new', ...before.slice(20), ...before.slice(0, 20)]; // g20… now on top
    const band = { top: 0, bottom: 700 }; // 2 rows = 8 cards
    const plan = planFlip(before, after, GRID, GRID, band, band)!;
    expect(plan.moves).toEqual([]);
    expect(plan.enters).toEqual(['new', 'g20', 'g21', 'g22', 'g23', 'g24', 'g25', 'g26']);
    expect(plan.leaves.map((l) => l.id)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']);
    expect(plan.leaves[5]).toEqual({ id: 'g5', x: 200, y: 350 });
  });

  it('only ever looks at the visible slice, so 5,000 games plan instantly', () => {
    const before = ids(5000);
    const after = [...before].reverse();
    const band = { top: 100_000, bottom: 101_000 };
    const t0 = performance.now();
    const plan = planFlip(before, after, GRID, GRID, band, band)!;
    expect(performance.now() - t0).toBeLessThan(50);
    expect(plan.moves.length + plan.enters.length).toBeLessThanOrEqual(16);
  });

  it('stays screen-relative when the scroll position moved', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'];
    const after = before;
    const plan = planFlip(before, after.slice(), GRID, GRID, { top: 350, bottom: 1050 }, { top: 0, bottom: 700 })!;
    // e was at row 1 (screen y 0); after the scroll jumped up it sits at screen y 350: it starts 350px higher.
    expect(plan.moves.find((m) => m.id === 'e')).toEqual({ id: 'e', dx: 0, dy: -350 });
  });

  it('refuses to glide across a geometry change, and fades only when too much would move', () => {
    expect(planFlip(['a'], ['a'], GRID, { ...GRID, columns: 5 }, { top: 0, bottom: 1 }, { top: 0, bottom: 1 })).toBeNull();
    const before = ids(200);
    const after = [...before].reverse();
    const tall = { top: 0, bottom: 350 * 30 };
    const plan = planFlip(before, after, GRID, GRID, tall, tall, 40)!;
    expect(plan.moves).toEqual([]);
    expect(plan.leaves).toEqual([]);
    expect(plan.enters.length).toBe(120);
  });

  it('keeps durations short and distance-aware', () => {
    expect(flipDuration(0, 0)).toBe(FLIP_MIN_MS);
    expect(flipDuration(200, 0)).toBeGreaterThan(FLIP_MIN_MS);
    expect(flipDuration(5000, 5000)).toBe(FLIP_MAX_MS);
  });

  it('compares orders and geometries cheaply', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a'], ['a', 'b'])).toBe(false);
    expect(sameGeometry(GRID, { ...GRID, cellW: 180.2 })).toBe(true);
    expect(sameGeometry(GRID, { ...GRID, rowH: 360 })).toBe(false);
  });
});
