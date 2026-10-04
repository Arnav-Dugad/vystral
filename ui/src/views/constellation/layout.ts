import type { PlatformKey } from '../../bridge/types';

/**
 * Pure layout math for the Constellation: grouping games into clusters, arranging clusters on
 * a galaxy disc and stars inside each cluster. Deterministic (hash-seeded), no three.js, no
 * DOM — the renderer only consumes the typed arrays produced here.
 */

export type GroupBy = 'genre' | 'platform' | 'collection';

export interface StarInput {
  id: string;
  title: string;
  genres: readonly string[];
  platform: PlatformKey | null;
  collections: readonly string[];
  /** Tracked playtime, or imported store playtime when larger. */
  playSeconds: number;
  installed: boolean;
}

export interface Cluster {
  key: string;
  label: string;
  /** Star ids, most played first (then by title). */
  ids: string[];
}

export interface ClusterPlacement {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface GalaxyLayout {
  /** xyz per star, in `order`. */
  positions: Float32Array;
  /** Star ids in buffer order (cluster by cluster, each cluster in its `ids` order). */
  order: string[];
  /** Cluster index per star. */
  clusterOf: Uint16Array;
  /** Buffer index of each cluster's first star. */
  clusterStart: number[];
  centers: ClusterPlacement[];
  /** Radius of the whole disc (for camera framing). */
  extent: number;
}

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/** FNV-1a; stable across sessions so the sky never reshuffles. */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic value in [0, 1) for a string and salt. */
export function hashUnit(s: string, salt = 0): number {
  let h = hash32(s) ^ Math.imul(salt + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const UNGROUPED: Record<GroupBy, string> = {
  genre: 'No genre',
  platform: 'Unknown platform',
  collection: 'Not in a collection',
};

/**
 * Groups stars into clusters. Each game appears once, in its primary group (first genre,
 * primary platform, first collection). Clusters are ordered largest first; the "ungrouped"
 * cluster always goes last.
 */
export function clusterGames(
  stars: readonly StarInput[],
  by: GroupBy,
  labels: { platform?: (p: PlatformKey) => string; collection?: (id: string) => string | undefined } = {},
): Cluster[] {
  const map = new Map<string, Cluster>();
  const byId = new Map(stars.map((s) => [s.id, s]));
  for (const s of stars) {
    let key: string | null = null;
    let label = '';
    if (by === 'genre') {
      const g = s.genres.find((x) => x.trim().length > 0)?.trim();
      if (g) {
        key = `g:${g.toLowerCase()}`;
        label = g;
      }
    } else if (by === 'platform') {
      if (s.platform) {
        key = `p:${s.platform}`;
        label = labels.platform?.(s.platform) ?? s.platform;
      }
    } else {
      for (const c of s.collections) {
        const name = labels.collection ? labels.collection(c) : c;
        if (name) {
          key = `c:${c}`;
          label = name;
          break;
        }
      }
    }
    if (key == null) {
      key = '~none';
      label = UNGROUPED[by];
    }
    let cluster = map.get(key);
    if (!cluster) map.set(key, (cluster = { key, label, ids: [] }));
    cluster.ids.push(s.id);
  }
  const clusters = [...map.values()];
  for (const c of clusters) {
    c.ids.sort((a, b) => {
      const A = byId.get(a)!, B = byId.get(b)!;
      return B.playSeconds - A.playSeconds || A.title.localeCompare(B.title) || a.localeCompare(b);
    });
  }
  return clusters.sort((a, b) => {
    if (a.key === '~none') return 1;
    if (b.key === '~none') return -1;
    return b.ids.length - a.ids.length || a.label.localeCompare(b.label);
  });
}

/** Point size (in shader units) from playtime on a log scale; unplayed games stay visible. */
export function starSize(playSeconds: number): number {
  const hours = Math.max(0, Number.isFinite(playSeconds) ? playSeconds : 0) / 3600;
  return Math.min(30, 7 + 6.5 * Math.log10(1 + hours));
}

/** Visual radius of a cluster for a given number of stars. */
export function clusterRadius(count: number): number {
  return 1.6 + 0.85 * Math.sqrt(Math.max(1, count));
}

/**
 * Places cluster centres on a golden-angle spiral in the XZ plane, then relaxes overlaps so
 * neighbouring clusters keep a readable gap.
 */
export function placeClusters(counts: readonly number[], gap = 1.4): ClusterPlacement[] {
  const n = counts.length;
  // Sunflower packing weighted by area: each cluster's ring radius grows with the area of the
  // clusters placed before it, so large and tiny clusters share the disc without piling up.
  let area = 0;
  const placed: ClusterPlacement[] = counts.map((count, i) => {
    const radius = clusterRadius(count);
    const own = Math.PI * (radius + gap / 2) ** 2;
    const ring = n === 1 ? 0 : Math.sqrt((area + own / 2) / Math.PI) * 1.35 + (i === 0 ? 0 : radius * 0.5);
    area += own;
    const angle = i * GOLDEN + 0.4;
    return { x: Math.cos(angle) * ring, y: 0, z: Math.sin(angle) * ring, radius };
  });
  for (let iter = 0; iter < 120; iter++) {
    let moved = false;
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const A = placed[a], B = placed[b];
        let dx = B.x - A.x, dz = B.z - A.z;
        let d = Math.hypot(dx, dz);
        const min = A.radius + B.radius + gap;
        if (d >= min) continue;
        if (d < 1e-6) {
          dx = Math.cos(a + b);
          dz = Math.sin(a + b);
          d = 1;
        }
        const push = (min - d) / 2 + 1e-4;
        const ux = dx / d, uz = dz / d;
        // Larger clusters move less, so the dense core stays central.
        const wa = B.radius / (A.radius + B.radius), wb = 1 - wa;
        A.x -= ux * push * 2 * wa;
        A.z -= uz * push * 2 * wa;
        B.x += ux * push * 2 * wb;
        B.z += uz * push * 2 * wb;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // A gentle warp gives the disc depth without breaking the readable plane.
  for (let i = 0; i < n; i++) placed[i].y = Math.sin(i * 1.7) * 0.6;
  return placed;
}

export function layoutGalaxy(clusters: readonly Cluster[]): GalaxyLayout {
  const total = clusters.reduce((s, c) => s + c.ids.length, 0);
  const positions = new Float32Array(total * 3);
  const clusterOf = new Uint16Array(total);
  const order: string[] = new Array(total);
  const clusterStart: number[] = [];
  const centers = placeClusters(clusters.map((c) => c.ids.length));
  let k = 0;
  let extent = 1;
  clusters.forEach((cluster, ci) => {
    clusterStart.push(k);
    const c = centers[ci];
    const n = cluster.ids.length;
    const phase = hashUnit(cluster.key, 3) * Math.PI * 2;
    const spread = c.radius * 0.92;
    for (let j = 0; j < n; j++) {
      const id = cluster.ids[j];
      // Vogel sunflower: even density, most-played stars at the core.
      const t = Math.sqrt((j + 0.5) / n);
      const jitter = (hashUnit(id, 1) - 0.5) * 0.5;
      const r = spread * Math.min(1, t + jitter * (0.6 / Math.sqrt(n)));
      const a = j * GOLDEN + phase + (hashUnit(id, 2) - 0.5) * 0.4;
      const thickness = (1 - t * 0.7) * Math.min(1.2, 0.25 + c.radius * 0.12);
      positions[k * 3] = c.x + Math.cos(a) * r;
      positions[k * 3 + 1] = c.y + (hashUnit(id, 4) - 0.5) * thickness;
      positions[k * 3 + 2] = c.z + Math.sin(a) * r;
      clusterOf[k] = ci;
      order[k] = id;
      k++;
    }
    extent = Math.max(extent, Math.hypot(c.x, c.z) + c.radius);
  });
  return { positions, order, clusterOf, clusterStart, centers, extent };
}

/** Wrap-around index step (for keyboard/controller cycling). */
export function cycle(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return (((index + delta) % length) + length) % length;
}
