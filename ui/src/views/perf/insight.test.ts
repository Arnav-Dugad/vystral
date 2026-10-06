import { describe, expect, it } from 'vitest';
import type { InsightSample } from '../../bridge/types';
import {
  FRAME_TIME_EDGES_MS, formatFps, formatMs, formatSpan, fpsSeries, hasThrottleData, histogramBuckets, isPowerLimited, isThermal, thermalAlert,
  throttleBands,
} from './insight';
import { parsePerfSummary } from './series';

const X = (t: number, flags: number | null, fps: number | null = null): InsightSample => ({
  t, gpuClockMhz: 1800, throttleFlags: flags, fps, frameTimeMs: fps ? 1000 / fps : null, frameTimeP99Ms: null,
});

describe('throttle flags', () => {
  it('decodes thermal and power bits', () => {
    expect(isThermal(1)).toBe(true);
    expect(isThermal(2)).toBe(true);
    expect(isThermal(4)).toBe(false);
    expect(isThermal(null)).toBe(false);
    expect(isPowerLimited(4)).toBe(true);
    expect(isPowerLimited(8)).toBe(true);
    expect(isPowerLimited(1)).toBe(false);
  });
});

describe('throttleBands', () => {
  it('merges consecutive thermal samples into one band', () => {
    const bands = throttleBands([X(0, 0), X(2000, 1), X(4000, 1 | 4), X(6000, 2), X(8000, 0), X(10000, 1)]);
    expect(bands).toEqual([{ start: 0, end: 6000 }, { start: 8000, end: 10000 }]);
  });

  it('caps a band across a sampling gap and ignores power-only throttling', () => {
    const bands = throttleBands([X(0, 0), X(60000, 1), X(62000, 4)]);
    expect(bands).toEqual([{ start: 55000, end: 60000 }]);
    expect(throttleBands([X(0, 4), X(2000, 8)])).toEqual([]);
  });

  it('sorts unsorted input', () => {
    expect(throttleBands([X(4000, 1), X(2000, 1)])).toEqual([{ start: 0, end: 4000 }]);
  });

  it('knows when throttle data exists at all', () => {
    expect(hasThrottleData([X(0, null)])).toBe(false);
    expect(hasThrottleData([X(0, 0)])).toBe(true);
  });
});

describe('fpsSeries', () => {
  it('keeps gaps as null and drops invalid values', () => {
    expect(fpsSeries([X(2000, 0, 120), X(0, 0, 0), X(4000, 0, null)])).toEqual([
      { t: 0, v: null },
      { t: 2000, v: 120 },
      { t: 4000, v: null },
    ]);
  });
});

describe('histogramBuckets', () => {
  it('labels every bucket and computes shares', () => {
    const hist = Array.from({ length: FRAME_TIME_EDGES_MS.length + 1 }, (_, i) => (i === 3 ? 75 : i === 12 ? 25 : 0));
    const b = histogramBuckets(hist);
    expect(b).toHaveLength(13);
    expect(b[0].label).toBe('<4');
    expect(b[0].fpsLabel).toBe('over 250 fps');
    expect(b[3]).toMatchObject({ label: '8–10', fpsLabel: '100–125 fps', share: 0.75 });
    expect(b[12]).toMatchObject({ label: '100+', fpsLabel: 'under 10 fps', share: 0.25 });
  });

  it('returns nothing for missing or malformed histograms', () => {
    expect(histogramBuckets(null)).toEqual([]);
    expect(histogramBuckets([1, 2, 3])).toEqual([]);
    expect(histogramBuckets(new Array(13).fill(0))).toEqual([]);
  });
});

describe('thermal alert', () => {
  it('appears only for 30 s or more of thermal throttling', () => {
    const base = parsePerfSummary(JSON.stringify({ samples: 10, fpsStatus: 'x', throttledSeconds: 252 }))!;
    expect(thermalAlert(base)).toBe(
      'Your GPU got hot and slowed down for 4m 12s — check airflow, a laptop stand, or a lower power profile in your laptop’s performance app (for example Armoury Crate).',
    );
    expect(thermalAlert({ ...base, throttledSeconds: 29 })).toBeNull();
    expect(thermalAlert({ ...base, throttledSeconds: null })).toBeNull();
    expect(thermalAlert({ ...base, thermalNote: 'Native note.' })).toBe('Native note.');
  });
});

describe('parsePerfSummary (schema v4 fields)', () => {
  it('passes frame and throttle fields through and tolerates their absence', () => {
    const s = parsePerfSummary(JSON.stringify({
      samples: 3, fpsStatus: 'Measured.', fpsAvg: 118.4, fps1Low: 71.2, frameTimeHistogram: [1, 2], throttleReasons: ['thermal', 'nonsense'], stutterCount: 4,
    }))!;
    expect(s.fpsAvg).toBe(118.4);
    expect(s.fps1Low).toBe(71.2);
    expect(s.stutterCount).toBe(4);
    expect(s.frameTimeHistogram).toEqual([1, 2]);
    expect(s.throttleReasons).toEqual(['thermal']);
    const old = parsePerfSummary(JSON.stringify({ samples: 3, fpsStatus: 'Not measured.' }))!;
    expect(old.fpsAvg).toBeNull();
    expect(old.throttledSeconds).toBeNull();
    expect(old.frameTimeHistogram).toBeNull();
  });
});

describe('formatting', () => {
  it('formats spans, fps and ms', () => {
    expect(formatSpan(45)).toBe('45s');
    expect(formatSpan(252)).toBe('4m 12s');
    expect(formatSpan(3780)).toBe('1h 3m');
    expect(formatFps(117.6)).toBe('118');
    expect(formatFps(null)).toBe('—');
    expect(formatMs(8.34)).toBe('8.3 ms');
    expect(formatMs(15.6)).toBe('16 ms');
  });
});
