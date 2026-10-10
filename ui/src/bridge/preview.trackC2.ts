/**
 * Track C2 preview: the Performance page's rig summary, startup timing history, and a caption-button override.
 * Everything here is fictional sample data for the browser preview; the app reads the real values. URL switches:
 *   ?caption=220     pretend the window's caption buttons are 220 px wide (0–480; default 138)
 *   ?startupSlow     the newest start took much longer than usual (regression warning)
 *   ?startupNone     no startup timings in the log yet
 *   ?noRig           Windows didn't report the graphics card or processor
 */
import type { InsightSample, Session } from './types';
import type { Rig, StartupHistory, StartupRun } from './types.trackC2';
import { BridgeError } from './bridge';

const params = () => new URLSearchParams(location.search);

/** The caption-button width the preview reports (`?caption=`), clamped like the native side. */
export function previewCaptionInset(): number {
  const raw = params().get('caption');
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? Math.min(480, Math.max(0, n)) : 138;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

/** Twenty starts over the past week, about 1.4 s each; the snapshot paints Home except after an update. */
export function previewStartupRuns(now = Date.now(), slow = false): StartupRun[] {
  const r = rng(20261010);
  return Array.from({ length: 20 }, (_, i) => {
    const at = now - (19 - i) * 8.2 * 3_600_000 - Math.floor(r() * 3_000_000);
    const cold = i === 6; // first start after an update: no snapshot, a cold WebView
    const backend = 210 + r() * 90 + (cold ? 140 : 0);
    const webview = backend + 330 + r() * 120 + (cold ? 420 : 0);
    const firstPaint = webview + 230 + r() * 90 + (cold ? 380 : 0);
    let ready = firstPaint + 380 + r() * 160 + (cold ? 260 : 0);
    let fp = firstPaint;
    if (slow && i === 19) {
      // A slow disk or antivirus scan on the newest start.
      fp = firstPaint + 1400;
      ready = fp + 2100;
    }
    const round = (v: number) => Math.round(v * 10) / 10;
    return { at: new Date(at).toISOString(), backendMs: round(backend), webViewMs: round(webview), firstPaintMs: round(fp), readyMs: round(ready), cachedFirstPaint: !cold };
  });
}

/**
 * One recent session shaped like a real mid-range laptop run: PresentMon frame rate around 58 fps with 1% lows at 22,
 * a long tail in the frame-time histogram, and the GPU held back by its power limit (not heat). It is the fourth most
 * recent session with metrics, so the sessions earlier tracks' tests look at are unchanged.
 */
let rigSessionId: string | null = null;

/** Per-sample frame rate for that session: about 58 fps, sharp drops into the 20s, power-limited throughout. */
function rigInsightSamples(): InsightSample[] {
  const r = rng(58);
  return Array.from({ length: 240 }, (_, i) => {
    const drop = i % 31 === 17 || i % 53 === 40;
    const fps = drop ? 21 + r() * 6 : 52 + r() * 13;
    return { t: i * 2000, gpuClockMhz: 1480 + r() * 80, throttleFlags: r() > 0.12 ? 4 : 0, fps, frameTimeMs: 1000 / fps, frameTimeP99Ms: (1000 / fps) * (drop ? 2.6 : 1.5 + r() * 0.4) };
  });
}

export function decorateRigSession(sessions: Session[]): void {
  const recent = sessions.filter((s) => s.perfSummary).sort((a, b) => b.start.localeCompare(a.start));
  const s = recent[3];
  if (!s) return;
  rigSessionId = s.id;
  const base = JSON.parse(s.perfSummary!) as Record<string, unknown>;
  Object.assign(base, {
    cpuAvg: 61.4, cpuMax: 93.0, gpuAvg: 97.2, gpuMax: 100, gpuTempAvgC: 74, gpuTempMaxC: 79,
    fpsStatus: 'Measured with Intel PresentMon 2.6.0. Frame time is the time between the game’s presented frames.',
    fpsAvg: 58.3, fps1Low: 22.4, fps01Low: 14.8, frameTimeP50Ms: 16.4, frameTimeP99Ms: 41.7,
    stutterCount: 63, frameCount: 312_400,
    frameTimeHistogram: [0, 40, 310, 2100, 9800, 31200, 98400, 88300, 46200, 21900, 9400, 3600, 1150],
    fpsSource: 'Intel PresentMon 2.6.0',
    throttledSeconds: 0, powerLimitedSeconds: 2214, throttleReasons: ['power'], peakTempC: 79, gpuClockAvgMhz: 1515, thermalNote: null,
  });
  s.perfSummary = JSON.stringify(base);
}

export function trackC2PreviewHandlers(ctx: { insightSamples: (p: { sessionId: string }) => unknown }) {
  const p = params();
  const runs = p.has('startupNone') ? [] : previewStartupRuns(Date.now(), p.has('startupSlow'));
  return {
    'sessions.insightSamples': (q: { sessionId: string }) => (q?.sessionId && q.sessionId === rigSessionId ? rigInsightSamples() : ctx.insightSamples(q)),
    'performance.rig': (): Rig =>
      p.has('noRig')
        ? { gpuName: null, driver: null, cpuName: null, threads: navigator.hardwareConcurrency ?? 8, memoryGb: null }
        : { gpuName: 'NVIDIA GeForce RTX 4060 Laptop GPU', driver: '572.16', cpuName: 'AMD Ryzen 7 7735HS with Radeon Graphics', threads: 16, memoryGb: 15.2 },
    'diagnostics.startupHistory': (q: { limit?: number } | undefined): StartupHistory => {
      const limit = q?.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new BridgeError('invalid', 'Limit must be between 1 and 50.');
      return { runs: runs.slice(-limit), filesRead: runs.length ? 7 : 0 };
    },
  };
}
