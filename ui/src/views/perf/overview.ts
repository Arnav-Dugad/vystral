/**
 * Track C2: pure helpers for the redesigned Performance page — a session's health in plain words, the frame-rate
 * trend across sessions, the headline figures, "worth a look" highlights and stutter markers. Nothing is estimated:
 * a session without frame-rate data is "not measured", never guessed.
 */
import type { InsightSample, PerfSummary, Session } from '../../bridge/types';
import { formatDuration } from '../../lib/format';
import { formatSpan } from './insight';

export interface PerfEntry {
  id: string;
  gameId: string;
  startMs: number;
  session: Session;
  summary: PerfSummary;
}

export type PerfTab = 'overview' | 'sessions' | 'compare' | 'system';
export const PERF_TABS: readonly PerfTab[] = ['overview', 'sessions', 'compare', 'system'];
export const isPerfTab = (v: unknown): v is PerfTab => typeof v === 'string' && (PERF_TABS as readonly string[]).includes(v);

export type HealthLevel = 'smooth' | 'uneven' | 'rough' | 'unmeasured';

export const HEALTH_LABEL: Record<HealthLevel, string> = {
  smooth: 'Smooth',
  uneven: 'Some hitches',
  rough: 'Rough',
  unmeasured: 'FPS not measured',
};

export interface SessionHealth {
  level: HealthLevel;
  /** Plain-language reasons, most important first. Empty for a smooth session. */
  reasons: string[];
}

const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Same thresholds as the background-apps card: lows under half the average, more than a stutter a minute, CPU above 85%. */
export const ROUGH = { lowRatio: 0.5, stuttersPerMin: 1, cpuAvg: 85 } as const;
export const UNEVEN = { lowRatio: 0.65, stuttersPerMin: 0.5, throttledSeconds: 30 } as const;

export function stuttersPerMinute(summary: PerfSummary, durationSeconds: number | null | undefined): number | null {
  if (!fin(summary.stutterCount) || !fin(durationSeconds) || durationSeconds < 60) return null;
  return summary.stutterCount / (durationSeconds / 60);
}

/** How a session played. Needs frame-rate data; heat and power limits are reasons, never a verdict on their own. */
export function sessionHealth(summary: PerfSummary, durationSeconds: number | null | undefined): SessionHealth {
  const reasons: string[] = [];
  const avg = summary.fpsAvg;
  const low = summary.fps1Low;
  const thermal = summary.throttledSeconds ?? 0;
  const power = summary.powerLimitedSeconds ?? 0;
  const heatReason = thermal >= UNEVEN.throttledSeconds ? `The GPU slowed down for heat for ${formatSpan(thermal)}` : null;
  const powerReason = fin(durationSeconds) && durationSeconds > 0 && power / durationSeconds >= 0.5
    ? `The GPU ran at its power limit for most of it (${formatSpan(power)})`
    : null;
  if (!fin(avg) || avg <= 0) {
    if (heatReason) reasons.push(heatReason);
    return { level: 'unmeasured', reasons };
  }
  const ratio = fin(low) ? low / avg : null;
  const rate = stuttersPerMinute(summary, durationSeconds);
  let level: HealthLevel = 'smooth';
  if (ratio != null && ratio < UNEVEN.lowRatio) {
    reasons.push(`1% lows fell to ${Math.round(low!)} fps — ${Math.round(ratio * 100)}% of the ${Math.round(avg)} fps average`);
    level = ratio < ROUGH.lowRatio ? 'rough' : 'uneven';
  }
  if (rate != null && rate > UNEVEN.stuttersPerMin) {
    reasons.push(`${summary.stutterCount} stutters, about ${rate < 10 ? rate.toFixed(1) : Math.round(rate)} a minute`);
    if (rate > ROUGH.stuttersPerMin) level = 'rough';
    else if (level === 'smooth') level = 'uneven';
  }
  if (fin(summary.cpuAvg) && summary.cpuAvg > ROUGH.cpuAvg) {
    reasons.push(`The CPU averaged ${Math.round(summary.cpuAvg)}%`);
    level = 'rough';
  }
  if (heatReason) {
    reasons.push(heatReason);
    if (level === 'smooth') level = 'uneven';
  }
  if (powerReason && level !== 'smooth') reasons.push(powerReason);
  return { level, reasons };
}

export function healthOf(e: PerfEntry): SessionHealth {
  return sessionHealth(e.summary, e.session.durationSeconds);
}

export function median(values: readonly number[]): number | null {
  const v = values.filter(fin).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/* ---------------------------------------------------------------- recent health */

export interface RecentHealth {
  /** Oldest first. */
  items: { entry: PerfEntry; health: SessionHealth }[];
  counts: Record<HealthLevel, number>;
  latest: { entry: PerfEntry; health: SessionHealth } | null;
}

export function recentHealth(entriesNewestFirst: readonly PerfEntry[], n = 10): RecentHealth {
  const items = entriesNewestFirst.slice(0, n).map((entry) => ({ entry, health: healthOf(entry) })).reverse();
  const counts: Record<HealthLevel, number> = { smooth: 0, uneven: 0, rough: 0, unmeasured: 0 };
  for (const i of items) counts[i.health.level]++;
  return { items, counts, latest: items.length ? items[items.length - 1] : null };
}

/* ---------------------------------------------------------------- frame-rate trend */

export interface TrendPoint {
  id: string;
  gameId: string;
  startMs: number;
  avg: number;
  low: number | null;
}

/** Sessions with a measured frame rate, oldest first, the newest `n`. */
export function fpsTrend(entriesNewestFirst: readonly PerfEntry[], n = 30): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (const e of entriesNewestFirst) {
    if (out.length >= n) break;
    const avg = e.summary.fpsAvg;
    if (!fin(avg) || avg <= 0) continue;
    out.push({ id: e.id, gameId: e.gameId, startMs: e.startMs, avg, low: fin(e.summary.fps1Low) ? e.summary.fps1Low : null });
  }
  return out.reverse();
}

/** The newest point against the median of the ones before it, in percent; null with fewer than three earlier points. */
export function trendDelta(points: readonly TrendPoint[], key: 'avg' | 'low'): number | null {
  if (points.length < 4) return null;
  const last = points[points.length - 1][key];
  const base = median(points.slice(0, -1).map((p) => p[key]).filter(fin));
  if (!fin(last) || base == null || base <= 0) return null;
  return ((last - base) / base) * 100;
}

/* ---------------------------------------------------------------- headline figures */

export interface PerfKpis {
  sessions: number;
  withFps: number;
  hours: number;
  medianFps: number | null;
  medianLow: number | null;
  gpuLoad: number | null;
  hottestC: number | null;
  throttledSeconds: number;
  powerLimitedSeconds: number;
}

export function kpis(entries: readonly PerfEntry[]): PerfKpis {
  const withFps = entries.filter((e) => fin(e.summary.fpsAvg) && e.summary.fpsAvg! > 0);
  const gpu = entries.map((e) => e.summary.gpuAvg).filter(fin);
  const temps = entries.map((e) => e.summary.peakTempC ?? e.summary.gpuTempMaxC).filter(fin);
  return {
    sessions: entries.length,
    withFps: withFps.length,
    hours: entries.reduce((h, e) => h + (fin(e.session.durationSeconds) ? e.session.durationSeconds : 0), 0) / 3600,
    medianFps: median(withFps.map((e) => e.summary.fpsAvg!)),
    medianLow: median(withFps.map((e) => e.summary.fps1Low).filter(fin)),
    gpuLoad: gpu.length ? gpu.reduce((a, b) => a + b, 0) / gpu.length : null,
    hottestC: temps.length ? Math.max(...temps) : null,
    throttledSeconds: entries.reduce((s, e) => s + (e.summary.throttledSeconds ?? 0), 0),
    powerLimitedSeconds: entries.reduce((s, e) => s + (e.summary.powerLimitedSeconds ?? 0), 0),
  };
}

/* ---------------------------------------------------------------- worth a look */

export interface Highlight {
  kind: 'roughest' | 'hottest' | 'power' | 'smoothest';
  entry: PerfEntry;
  title: string;
  body: string;
}

/** Up to four sessions worth opening, each for a different reason; a session is listed once. */
export function highlights(entries: readonly PerfEntry[]): Highlight[] {
  const out: Highlight[] = [];
  const used = new Set<string>();
  const add = (h: Highlight | null) => {
    if (h && !used.has(h.entry.id)) {
      used.add(h.entry.id);
      out.push(h);
    }
  };
  const fps = entries.filter((e) => fin(e.summary.fpsAvg) && fin(e.summary.fps1Low) && e.summary.fpsAvg! > 0);
  const byRatio = fps.slice().sort((a, b) => a.summary.fps1Low! / a.summary.fpsAvg! - b.summary.fps1Low! / b.summary.fpsAvg!);
  const worst = byRatio[0];
  if (worst && healthOf(worst).level !== 'smooth') {
    add({ kind: 'roughest', entry: worst, title: 'Least even frame rate', body: `1% lows of ${Math.round(worst.summary.fps1Low!)} fps against a ${Math.round(worst.summary.fpsAvg!)} fps average.` });
  }
  const hot = entries.filter((e) => (e.summary.throttledSeconds ?? 0) >= UNEVEN.throttledSeconds).sort((a, b) => (b.summary.throttledSeconds ?? 0) - (a.summary.throttledSeconds ?? 0))[0];
  if (hot) add({ kind: 'hottest', entry: hot, title: 'Slowed down by heat', body: `The GPU throttled for ${formatSpan(hot.summary.throttledSeconds ?? 0)}${fin(hot.summary.peakTempC) ? ` at up to ${Math.round(hot.summary.peakTempC)} °C` : ''}.` });
  const power = entries
    .filter((e) => fin(e.session.durationSeconds) && e.session.durationSeconds > 0 && (e.summary.powerLimitedSeconds ?? 0) / e.session.durationSeconds >= 0.5)
    .sort((a, b) => (b.summary.powerLimitedSeconds ?? 0) / b.session.durationSeconds! - (a.summary.powerLimitedSeconds ?? 0) / a.session.durationSeconds!)[0];
  if (power) add({ kind: 'power', entry: power, title: 'Held back by the power limit', body: `At its power limit for ${formatSpan(power.summary.powerLimitedSeconds ?? 0)} of ${formatDuration(power.session.durationSeconds ?? 0)} — normal under full load; a laptop’s performance mode can raise it.` });
  const best = byRatio[byRatio.length - 1];
  if (best && byRatio.length > 1 && healthOf(best).level === 'smooth') add({ kind: 'smoothest', entry: best, title: 'Smoothest session', body: `${Math.round(best.summary.fpsAvg!)} fps average with 1% lows at ${Math.round(best.summary.fps1Low!)} fps.` });
  return out.slice(0, 4);
}

/* ---------------------------------------------------------------- stutter markers */

export interface StutterMark {
  t: number;
  fps: number;
}

/**
 * Moments in a session where the frame rate dropped sharply: a two-second average under 60% of the session's median,
 * or a p99 frame time over 2.5× the median frame time. Neighbouring samples merge into one mark (the lowest);
 * at most `max` marks, the worst kept.
 */
export function stutterMarks(samples: readonly InsightSample[], max = 40): StutterMark[] {
  const pts = samples.filter((s) => fin(s.t) && fin(s.fps) && s.fps! > 0).slice().sort((a, b) => a.t - b.t);
  if (pts.length < 8) return [];
  const med = median(pts.map((s) => s.fps!))!;
  const medFt = median(pts.map((s) => s.frameTimeMs).filter(fin));
  const marks: StutterMark[] = [];
  let prevT = -Infinity;
  for (const s of pts) {
    const spike = medFt != null && fin(s.frameTimeP99Ms) && s.frameTimeP99Ms > medFt * 2.5;
    if (s.fps! >= med * 0.6 && !spike) continue;
    const last = marks[marks.length - 1];
    if (last && s.t - prevT <= 4000) {
      if (s.fps! < last.fps) {
        last.t = s.t;
        last.fps = s.fps!;
      }
    } else marks.push({ t: s.t, fps: s.fps! });
    prevT = s.t;
  }
  if (marks.length <= max) return marks;
  return marks.slice().sort((a, b) => a.fps - b.fps).slice(0, max).sort((a, b) => a.t - b.t);
}
