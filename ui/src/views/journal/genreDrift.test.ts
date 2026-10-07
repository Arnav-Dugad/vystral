import { describe, expect, it } from 'vitest';
import { areaPath, genreDrift, insideOutOrder, monotoneSegments, monthStarts, OTHER, streamLayout } from './genreDrift';
import type { JSession } from './stats';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
let seq = 0;
const s = (gameId: string, start: number, seconds: number): JSession => ({ id: `s${++seq}`, gameId, startMs: start, seconds, hasMetrics: false, source: 'tracked' });
const H = 3600;
const NOW = at(2026, 10, 7);

describe('genreDrift', () => {
  const genres: Record<string, string[]> = { rpg: ['RPG', 'Fantasy'], race: ['Racing'], none: [], dup: ['Puzzle', 'Puzzle ', 'puzzle'.toUpperCase()] };
  const of = (id: string) => genres[id];

  it('has twelve local months ending with this one', () => {
    const m = monthStarts(NOW, 12);
    expect(m).toHaveLength(12);
    expect(new Date(m[11]).getMonth()).toBe(9);
    expect(new Date(m[0]).getMonth()).toBe(10);
    expect(new Date(m[0]).getFullYear()).toBe(2025);
  });

  it('splits multi-genre hours equally so each hour counts once', () => {
    const d = genreDrift([s('rpg', at(2026, 10, 2), 4 * H), s('race', at(2026, 9, 10), 2 * H), s('none', at(2026, 9, 11), H)], of, NOW);
    const idx = (g: string) => d.genres.indexOf(g);
    expect(d.hours[idx('RPG')][11]).toBe(2);
    expect(d.hours[idx('Fantasy')][11]).toBe(2);
    expect(d.hours[idx('Racing')][10]).toBe(2);
    expect(d.totalHours).toBe(6);
    expect(d.untaggedHours).toBe(1);
    expect(d.monthTotals[11]).toBe(4);
  });

  it('splits sessions at midnight on the last day of a month', () => {
    const d = genreDrift([s('race', at(2026, 9, 30, 23), 2 * H)], of, NOW);
    expect(d.hours[0][10]).toBe(1);
    expect(d.hours[0][11]).toBe(1);
  });

  it('ignores sessions before the window and de-duplicates genre names', () => {
    const d = genreDrift([s('race', at(2024, 1, 1), 5 * H), s('dup', at(2026, 10, 1), 3 * H)], of, NOW);
    expect(d.genres).toEqual(['Puzzle']); // trimmed and case-insensitive duplicates merged; first spelling kept
    expect(d.totalHours).toBeCloseTo(3, 9);
  });

  it('folds genres past the sixth into Other, keeping the biggest', () => {
    const many: Record<string, string[]> = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`g${i}`, [`G${i}`]]));
    const list = Array.from({ length: 9 }, (_, i) => s(`g${i}`, at(2026, 10, 1), (i + 1) * H));
    const d = genreDrift(list, (id) => many[id], NOW);
    expect(d.genres).toEqual(['G8', 'G7', 'G6', 'G5', 'G4', OTHER]);
    expect(d.hours[5][11]).toBe(1 + 2 + 3 + 4);
    expect(d.totalHours).toBe(45);
  });
});

describe('streamLayout', () => {
  const series = [
    [1, 2, 3, 2, 1],
    [4, 3, 2, 1, 0],
    [0, 1, 2, 4, 6],
  ];

  it('stacks layers with thickness equal to the value and no gaps', () => {
    const { layers, min, max } = streamLayout(series);
    expect(layers).toHaveLength(3);
    for (const l of layers) l.upper.forEach((u, j) => expect(u - l.lower[j]).toBeCloseTo(series[l.key][j], 9));
    for (let i = 1; i < layers.length; i++) expect(layers[i].lower).toEqual(layers[i - 1].upper);
    // Centred on zero.
    expect(min + max).toBeCloseTo(0, 9);
    expect(max - min).toBeGreaterThanOrEqual(6);
  });

  it('keeps a constant series flat (wiggle baseline)', () => {
    const { layers } = streamLayout([[2, 2, 2], [3, 3, 3]], [0, 1]);
    expect(layers[0].lower[0]).toBeCloseTo(layers[0].lower[2], 9);
  });

  it('orders inside-out: earliest peaks in the middle', () => {
    // Peaks: s1 first, then s0, then s2. s1 goes to the (empty) bottom, the next two balance on top.
    expect(insideOutOrder(series)).toEqual([1, 0, 2]);
    expect(insideOutOrder([[5, 0, 0, 0], [0, 5, 0, 0], [0, 0, 5, 0], [0, 0, 0, 5]])).toEqual([2, 0, 1, 3]);
    expect(streamLayout([])).toEqual({ layers: [], min: 0, max: 0 });
  });

  it('draws monotone areas that pass through every point', () => {
    const d = monotoneSegments([0, 10, 20], [0, 5, 5]);
    expect(d.endsWith('20,5')).toBe(true);
    expect(d).toContain(' 10,5C');
    expect(areaPath([0, 10], [1, 2], [0, 0])).toMatch(/^M0,1C.*L10,0C.*Z$/);
  });
});
