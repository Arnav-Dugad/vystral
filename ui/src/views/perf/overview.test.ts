import { describe, expect, it } from 'vitest';
import type { InsightSample, PerfSummary, Session } from '../../bridge/types';
import { fpsTrend, healthOf, highlights, isPerfTab, kpis, recentHealth, sessionHealth, stutterMarks, trendDelta, type PerfEntry } from './overview';
import { parsePerfSummary } from './series';

const summary = (o: Record<string, unknown>): PerfSummary => parsePerfSummary(JSON.stringify({ samples: 100, ...o }))!;
let n = 0;
const entry = (o: Record<string, unknown>, durationSeconds = 3600, startMs = Date.UTC(2026, 9, 1) + n * 86_400_000): PerfEntry => {
  const id = `s${++n}`;
  return { id, gameId: 'g', startMs, session: { id, gameId: 'g', durationSeconds, start: new Date(startMs).toISOString() } as Session, summary: summary(o) };
};

// The owner's real session shape: PresentMon ~58 fps, 1% lows 22, power-limited most of the time.
const OWNER = { fpsAvg: 58.3, fps1Low: 22.4, fps01Low: 14.8, stutterCount: 63, cpuAvg: 61.4, gpuAvg: 97.2, throttledSeconds: 0, powerLimitedSeconds: 2214, throttleReasons: ['power'] };

describe('session health', () => {
  it('calls the owner’s 58 / 22 fps session rough, with reasons in plain words', () => {
    const h = sessionHealth(summary(OWNER), 2600);
    expect(h.level).toBe('rough');
    expect(h.reasons[0]).toBe('1% lows fell to 22 fps — 38% of the 58 fps average');
    expect(h.reasons.some((r) => r.startsWith('The GPU ran at its power limit'))).toBe(true);
  });

  it('smooth, uneven and rough', () => {
    expect(sessionHealth(summary({ fpsAvg: 120, fps1Low: 90, stutterCount: 5 }), 3600).level).toBe('smooth');
    expect(sessionHealth(summary({ fpsAvg: 120, fps1Low: 70, stutterCount: 5 }), 3600).level).toBe('uneven');
    expect(sessionHealth(summary({ fpsAvg: 120, fps1Low: 100, stutterCount: 45 }), 3600).level).toBe('uneven'); // 0.75 a minute
    expect(sessionHealth(summary({ fpsAvg: 120, fps1Low: 100, stutterCount: 90 }), 3600).level).toBe('rough'); // 1.5 a minute
    expect(sessionHealth(summary({ fpsAvg: 120, fps1Low: 100, cpuAvg: 91 }), 3600).level).toBe('rough');
    expect(sessionHealth(summary({ fpsAvg: 120, fps1Low: 100, throttledSeconds: 252 }), 3600).level).toBe('uneven');
  });

  it('never judges a session without frame-rate data', () => {
    const h = sessionHealth(summary({ cpuAvg: 95, throttledSeconds: 300 }), 3600);
    expect(h.level).toBe('unmeasured');
    expect(h.reasons).toEqual(['The GPU slowed down for heat for 5m']);
  });

  it('ignores stutter counts on very short sessions', () => {
    expect(sessionHealth(summary({ fpsAvg: 90, fps1Low: 80, stutterCount: 10 }), 30).level).toBe('smooth');
  });
});

describe('overview figures', () => {
  const list = [
    entry({ fpsAvg: 118, fps1Low: 71, stutterCount: 14 }),
    entry({ fpsAvg: 110, fps1Low: 66, stutterCount: 20, throttledSeconds: 252, peakTempC: 87 }),
    entry({ cpuAvg: 40 }),
    entry(OWNER, 2600),
    entry({ fpsAvg: 121, fps1Low: 96, stutterCount: 3, gpuTempMaxC: 74 }),
  ].sort((a, b) => b.startMs - a.startMs);

  it('recent health counts, oldest first', () => {
    const r = recentHealth(list, 10);
    expect(r.items).toHaveLength(5);
    expect(r.items[0].entry.startMs).toBeLessThan(r.items[4].entry.startMs);
    expect(r.counts).toEqual({ smooth: 1, uneven: 2, rough: 1, unmeasured: 1 });
    expect(r.latest?.health.level).toBe('smooth');
  });

  it('frame-rate trend skips unmeasured sessions and compares the newest with the usual', () => {
    const t = fpsTrend(list);
    expect(t.map((p) => Math.round(p.avg))).toEqual([118, 110, 58, 121]);
    expect(trendDelta(t, 'avg')).toBeCloseTo(((121 - 110) / 110) * 100, 5);
    expect(trendDelta(t.slice(0, 3), 'avg')).toBeNull();
  });

  it('headline figures', () => {
    const k = kpis(list);
    expect(k.sessions).toBe(5);
    expect(k.withFps).toBe(4);
    expect(k.medianFps).toBeCloseTo(114, 5);
    expect(k.hottestC).toBe(87);
    expect(k.throttledSeconds).toBe(252);
    expect(k.powerLimitedSeconds).toBe(2214);
  });

  it('worth a look lists each session once, for different reasons', () => {
    const h = highlights(list);
    expect(h.map((x) => x.kind)).toEqual(['roughest', 'hottest', 'power', 'smoothest'].filter((k) => k !== 'power'));
    expect(h[0].body).toBe('1% lows of 22 fps against a 58 fps average.');
    expect(new Set(h.map((x) => x.entry.id)).size).toBe(h.length);
    expect(healthOf(h[h.length - 1].entry).level).toBe('smooth');
  });

  it('tabs', () => {
    expect(isPerfTab('system')).toBe(true);
    expect(isPerfTab('nope')).toBe(false);
  });
});

describe('stutter marks', () => {
  const sample = (i: number, fps: number, p99?: number): InsightSample => ({ t: i * 2000, gpuClockMhz: null, throttleFlags: null, fps, frameTimeMs: 1000 / fps, frameTimeP99Ms: p99 ?? (1000 / fps) * 1.4 });

  it('marks sharp drops and merges neighbours into the lowest', () => {
    const s = Array.from({ length: 60 }, (_, i) => sample(i, 60));
    s[10] = sample(10, 30);
    s[11] = sample(11, 24); // same dip
    s[40] = sample(40, 58, 60); // a frame-time spike without a low average
    const m = stutterMarks(s);
    expect(m).toEqual([{ t: 22_000, fps: 24 }, { t: 80_000, fps: 58 }]);
  });

  it('needs frame-rate samples and caps the count, keeping the worst', () => {
    expect(stutterMarks([])).toEqual([]);
    const s = Array.from({ length: 200 }, (_, i) => sample(i, i % 10 === 5 ? 10 + (i % 7) : 60));
    const m = stutterMarks(s, 5);
    expect(m).toHaveLength(5);
    expect(m.every((x) => x.fps <= 12)).toBe(true);
    expect(m.map((x) => x.t)).toEqual([...m.map((x) => x.t)].sort((a, b) => a - b));
  });
});
