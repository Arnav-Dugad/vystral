/**
 * Pure helpers for Track B data in the Performance view: GPU throttling bands, frame-rate
 * series, the frame-time histogram and plain-language summaries. Missing data stays missing.
 */
import type { InsightSample, PerfSummary } from '../../bridge/types';
import type { MaybePt } from './series';

/** Upper bucket edges (ms) of PerfSummary.frameTimeHistogram; the last bucket is "above 100 ms". Mirrors FrameStats.HistogramEdgesMs. */
export const FRAME_TIME_EDGES_MS = [4, 6, 8, 10, 12, 14, 17, 20, 25, 33, 50, 100] as const;

export const THROTTLE = { thermalSoftware: 1, thermalHardware: 2, powerCap: 4, powerBrake: 8 } as const;

export const isThermal = (flags: number | null | undefined) => flags != null && (flags & (THROTTLE.thermalSoftware | THROTTLE.thermalHardware)) !== 0;
export const isPowerLimited = (flags: number | null | undefined) => flags != null && (flags & (THROTTLE.powerCap | THROTTLE.powerBrake)) !== 0;

export interface Band {
  start: number;
  end: number;
}

/**
 * Time ranges (ms) where the GPU was thermally throttled. Each flagged sample covers the time
 * since the previous sample (at most `maxSpanMs`); touching ranges are merged.
 */
export function throttleBands(samples: readonly InsightSample[], maxSpanMs = 5000): Band[] {
  const sorted = samples.filter((s) => Number.isFinite(s.t)).slice().sort((a, b) => a.t - b.t);
  const bands: Band[] = [];
  let prevT: number | null = null;
  for (const s of sorted) {
    const span = prevT == null ? 2000 : Math.min(maxSpanMs, Math.max(0, s.t - prevT));
    prevT = s.t;
    if (!isThermal(s.throttleFlags)) continue;
    const start = Math.max(0, s.t - span);
    const last = bands[bands.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, s.t);
    else bands.push({ start, end: s.t });
  }
  return bands;
}

export function hasThrottleData(samples: readonly InsightSample[]): boolean {
  return samples.some((s) => s.throttleFlags != null);
}

export function fpsSeries(samples: readonly InsightSample[]): MaybePt[] {
  return samples
    .filter((s) => Number.isFinite(s.t))
    .map((s) => ({ t: s.t, v: typeof s.fps === 'number' && Number.isFinite(s.fps) && s.fps > 0 ? s.fps : null }))
    .sort((a, b) => a.t - b.t);
}

export interface HistogramBucket {
  /** Frame-time range in milliseconds, e.g. "8–10". */
  label: string;
  /** Equivalent frame rate range, for screen readers and tooltips. */
  fpsLabel: string;
  count: number;
  share: number;
}

const fpsAt = (ms: number) => Math.round(1000 / ms);

/** Labels and shares for the frame-time histogram. Returns [] when there is no histogram. */
export function histogramBuckets(hist: readonly number[] | null | undefined): HistogramBucket[] {
  if (!hist || hist.length !== FRAME_TIME_EDGES_MS.length + 1) return [];
  const total = hist.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
  if (total <= 0) return [];
  return hist.map((count, i) => {
    const lo = i === 0 ? 0 : FRAME_TIME_EDGES_MS[i - 1];
    const hi = i < FRAME_TIME_EDGES_MS.length ? FRAME_TIME_EDGES_MS[i] : null;
    const label = hi == null ? `${lo}+` : i === 0 ? `<${hi}` : `${lo}–${hi}`;
    const fpsLabel = hi == null ? `under ${fpsAt(lo)} fps` : i === 0 ? `over ${fpsAt(hi)} fps` : `${fpsAt(hi)}–${fpsAt(lo)} fps`;
    return { label, fpsLabel, count, share: count / total };
  });
}

/** "4m 12s", "1h 03m", "45s". */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

export const THERMAL_ALERT_SECONDS = 30;

/** The thermal alert text, or null when throttling was short or not measured. */
export function thermalAlert(summary: PerfSummary | null): string | null {
  const t = summary?.throttledSeconds;
  if (t == null || t < THERMAL_ALERT_SECONDS) return null;
  return summary?.thermalNote ?? `Your GPU got hot and slowed down for ${formatSpan(t)} — check airflow, a laptop stand, or a lower power profile in your laptop’s performance app (for example Armoury Crate).`;
}

export function hasFps(summary: PerfSummary | null): boolean {
  return summary?.fpsAvg != null && Number.isFinite(summary.fpsAvg);
}

export function formatFps(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `${Math.round(v)}`;
}

export function formatMs(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(v < 10 ? 1 : 0)} ms`;
}
