/**
 * Track C2: pure helpers for the startup timing chart in Settings › About. A start is four stacked phases, from the
 * process starting to VYSTRAL being ready; the summary compares the newest start with the usual (median) one.
 */
import type { StartupRun } from '../bridge/types.trackC2';

export type PhaseKey = 'backend' | 'webview' | 'firstPaint' | 'ready';

export interface PhaseDef {
  key: PhaseKey;
  label: string;
  /** What happens in this phase, in plain words (legend and tooltip). */
  detail: string;
}

/** In the order they happen; the chart stacks them bottom-up and colours them with a one-hue ramp in this order. */
export const PHASES: readonly PhaseDef[] = [
  { key: 'backend', label: 'Backend', detail: 'VYSTRAL starts and opens your library' },
  { key: 'webview', label: 'WebView', detail: 'The interface engine (WebView2) starts' },
  { key: 'firstPaint', label: 'First paint', detail: 'Home appears on screen' },
  { key: 'ready', label: 'Ready', detail: 'Live data arrives and everything responds' },
];

export interface PhaseSpan {
  key: PhaseKey;
  /** Start and end in ms since the process started. */
  from: number;
  to: number;
  ms: number;
}

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The four phases of one start; each begins where the previous ended, and none is negative. */
export function phasesOf(run: StartupRun): PhaseSpan[] {
  const marks = [finite(run.backendMs), finite(run.webViewMs), finite(run.firstPaintMs), finite(run.readyMs)];
  let prev = 0;
  return PHASES.map((p, i) => {
    const to = Math.max(prev, marks[i]);
    const span = { key: p.key, from: prev, to, ms: to - prev };
    prev = to;
    return span;
  });
}

export const totalOf = (run: StartupRun) => phasesOf(run)[3].to;

export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The newest start is "much slower" when it took at least this many times the usual start… */
export const REGRESSION_FACTOR = 1.5;
/** …and at least this much longer (so 0.6 s → 0.95 s isn't a warning). */
export const REGRESSION_MIN_MS = 700;
/** Fewer earlier starts than this and "usual" doesn't mean much yet. */
export const REGRESSION_MIN_RUNS = 4;

export interface StartupSummary {
  count: number;
  /** The usual start: the median of the starts before the newest one (of the only one when there is just one). */
  median: number | null;
  latest: StartupRun | null;
  latestMs: number | null;
  fastestMs: number | null;
  /** The newest start compared with the median of the ones before it; null when it isn't much slower. */
  regression: { baselineMs: number; factor: number; extraMs: number; phase: PhaseKey } | null;
}

export function summarize(runs: readonly StartupRun[]): StartupSummary {
  const totals = runs.map(totalOf);
  const latest = runs.length ? runs[runs.length - 1] : null;
  const latestMs = latest ? totalOf(latest) : null;
  let regression: StartupSummary['regression'] = null;
  const earlier = runs.slice(0, -1);
  if (latest && latestMs != null && earlier.length >= REGRESSION_MIN_RUNS) {
    const baseline = median(earlier.map(totalOf));
    if (baseline != null && baseline > 0 && latestMs >= baseline * REGRESSION_FACTOR && latestMs - baseline >= REGRESSION_MIN_MS) {
      // Which phase grew the most against its own usual length.
      const usual = PHASES.map((_, i) => median(earlier.map((r) => phasesOf(r)[i].ms)) ?? 0);
      const now = phasesOf(latest);
      let phase: PhaseKey = 'ready';
      let grew = -Infinity;
      now.forEach((p, i) => {
        const d = p.ms - usual[i];
        if (d > grew) {
          grew = d;
          phase = p.key;
        }
      });
      regression = { baselineMs: baseline, factor: latestMs / baseline, extraMs: latestMs - baseline, phase };
    }
  }
  return {
    count: runs.length,
    median: earlier.length ? median(earlier.map(totalOf)) : median(totals),
    latest,
    latestMs,
    fastestMs: totals.length ? Math.min(...totals) : null,
    regression,
  };
}

/** "1.42 s" for a second or more, "860 ms" below; "—" when unknown. */
export function formatStartup(ms: number | null | undefined, digits = 2): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(digits)} s`;
}

/** Where the extra time went, in plain words. */
export function regressionText(r: NonNullable<StartupSummary['regression']>, latestMs: number): string {
  const where: Record<PhaseKey, string> = {
    backend: 'before VYSTRAL had opened your library — a busy disk or an antivirus scan at sign-in often does this',
    webview: 'while the interface engine started — often right after a Windows or WebView2 update',
    firstPaint: 'before Home appeared — usually a cold start after an update, when there’s no saved Home to show',
    ready: 'while live data loaded — a big library scan or a slow drive can do this',
  };
  const times = r.factor >= 1.95 ? `${r.factor.toFixed(1)}×` : `${Math.round((r.factor - 1) * 100)}% longer than`;
  const usual = r.factor >= 1.95 ? `your usual ${formatStartup(r.baselineMs)}` : `usual (${formatStartup(r.baselineMs)})`;
  return `The last start took ${formatStartup(latestMs)}, ${times} ${usual}. Most of the extra time was ${where[r.phase]}. One slow start is normal; if it keeps happening, the log has the details.`;
}
