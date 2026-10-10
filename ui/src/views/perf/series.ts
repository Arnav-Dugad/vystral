/**
 * Pure helpers for the Performance Intelligence Centre: parsing stored summaries, turning
 * samples into chart series, downsampling (LTTB), axis ticks and comparison deltas.
 * Nothing here invents data: missing values stay missing (null) all the way to the UI.
 */
import type { PerfSample, PerfSummary } from '../../bridge/types';
import { formatClock } from '../../lib/format';

export type MetricKey = 'cpu' | 'gpu' | 'gpuTempC' | 'gpuMemMb' | 'ramMb';
type SummaryNumberKey =
  | 'cpuAvg' | 'cpuMax' | 'gpuAvg' | 'gpuMax' | 'gpuMemAvgMb' | 'gpuMemMaxMb' | 'ramAvgMb' | 'ramMaxMb' | 'gpuTempAvgC' | 'gpuTempMaxC';

export interface MetricDef {
  key: MetricKey;
  label: string;
  /** Compact label for tiles. */
  short: string;
  unit: '%' | '°C' | 'GB';
  /** Multiplier from the stored unit to the displayed unit (MB → GB). */
  scale: number;
  avgKey: SummaryNumberKey;
  maxKey: SummaryNumberKey;
  kind: 'percent' | 'temp' | 'memory';
  color: string;
  /** Shown instead of a value when the metric wasn't recorded. */
  unavailable: string;
  /** A few words for compact places (tiles). */
  unavailableShort: string;
}

export const METRICS: readonly MetricDef[] = [
  {
    key: 'cpu', label: 'CPU usage', short: 'CPU', unit: '%', scale: 1, avgKey: 'cpuAvg', maxKey: 'cpuMax', kind: 'percent', color: 'var(--viz-1)',
    unavailable: 'CPU usage wasn’t recorded for this session.', unavailableShort: 'Not recorded',
  },
  {
    key: 'gpu', label: 'GPU usage', short: 'GPU', unit: '%', scale: 1, avgKey: 'gpuAvg', maxKey: 'gpuMax', kind: 'percent', color: 'var(--viz-2)',
    unavailable: 'GPU usage wasn’t available. It needs a graphics driver that exposes Windows GPU performance counters.', unavailableShort: 'Not reported by the driver',
  },
  {
    key: 'gpuTempC', label: 'GPU temperature', short: 'GPU temp', unit: '°C', scale: 1, avgKey: 'gpuTempAvgC', maxKey: 'gpuTempMaxC', kind: 'temp', color: 'var(--viz-3)',
    unavailable: 'GPU temperature needs an NVIDIA graphics card and driver. Other GPUs don’t report it to VYSTRAL.', unavailableShort: 'Needs an NVIDIA driver',
  },
  {
    key: 'gpuMemMb', label: 'VRAM', short: 'VRAM', unit: 'GB', scale: 1 / 1024, avgKey: 'gpuMemAvgMb', maxKey: 'gpuMemMaxMb', kind: 'memory', color: 'var(--viz-4)',
    unavailable: 'Dedicated GPU memory wasn’t reported for this session.', unavailableShort: 'Not reported',
  },
  {
    key: 'ramMb', label: 'System memory', short: 'RAM', unit: 'GB', scale: 1 / 1024, avgKey: 'ramAvgMb', maxKey: 'ramMaxMb', kind: 'memory', color: 'var(--viz-5)',
    unavailable: 'System memory use wasn’t recorded for this session.', unavailableShort: 'Not recorded',
  },
];

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Parses Session.perfSummary. Returns null for missing or malformed JSON. */
export function parsePerfSummary(json: string | null | undefined): PerfSummary | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    samples: num(o.samples) ?? 0,
    cpuAvg: num(o.cpuAvg),
    cpuMax: num(o.cpuMax),
    gpuAvg: num(o.gpuAvg),
    gpuMax: num(o.gpuMax),
    gpuMemAvgMb: num(o.gpuMemAvgMb),
    gpuMemMaxMb: num(o.gpuMemMaxMb),
    ramAvgMb: num(o.ramAvgMb),
    ramMaxMb: num(o.ramMaxMb),
    gpuTempAvgC: num(o.gpuTempAvgC),
    gpuTempMaxC: num(o.gpuTempMaxC),
    fpsStatus: typeof o.fpsStatus === 'string' && o.fpsStatus.trim() ? o.fpsStatus : 'FPS is not recorded.',
    // Schema v4 (throttling, frame rate). Absent in older sessions.
    throttledSeconds: num(o.throttledSeconds),
    powerLimitedSeconds: num(o.powerLimitedSeconds),
    throttleReasons: Array.isArray(o.throttleReasons) ? o.throttleReasons.filter((r): r is 'thermal' | 'power' => r === 'thermal' || r === 'power') : null,
    peakTempC: num(o.peakTempC),
    gpuClockAvgMhz: num(o.gpuClockAvgMhz),
    thermalNote: typeof o.thermalNote === 'string' && o.thermalNote.trim() ? o.thermalNote : null,
    fpsAvg: num(o.fpsAvg),
    fps1Low: num(o.fps1Low),
    fps01Low: num(o.fps01Low),
    frameTimeP50Ms: num(o.frameTimeP50Ms),
    frameTimeP99Ms: num(o.frameTimeP99Ms),
    stutterCount: num(o.stutterCount),
    frameCount: num(o.frameCount),
    frameTimeHistogram: Array.isArray(o.frameTimeHistogram) && o.frameTimeHistogram.every((x) => typeof x === 'number') ? (o.frameTimeHistogram as number[]) : null,
    fpsSource: typeof o.fpsSource === 'string' ? o.fpsSource : null,
  };
}

/** Summary value in display units, or null. */
export function summaryValue(summary: PerfSummary | null, metric: MetricDef, which: 'avg' | 'max'): number | null {
  if (!summary) return null;
  const v = summary[which === 'avg' ? metric.avgKey : metric.maxKey];
  return v == null ? null : v * metric.scale;
}

/* ---------------------------------------------------------------- series */

export interface Pt {
  t: number;
  v: number;
}

export interface MaybePt {
  t: number;
  v: number | null;
}

export function extractSeries(samples: readonly PerfSample[], key: MetricKey, scale = 1): MaybePt[] {
  const out: MaybePt[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.t)) continue;
    const v = s[key];
    out.push({ t: s.t, v: typeof v === 'number' && Number.isFinite(v) ? v * scale : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Splits a series into drawable runs. A run breaks at a missing value, or where the gap
 * between samples is much larger than usual (collection paused) — the chart never draws a
 * line across time it has no data for.
 */
export function splitSegments(points: readonly MaybePt[], gapMs?: number): Pt[][] {
  const dts: number[] = [];
  for (let i = 1; i < points.length; i++) dts.push(points[i].t - points[i - 1].t);
  const limit = gapMs ?? Math.max(10_000, median(dts) * 5);
  const segments: Pt[][] = [];
  let current: Pt[] = [];
  let prevT: number | null = null;
  for (const p of points) {
    if (p.v == null) {
      if (current.length) segments.push(current);
      current = [];
      prevT = null;
      continue;
    }
    if (prevT != null && p.t - prevT > limit && current.length) {
      segments.push(current);
      current = [];
    }
    current.push({ t: p.t, v: p.v });
    prevT = p.t;
  }
  if (current.length) segments.push(current);
  return segments;
}

/** Largest-Triangle-Three-Buckets: keeps the visual shape (peaks and dips) with fewer points. */
export function lttb(points: readonly Pt[], threshold: number): Pt[] {
  const n = points.length;
  if (threshold >= n || threshold < 3) return points.slice();
  const out: Pt[] = [points[0]];
  const every = (n - 2) / (threshold - 2);
  let a = 0;
  for (let i = 0; i < threshold - 2; i++) {
    const avgStart = Math.floor((i + 1) * every) + 1;
    const avgEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgT = 0;
    let avgV = 0;
    const len = Math.max(1, avgEnd - avgStart);
    for (let j = avgStart; j < avgEnd; j++) {
      avgT += points[j].t;
      avgV += points[j].v;
    }
    avgT /= len;
    avgV /= len;
    const rangeStart = Math.floor(i * every) + 1;
    const rangeEnd = Math.floor((i + 1) * every) + 1;
    const pa = points[a];
    let maxArea = -1;
    let next = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const area = Math.abs((pa.t - avgT) * (points[j].v - pa.v) - (pa.t - points[j].t) * (avgV - pa.v));
      if (area > maxArea) {
        maxArea = area;
        next = j;
      }
    }
    out.push(points[next]);
    a = next;
  }
  out.push(points[n - 1]);
  return out;
}

/** Downsamples every segment, sharing the point budget in proportion to segment length. */
export function downsampleSegments(segments: readonly Pt[][], maxPoints: number): Pt[][] {
  const total = segments.reduce((n, s) => n + s.length, 0);
  if (total <= maxPoints) return segments.map((s) => s.slice());
  return segments.map((s) => lttb(s, Math.max(3, Math.round((s.length / total) * maxPoints))));
}

/** Point closest in time to t (binary search over a time-sorted list). */
export function nearest<T extends { t: number }>(points: readonly T[], t: number): T | null {
  if (!points.length) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].t - t) <= Math.abs(points[lo].t - t)) return points[lo - 1];
  return points[lo];
}

export interface SeriesStats {
  avg: number;
  min: number;
  max: number;
  p95: number;
  count: number;
}

export function seriesStats(values: readonly number[]): SeriesStats | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const sorted = v.slice().sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return { avg: sum / v.length, min: sorted[0], max: sorted[sorted.length - 1], p95: sorted[Math.max(0, idx)], count: v.length };
}

/* ---------------------------------------------------------------- axes */

/** A "nice" step (1, 2, 2.5, 5 × 10ⁿ) giving about `count` intervals over `span`. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || !(count > 0)) return 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/** Expands [min, max] outward to nice bounds and returns the ticks between them. */
export function niceTicks(min: number, max: number, count = 4): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (max === min) {
    max = min === 0 ? 1 : min + Math.abs(min) * 0.1;
    if (min !== 0) min = min - Math.abs(min) * 0.1;
  }
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
  return { min: lo, max: hi, ticks };
}

/** Y domain per metric kind: utilisation is always 0–100 %, memory starts at 0, temperature hugs the data. */
export function domainFor(kind: MetricDef['kind'], min: number, max: number): { min: number; max: number; ticks: number[] } {
  if (kind === 'percent') return { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };
  if (kind === 'memory') return niceTicks(0, Math.max(max * 1.08, 0.5), 4);
  return niceTicks(Math.max(0, Math.floor((min - 4) / 5) * 5), Math.ceil((max + 4) / 5) * 5, 4);
}

const TIME_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600].map((s) => s * 1000);

/** Evenly spaced elapsed-time ticks (ms) at a human step, at most `maxTicks` intervals. */
export function timeTicks(durationMs: number, maxTicks = 6): number[] {
  if (!(durationMs > 0)) return [0];
  const step = TIME_STEPS.find((s) => durationMs / s <= maxTicks) ?? Math.ceil(durationMs / maxTicks / 3_600_000) * 3_600_000;
  const out: number[] = [];
  for (let t = 0; t <= durationMs + 1; t += step) out.push(t);
  return out;
}

/** Elapsed time as m:ss or h:mm:ss. */
export function formatOffset(ms: number): string {
  return formatClock(Math.round(ms / 1000));
}

/** Units a chart can show: the system metrics plus frames per second (PresentMon, opt-in). */
export type ChartUnit = MetricDef['unit'] | 'fps';

/** What LineChart needs to know about the series it draws. */
export interface ChartMetric {
  label: string;
  unit: ChartUnit;
  color: string;
}

export function formatMetric(value: number | null | undefined, unit: ChartUnit): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (unit === 'fps') return `${Math.round(value)} fps`;
  if (unit === 'GB') return `${value.toFixed(value >= 10 ? 1 : 2)} GB`;
  if (unit === '°C') return `${Math.round(value)} °C`;
  return `${Math.round(value)}%`;
}

/* ---------------------------------------------------------------- compare */

/** Differences smaller than this (relative %) are treated as normal run-to-run variation. */
export const NOISE_PCT = 5;

export interface Delta {
  a: number | null;
  b: number | null;
  diff: number | null;
  /** Relative change from A to B in %, null when A is 0 or either side is missing. */
  pct: number | null;
  withinNoise: boolean;
  direction: 'higher' | 'lower' | 'same' | 'unknown';
}

export function compareValues(a: number | null, b: number | null, noisePct = NOISE_PCT): Delta {
  if (a == null || b == null) return { a, b, diff: null, pct: null, withinNoise: false, direction: 'unknown' };
  const diff = b - a;
  const pct = a !== 0 ? (diff / Math.abs(a)) * 100 : null;
  const withinNoise = pct != null ? Math.abs(pct) < noisePct : diff === 0;
  const direction = diff === 0 ? 'same' : diff > 0 ? 'higher' : 'lower';
  return { a, b, diff, pct, withinNoise, direction };
}

/**
 * Sessions worth comparing against `current`: the same game first (closest in time first,
 * so the default is the neighbouring run), then everything else, newest first.
 */
export function compareCandidates<T extends { id: string; gameId: string; startMs: number }>(list: readonly T[], current: T): T[] {
  const others = list.filter((x) => x.id !== current.id);
  const same = others.filter((x) => x.gameId === current.gameId).sort((a, b) => Math.abs(a.startMs - current.startMs) - Math.abs(b.startMs - current.startMs));
  const rest = others.filter((x) => x.gameId !== current.gameId).sort((a, b) => b.startMs - a.startMs);
  return [...same, ...rest];
}
