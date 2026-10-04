import { describe, expect, it } from 'vitest';
import { clusterGames, clusterRadius, cycle, hashUnit, layoutGalaxy, placeClusters, starSize, type StarInput } from './layout';

const star = (id: string, extra: Partial<StarInput> = {}): StarInput => ({
  id,
  title: id,
  genres: [],
  platform: null,
  collections: [],
  playSeconds: 0,
  installed: true,
  ...extra,
});

describe('clusterGames', () => {
  const stars = [
    star('a', { genres: ['RPG', 'Fantasy'], platform: 'steam', playSeconds: 100 }),
    star('b', { genres: ['rpg'], platform: 'xbox', playSeconds: 5000, collections: ['c1'] }),
    star('c', { genres: ['Racing'], platform: 'steam', collections: ['gone', 'c2'] }),
    star('d', { genres: [], platform: null }),
  ];

  it('groups by primary genre case-insensitively, largest first, ungrouped last', () => {
    const clusters = clusterGames(stars, 'genre');
    expect(clusters.map((c) => c.label)).toEqual(['RPG', 'Racing', 'No genre']);
    // most played first
    expect(clusters[0].ids).toEqual(['b', 'a']);
  });

  it('groups by platform with readable labels', () => {
    const clusters = clusterGames(stars, 'platform', { platform: (p) => p.toUpperCase() });
    expect(clusters.map((c) => c.label)).toEqual(['STEAM', 'XBOX', 'Unknown platform']);
  });

  it('groups by first known collection', () => {
    const names: Record<string, string> = { c1: 'Favourites', c2: 'Couch' };
    const clusters = clusterGames(stars, 'collection', { collection: (id) => names[id] });
    expect(clusters.map((c) => c.label).sort()).toEqual(['Couch', 'Favourites', 'Not in a collection']);
    expect(clusters[clusters.length - 1].ids.sort()).toEqual(['a', 'd']);
  });

  it('places every game exactly once', () => {
    for (const by of ['genre', 'platform', 'collection'] as const) {
      const ids = clusterGames(stars, by).flatMap((c) => c.ids);
      expect(ids.sort()).toEqual(['a', 'b', 'c', 'd']);
    }
  });
});

describe('sizes and hashing', () => {
  it('scales star size logarithmically and monotonically', () => {
    expect(starSize(0)).toBeGreaterThan(0);
    expect(starSize(3600)).toBeGreaterThan(starSize(0));
    expect(starSize(360000)).toBeGreaterThan(starSize(3600));
    expect(starSize(1e12)).toBeLessThanOrEqual(30);
    expect(starSize(Number.NaN)).toBe(starSize(0));
  });

  it('hashUnit is deterministic and bounded', () => {
    expect(hashUnit('x', 1)).toBe(hashUnit('x', 1));
    expect(hashUnit('x', 1)).not.toBe(hashUnit('x', 2));
    for (let i = 0; i < 200; i++) {
      const v = hashUnit(`id-${i}`, i % 5);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('cycles indices in both directions', () => {
    expect(cycle(0, -1, 3)).toBe(2);
    expect(cycle(2, 1, 3)).toBe(0);
    expect(cycle(0, 1, 0)).toBe(-1);
  });
});

describe('galaxy layout', () => {
  it('separates clusters after relaxation', () => {
    const counts = [400, 300, 120, 90, 60, 40, 12, 5, 3, 1, 1, 1];
    const placed = placeClusters(counts);
    for (let a = 0; a < placed.length; a++)
      for (let b = a + 1; b < placed.length; b++) {
        const d = Math.hypot(placed[a].x - placed[b].x, placed[a].z - placed[b].z);
        expect(d).toBeGreaterThan(placed[a].radius + placed[b].radius);
      }
    expect(placed[0].radius).toBeCloseTo(clusterRadius(400));
  });

  it('produces finite, deterministic positions in cluster order', () => {
    const stars = Array.from({ length: 3000 }, (_, i) => star(`g${i}`, { genres: [`G${i % 13}`], playSeconds: (i * 977) % 50000 }));
    const clusters = clusterGames(stars, 'genre');
    const a = layoutGalaxy(clusters);
    const b = layoutGalaxy(clusters);
    expect(a.positions).toEqual(b.positions);
    expect(a.order).toHaveLength(3000);
    expect(a.positions.every(Number.isFinite)).toBe(true);
    expect(a.clusterStart).toHaveLength(clusters.length);
    // Every star lies within its cluster's radius (plus thickness tolerance).
    for (let k = 0; k < a.order.length; k++) {
      const c = a.centers[a.clusterOf[k]];
      const d = Math.hypot(a.positions[k * 3] - c.x, a.positions[k * 3 + 2] - c.z);
      expect(d).toBeLessThanOrEqual(c.radius + 1e-3);
    }
    expect(a.extent).toBeGreaterThan(0);
    expect(a.order[a.clusterStart[1]]).toBe(clusters[1].ids[0]);
  });

  it('handles an empty library', () => {
    const l = layoutGalaxy([]);
    expect(l.order).toEqual([]);
    expect(l.positions.length).toBe(0);
  });
});
