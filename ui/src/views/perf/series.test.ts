import { describe, it, expect } from 'vitest';
import type { PerfSample } from '../../bridge/types';
import {
  METRICS, compareCandidates, compareValues, domainFor, downsampleSegments, extractSeries, formatMetric, formatOffset, lttb, nearest, niceTicks,
  parsePerfSummary, seriesStats, splitSegments, summaryValue, timeTicks, type Pt,
} from './series';

const sample = (t: number, cpu: number | null, gpuMemMb: number | null = 2048): PerfSample => ({ t, cpu, gpu: 50, gpuMemMb, ramMb: 8192, gpuTempC: null });

describe('parsePerfSummary', () => {
  it('parses valid JSON and keeps nulls as nulls', () => {
    const s = parsePerfSummary(JSON.stringify({ samples: 10, cpuAvg: 40, gpuTempAvgC: null, fpsStatus: 'FPS is not recorded.' }));
    expect(s).not.toBeNull();
    expect(s!.cpuAvg).toBe(40);
    expect(s!.gpuTempAvgC).toBeNull();
    expect(s!.gpuMax).toBeNull();
    expect(s!.fpsStatus).toBe('FPS is not recorded.');
  });
  it('rejects malformed input', () => {
    expect(parsePerfSummary(null)).toBeNull();
    expect(parsePerfSummary('{oops')).toBeNull();
    expect(parsePerfSummary('42')).toBeNull();
  });
  it('never invents an FPS figure', () => {
    const s = parsePerfSummary(JSON.stringify({ samples: 1 }));
    expect(s!.fpsStatus).toMatch(/not recorded/);
  });
  it('converts summary values to display units', () => {
    const s = parsePerfSummary(JSON.stringify({ samples: 1, gpuMemAvgMb: 2048 }));
    const vram = METRICS.find((m) => m.key === 'gpuMemMb')!;
    expect(summaryValue(s, vram, 'avg')).toBe(2);
    expect(summaryValue(s, vram, 'max')).toBeNull();
  });
});

describe('series extraction and segmentation', () => {
  it('scales values and keeps missing values null', () => {
    const pts = extractSeries([sample(2000, 10, 1024), sample(0, null, 512)], 'gpuMemMb', 1 / 1024);
    expect(pts).toEqual([{ t: 0, v: 0.5 }, { t: 2000, v: 1 }]);
    expect(extractSeries([sample(0, null)], 'cpu')).toEqual([{ t: 0, v: null }]);
  });

  it('breaks lines at nulls and at long gaps', () => {
    const pts = [0, 2000, 4000, 6000, 60000, 62000].map((t, i) => ({ t, v: i === 2 ? null : i }));
    const segs = splitSegments(pts);
    expect(segs.map((s) => s.map((p) => p.t))).toEqual([[0, 2000], [6000], [60000, 62000]]);
  });
});

describe('lttb', () => {
  const series: Pt[] = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i === 500 ? 100 : Math.sin(i / 20) }));
  it('keeps endpoints and the requested size', () => {
    const out = lttb(series, 100);
    expect(out).toHaveLength(100);
    expect(out[0]).toBe(series[0]);
    expect(out[99]).toBe(series[999]);
  });
  it('preserves a spike', () => {
    expect(lttb(series, 100).some((p) => p.v === 100)).toBe(true);
  });
  it('returns the input when below threshold', () => {
    expect(lttb(series.slice(0, 10), 100)).toHaveLength(10);
  });
  it('shares the budget across segments', () => {
    const out = downsampleSegments([series.slice(0, 800), series.slice(800)], 100);
    const total = out.reduce((n, s) => n + s.length, 0);
    expect(total).toBeLessThanOrEqual(102);
    expect(out[0].length).toBeGreaterThan(out[1].length);
  });
});

describe('nearest', () => {
  const pts = [{ t: 0 }, { t: 10 }, { t: 20 }];
  it('finds the closest point', () => {
    expect(nearest(pts, 4)!.t).toBe(0);
    expect(nearest(pts, 6)!.t).toBe(10);
    expect(nearest(pts, 99)!.t).toBe(20);
    expect(nearest(pts, -5)!.t).toBe(0);
    expect(nearest([], 3)).toBeNull();
  });
});

describe('stats & axes', () => {
  it('computes avg/min/max/p95', () => {
    const st = seriesStats(Array.from({ length: 100 }, (_, i) => i + 1))!;
    expect(st.avg).toBe(50.5);
    expect(st.min).toBe(1);
    expect(st.max).toBe(100);
    expect(st.p95).toBe(95);
    expect(seriesStats([])).toBeNull();
  });

  it('produces nice ticks', () => {
    expect(niceTicks(0, 7.3, 4)).toEqual({ min: 0, max: 8, ticks: [0, 2, 4, 6, 8] });
    expect(niceTicks(3, 3).ticks.length).toBeGreaterThan(1);
  });

  it('uses fixed 0–100 for utilisation and tight bounds for temperature', () => {
    expect(domainFor('percent', 30, 60)).toMatchObject({ min: 0, max: 100 });
    const t = domainFor('temp', 62, 74);
    expect(t.min).toBeLessThanOrEqual(58);
    expect(t.max).toBeGreaterThanOrEqual(78);
    expect(domainFor('memory', 1, 6.5).min).toBe(0);
  });

  it('picks human time ticks', () => {
    expect(timeTicks(8 * 60_000, 6)).toEqual([0, 120_000, 240_000, 360_000, 480_000]);
    expect(timeTicks(0)).toEqual([0]);
  });

  it('formats offsets and values', () => {
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_725_000)).toBe('1:02:05');
    expect(formatMetric(null, '%')).toBe('—');
    expect(formatMetric(42.4, '%')).toBe('42%');
    expect(formatMetric(5.123, 'GB')).toBe('5.12 GB');
  });
});

describe('compareValues', () => {
  it('reports relative change and noise', () => {
    expect(compareValues(50, 52)).toMatchObject({ diff: 2, pct: 4, withinNoise: true, direction: 'higher' });
    expect(compareValues(50, 40)).toMatchObject({ diff: -10, pct: -20, withinNoise: false, direction: 'lower' });
  });
  it('handles missing and zero baselines', () => {
    expect(compareValues(null, 5)).toMatchObject({ diff: null, direction: 'unknown', withinNoise: false });
    expect(compareValues(0, 0)).toMatchObject({ pct: null, withinNoise: true, direction: 'same' });
  });
});

describe('compareCandidates', () => {
  it('puts the same game first, nearest in time first', () => {
    const cur = { id: 'c', gameId: 'a', startMs: 100 };
    const list = [cur, { id: 'x', gameId: 'b', startMs: 300 }, { id: 'y', gameId: 'a', startMs: 10 }, { id: 'z', gameId: 'a', startMs: 120 }, { id: 'w', gameId: 'b', startMs: 500 }];
    expect(compareCandidates(list, cur).map((e) => e.id)).toEqual(['z', 'y', 'w', 'x']);
  });
});
