import { describe, expect, it } from 'vitest';
import { parseOklch } from './color';
import { artKindFor, constellation, hills, illustrationPalette, inkContrast } from './illustration';

describe('empty-state illustration palette', () => {
  it('keeps the accent hue and caps chroma so a neon cover can’t shout', () => {
    const p = illustrationPalette([0.7, 0.32, 140], 'obsidian');
    const ink = parseOklch(p.ink)!;
    expect(Math.abs(ink[2] - 140)).toBeLessThan(6);
    expect(ink[1]).toBeLessThanOrEqual(0.16);
    const mid = parseOklch(p.mid)!;
    expect(Math.abs(((mid[2] - 140 + 540) % 360) - 180 - 26)).toBeLessThan(6); // mid is hue-shifted
  });

  it('falls back to brand violet without an accent', () => {
    expect(Math.abs(parseOklch(illustrationPalette(null).ink)![2] - 292)).toBeLessThan(6);
    expect(Math.abs(parseOklch(illustrationPalette([Number.NaN, 0.1, 10]).ink)![2] - 292)).toBeLessThan(6);
  });

  it('gives the ink ≥3:1 contrast on every theme’s panel, for dark, light and grey accents', () => {
    for (const accent of [[0.2, 0.1, 30], [0.95, 0.05, 90], [0.6, 0, 0], [0.7, 0.17, 292]] as [number, number, number][]) {
      for (const theme of ['obsidian', 'oled', 'light'] as const) expect(inkContrast(accent, theme)).toBeGreaterThanOrEqual(3);
    }
  });

  it('draws darker inks and pale fills on the light theme', () => {
    const dark = illustrationPalette([0.7, 0.15, 200], 'obsidian');
    const light = illustrationPalette([0.7, 0.15, 200], 'light');
    expect(parseOklch(light.ink)![0]).toBeLessThan(parseOklch(dark.ink)![0]);
    expect(parseOklch(light.faint)![0]).toBeGreaterThan(parseOklch(dark.faint)![0]);
  });

  it('is flat and solid in high contrast', () => {
    const p = illustrationPalette([0.7, 0.15, 200], 'contrast');
    expect(p.flat).toBe(true);
    expect(p.ink).toBe('oklch(1 0 0)');
  });
});

describe('illustration geometry', () => {
  it('is deterministic per seed and keeps the centre clear for the icon', () => {
    const a = constellation('No stars yet');
    expect(constellation('No stars yet')).toEqual(a);
    expect(constellation('Something else')).not.toEqual(a);
    for (const s of a.stars) expect(Math.hypot((s.x - 84) / 52, (s.y - 60) / 34)).toBeGreaterThanOrEqual(0.95);
    for (const [i, j] of a.links) expect(j).toBe((i + 1) % a.stars.length);
  });

  it('draws three closed hill layers inside the box', () => {
    const layers = hills('seed');
    expect(layers).toHaveLength(3);
    for (const d of layers) {
      expect(d.startsWith('M0 120')).toBe(true);
      expect(d.endsWith('Z')).toBe(true);
      for (const y of [...d.matchAll(/ (-?[\d.]+)(?= L| Z|$)/g)].map((m) => Number(m[1]))) expect(y).toBeGreaterThan(40);
    }
  });

  it('picks a calm kind from the title', () => {
    expect(artKindFor('Nothing here')).toBe(artKindFor('Nothing here'));
    expect(['constellation', 'hills', 'orbits', 'tide']).toContain(artKindFor('x'));
  });
});
