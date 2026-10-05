/**
 * "Last session" ghost: a faint replay of the most recent tracked session's frame rate (when it
 * was captured) or CPU/GPU load, drawn behind the game page hero. Pure helpers: choosing the
 * metric, downsampling to ~120 points (LTTB, gaps kept as gaps), normalising into a viewBox and
 * a smooth monotone path that never overshoots the data. Nothing is invented: too little data
 * means no ghost at all.
 */
import type { InsightSample, PerfSample, PerfSummary } from '../bridge/types';
import { downsampleSegments, splitSegments, type MaybePt, type Pt } from '../views/perf/series';
import { formatDuration } from './format';

export type GhostMetric = 'fps' | 'cpu' | 'gpu';

export interface GhostPoint {
  /** 0…1 across the session. */
  x: number;
  /** 0…1, 0 = top (high values), 1 = bottom. */
  y: number;
}

export interface Ghost {
  metric: GhostMetric;
  segments: GhostPoint[][];
  /** Where the line ends (the moment the session stopped). */
  end: GhostPoint;
}

/** Points kept after downsampling — plenty for a soft line across the hero. */
export const GHOST_POINTS = 120;
/** Fewer real samples than this isn't a line worth drawing. */
export const GHOST_MIN_SAMPLES = 8;

export function fpsSeries(samples: readonly InsightSample[]): MaybePt[] {
  return samples
    .filter((s) => Number.isFinite(s.t))
    .map((s) => ({ t: s.t, v: typeof s.fps === 'number' && Number.isFinite(s.fps) && s.fps > 0 ? s.fps : null }))
    .sort((a, b) => a.t - b.t);
}

export function loadSeries(samples: readonly PerfSample[], key: 'cpu' | 'gpu'): MaybePt[] {
  return samples
    .filter((s) => Number.isFinite(s.t))
    .map((s) => {
      const v = s[key];
      return { t: s.t, v: typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null };
    })
    .sort((a, b) => a.t - b.t);
}

const realCount = (pts: readonly MaybePt[]) => pts.reduce((n, p) => n + (p.v == null ? 0 : 1), 0);

/**
 * Normalises a series into a ghost. Utilisation uses a fixed 0–100 % scale; frame rate uses
 * 0…(peak × 1.15) so the line sits in the band rather than hugging the top.
 */
export function buildGhost(points: readonly MaybePt[], metric: GhostMetric, maxPoints = GHOST_POINTS): Ghost | null {
  if (realCount(points) < GHOST_MIN_SAMPLES) return null;
  const segments = downsampleSegments(splitSegments(points), maxPoints).filter((s) => s.length > 1);
  if (!segments.length) return null;
  const all = segments.flat();
  const t0 = all[0].t;
  const t1 = all[all.length - 1].t;
  if (!(t1 > t0)) return null;
  const peak = Math.max(...all.map((p) => p.v));
  const top = metric === 'fps' ? Math.max(1, peak * 1.15) : 100;
  const norm = (p: Pt): GhostPoint => ({ x: (p.t - t0) / (t1 - t0), y: 1 - Math.min(1, Math.max(0, p.v / top)) });
  const out = segments.map((s) => s.map(norm));
  const lastSeg = out[out.length - 1];
  return { metric, segments: out, end: lastSeg[lastSeg.length - 1] };
}

/** Picks what to draw: FPS when the session captured it, else CPU, else GPU. */
export function chooseGhost(input: { summary: PerfSummary | null; insight?: readonly InsightSample[] | null; samples?: readonly PerfSample[] | null }): Ghost | null {
  if (input.summary?.fpsAvg != null && input.insight?.length) {
    const g = buildGhost(fpsSeries(input.insight), 'fps');
    if (g) return g;
  }
  if (input.samples?.length) return buildGhost(loadSeries(input.samples, 'cpu'), 'cpu') ?? buildGhost(loadSeries(input.samples, 'gpu'), 'gpu');
  return null;
}

/** "Last session · 1h 12m · 98 FPS avg" / "· CPU 42% avg" / "· CPU". */
export function ghostCaption(durationSeconds: number, metric: GhostMetric, summary: PerfSummary | null): string {
  const parts = ['Last session', formatDuration(durationSeconds)];
  if (metric === 'fps') parts.push(summary?.fpsAvg != null ? `${Math.round(summary.fpsAvg)} FPS avg` : 'FPS');
  else {
    const avg = metric === 'cpu' ? summary?.cpuAvg : summary?.gpuAvg;
    parts.push(avg != null ? `${metric.toUpperCase()} ${Math.round(avg)}% avg` : metric.toUpperCase());
  }
  return parts.join(' · ');
}

const r = (n: number) => Math.round(n * 10) / 10;

/**
 * Smooth SVG path through the points (monotone cubic, Fritsch–Carlson): it bends like a drawn
 * line but never overshoots above a peak or below a dip, so the shape stays honest.
 */
export function smoothPath(points: readonly GhostPoint[], width: number, height: number): string {
  const n = points.length;
  if (n === 0) return '';
  const xs = points.map((p) => p.x * width);
  const ys = points.map((p) => p.y * height);
  if (n === 1) return `M${r(xs[0])},${r(ys[0])}`;
  if (n === 2) return `M${r(xs[0])},${r(ys[0])}L${r(xs[1])},${r(ys[1])}`;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(Math.max(1e-6, xs[i + 1] - xs[i]));
    m.push((ys[i + 1] - ys[i]) / dx[i]);
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  t.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${r(xs[0])},${r(ys[0])}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${r(xs[i] + h)},${r(ys[i] + t[i] * h)} ${r(xs[i + 1] - h)},${r(ys[i + 1] - t[i + 1] * h)} ${r(xs[i + 1])},${r(ys[i + 1])}`;
  }
  return d;
}

/** y (0…1) of the ghost at x (0…1), linearly interpolated; null inside a gap. */
export function ghostYAt(ghost: Ghost, x: number): number | null {
  for (const seg of ghost.segments) {
    if (x < seg[0].x || x > seg[seg.length - 1].x) continue;
    for (let i = 1; i < seg.length; i++) {
      if (x <= seg[i].x) {
        const a = seg[i - 1], b = seg[i];
        const f = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
        return a.y + (b.y - a.y) * f;
      }
    }
  }
  return null;
}
