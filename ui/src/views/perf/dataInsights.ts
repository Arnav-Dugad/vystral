/** Pure helpers for the driver comparison and background-app cards (Track F). */
import type { BackgroundAppStat, DriverGameComparison } from '../../bridge/types';

/** Run-to-run variation: changes smaller than this (percent) are "about the same". */
export const DRIVER_NOISE_PCT = 3;

export type Better = 'higher' | 'lower';

export interface DriverDelta {
  /** after − before, in the metric's unit; null when either side is missing. */
  diff: number | null;
  pct: number | null;
  verdict: 'better' | 'worse' | 'same' | 'unknown';
}

/** Compares a before/after figure. FPS is better higher, frame time better lower. */
export function driverDelta(before: number | null, after: number | null, better: Better): DriverDelta {
  if (before == null || after == null || !Number.isFinite(before) || !Number.isFinite(after) || before <= 0) return { diff: null, pct: null, verdict: 'unknown' };
  const diff = after - before;
  const pct = (diff / before) * 100;
  if (Math.abs(pct) < DRIVER_NOISE_PCT) return { diff, pct, verdict: 'same' };
  const improved = better === 'higher' ? diff > 0 : diff < 0;
  return { diff, pct, verdict: improved ? 'better' : 'worse' };
}

/** "+4.2%", "−3%", "±0%". */
export function formatPct(pct: number | null): string {
  if (pct == null) return '—';
  const abs = Math.abs(pct);
  const text = abs < 10 ? abs.toFixed(1) : Math.round(abs).toString();
  return `${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${text}%`;
}

/** One-line headline for a comparison card. */
export function driverHeadline(c: DriverGameComparison): string {
  const fps = driverDelta(c.before.fpsAvg, c.after.fpsAvg, 'higher');
  const low = driverDelta(c.before.fps1Low, c.after.fps1Low, 'higher');
  if (fps.verdict === 'unknown') return 'Not enough frame-rate data to compare.';
  if (fps.verdict === 'same' && (low.verdict === 'same' || low.verdict === 'unknown')) return 'About the same frame rate on both drivers.';
  const main = fps.verdict === 'same' ? low : fps;
  const what = fps.verdict === 'same' ? '1% lows' : 'average frame rate';
  return `${main.verdict === 'better' ? 'Higher' : 'Lower'} ${what} since the driver change (${formatPct(main.pct)}).`;
}

/** "62%" share of sessions; "—" when unknown. */
export function presence(p: number | null): string {
  return p == null ? '—' : `${Math.round(p * 100)}%`;
}

/** "1.4 GB" / "640 MB". */
export function formatMb(mb: number | null): string {
  if (mb == null || !Number.isFinite(mb)) return '—';
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb >= 10240 ? 0 : 1)} GB` : `${Math.round(mb)} MB`;
}

/** Plain-language reason an app is listed as a suspect. */
export function suspectReason(a: BackgroundAppStat, mode: 'fps' | 'memory' | 'none'): string {
  const rough = mode === 'memory' ? 'sessions where memory was nearly full' : 'rough sessions';
  return `Running in ${presence(a.roughPresence)} of ${rough}, ${presence(a.cleanPresence)} of the others`;
}
