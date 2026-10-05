import { describe, expect, it } from 'vitest';
import type { InsightSample, PerfSample, PerfSummary } from '../bridge/types';
import { buildGhost, chooseGhost, fpsSeries, GHOST_POINTS, ghostCaption, ghostYAt, loadSeries, smoothPath } from './ghost';
import { parsePerfSummary } from '../views/perf/series';

const perf = (n: number, f: (i: number) => Partial<PerfSample> = () => ({})): PerfSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 2000, cpu: 40 + Math.sin(i / 7) * 20, gpu: 80, gpuMemMb: null, ramMb: null, gpuTempC: null, ...f(i) }));

const insight = (n: number, fps: (i: number) => number | null): InsightSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i * 2000, gpuClockMhz: null, throttleFlags: null, fps: fps(i), frameTimeMs: null, frameTimeP99Ms: null }));

const summary = (o: Partial<PerfSummary>) => parsePerfSummary(JSON.stringify({ samples: 10, ...o }));

describe('buildGhost', () => {
  it('downsamples long sessions to about 120 points', () => {
    const g = buildGhost(loadSeries(perf(5400), 'cpu'), 'cpu')!;
    const n = g.segments.reduce((a, s) => a + s.length, 0);
    expect(n).toBeLessThanOrEqual(GHOST_POINTS + 2);
    expect(n).toBeGreaterThan(GHOST_POINTS * 0.8);
  });

  it('normalises into 0…1 with a fixed 0–100 % scale for utilisation', () => {
    const g = buildGhost(loadSeries(perf(50, (i) => ({ cpu: i % 2 ? 100 : 0 })), 'cpu'), 'cpu')!;
    const pts = g.segments.flat();
    expect(Math.min(...pts.map((p) => p.x))).toBe(0);
    expect(Math.max(...pts.map((p) => p.x))).toBe(1);
    expect(Math.min(...pts.map((p) => p.y))).toBe(0);
    expect(Math.max(...pts.map((p) => p.y))).toBe(1);
    expect(g.end).toEqual(pts[pts.length - 1]);
  });

  it('keeps gaps as gaps instead of drawing across them', () => {
    const g = buildGhost(loadSeries(perf(60, (i) => ({ cpu: i >= 20 && i < 30 ? null : 50 })), 'cpu'), 'cpu')!;
    expect(g.segments.length).toBe(2);
  });

  it('draws nothing with too few real samples', () => {
    expect(buildGhost(loadSeries(perf(5), 'cpu'), 'cpu')).toBeNull();
    expect(buildGhost(loadSeries(perf(40, () => ({ cpu: null })), 'cpu'), 'cpu')).toBeNull();
    expect(buildGhost([], 'fps')).toBeNull();
  });

  it('frame rate leaves headroom above the peak', () => {
    const g = buildGhost(fpsSeries(insight(30, () => 120)), 'fps')!;
    expect(Math.min(...g.segments.flat().map((p) => p.y))).toBeGreaterThan(0.1);
  });
});

describe('chooseGhost', () => {
  it('prefers FPS when it was captured, else CPU, else GPU', () => {
    const fps = summary({ fpsAvg: 98, cpuAvg: 40 });
    expect(chooseGhost({ summary: fps, insight: insight(40, () => 100), samples: perf(40) })!.metric).toBe('fps');
    expect(chooseGhost({ summary: fps, insight: insight(40, () => null), samples: perf(40) })!.metric).toBe('cpu');
    expect(chooseGhost({ summary: summary({ cpuAvg: 40 }), insight: insight(40, () => 100), samples: perf(40) })!.metric).toBe('cpu');
    expect(chooseGhost({ summary: summary({}), samples: perf(40, () => ({ cpu: null })) })!.metric).toBe('gpu');
    expect(chooseGhost({ summary: summary({}), samples: perf(40, () => ({ cpu: null, gpu: null })) })).toBeNull();
    expect(chooseGhost({ summary: null })).toBeNull();
  });
});

describe('ghostCaption', () => {
  it('is short and honest', () => {
    expect(ghostCaption(4320, 'fps', summary({ fpsAvg: 97.6 }))).toBe('Last session · 1h 12m · 98 FPS avg');
    expect(ghostCaption(4320, 'cpu', summary({ cpuAvg: 41.7 }))).toBe('Last session · 1h 12m · CPU 42% avg');
    expect(ghostCaption(600, 'gpu', summary({}))).toBe('Last session · 10m · GPU');
  });
});

describe('smoothPath', () => {
  it('never overshoots the data between points', () => {
    const pts = [0, 0.9, 0.1, 0.1, 0.8, 0.5, 0.5, 0].map((y, i, a) => ({ x: i / (a.length - 1), y }));
    const d = smoothPath(pts, 1000, 300);
    const nums = [...d.matchAll(/C([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+) ([\d.-]+),([\d.-]+)/g)];
    expect(nums.length).toBe(pts.length - 1);
    nums.forEach((m, i) => {
      const lo = Math.min(pts[i].y, pts[i + 1].y) * 300 - 0.11;
      const hi = Math.max(pts[i].y, pts[i + 1].y) * 300 + 0.11;
      for (const y of [Number(m[2]), Number(m[4])]) {
        expect(y).toBeGreaterThanOrEqual(lo);
        expect(y).toBeLessThanOrEqual(hi);
      }
    });
  });

  it('handles tiny inputs', () => {
    expect(smoothPath([], 10, 10)).toBe('');
    expect(smoothPath([{ x: 0, y: 0.5 }], 10, 10)).toBe('M0,5');
    expect(smoothPath([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10, 10)).toBe('M0,0L10,10');
  });
});

describe('ghostYAt', () => {
  it('interpolates within segments and is null in gaps', () => {
    const g = { metric: 'cpu' as const, segments: [[{ x: 0, y: 0 }, { x: 0.4, y: 1 }], [{ x: 0.6, y: 0.5 }, { x: 1, y: 0.5 }]], end: { x: 1, y: 0.5 } };
    expect(ghostYAt(g, 0.2)).toBeCloseTo(0.5);
    expect(ghostYAt(g, 0.5)).toBeNull();
    expect(ghostYAt(g, 0.8)).toBe(0.5);
  });
});
