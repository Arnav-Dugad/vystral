import { describe, expect, it } from 'vitest';
import type { DriverGameComparison, DriverSide } from '../../bridge/types';
import { driverDelta, driverHeadline, formatMb, formatPct, presence, suspectReason } from './dataInsights';

const side = (version: string, fpsAvg: number | null, fps1Low: number | null, p99: number | null): DriverSide => ({
  version, gpuName: 'RTX', sessions: 4, fpsAvg, fps1Low, frameTimeP99Ms: p99, from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z',
});
const cmp = (before: DriverSide, after: DriverSide): DriverGameComparison => ({ gameId: 'g', before, after, changedAt: after.from, smallSample: false, gpuChanged: false });

describe('driverDelta', () => {
  it('knows that FPS is better higher and frame time better lower', () => {
    expect(driverDelta(100, 110, 'higher').verdict).toBe('better');
    expect(driverDelta(100, 90, 'higher').verdict).toBe('worse');
    expect(driverDelta(14, 12, 'lower').verdict).toBe('better');
    expect(driverDelta(14, 16, 'lower').verdict).toBe('worse');
  });

  it('treats small changes as noise and missing data as unknown', () => {
    expect(driverDelta(100, 102, 'higher')).toMatchObject({ verdict: 'same', diff: 2 });
    expect(driverDelta(null, 102, 'higher').verdict).toBe('unknown');
    expect(driverDelta(0, 5, 'higher').verdict).toBe('unknown');
  });

  it('formats percentages with a real minus sign', () => {
    expect(formatPct(4.24)).toBe('+4.2%');
    expect(formatPct(-12.6)).toBe('−13%');
    expect(formatPct(0)).toBe('±0.0%');
    expect(formatPct(null)).toBe('—');
  });
});

describe('driverHeadline', () => {
  it('describes the main change honestly', () => {
    expect(driverHeadline(cmp(side('a', 100, 70, 14), side('b', 120, 80, 12)))).toBe('Higher average frame rate since the driver change (+20%).');
    expect(driverHeadline(cmp(side('a', 100, 70, 14), side('b', 101, 71, 14)))).toBe('About the same frame rate on both drivers.');
    expect(driverHeadline(cmp(side('a', 100, 70, 14), side('b', 101, 60, 16)))).toBe('Lower 1% lows since the driver change (−14%).');
    expect(driverHeadline(cmp(side('a', null, null, null), side('b', 101, 60, 16)))).toBe('Not enough frame-rate data to compare.');
  });
});

describe('background app formatting', () => {
  it('formats memory and presence', () => {
    expect(formatMb(640.4)).toBe('640 MB');
    expect(formatMb(1536)).toBe('1.5 GB');
    expect(formatMb(20480)).toBe('20 GB');
    expect(formatMb(null)).toBe('—');
    expect(presence(0.625)).toBe('63%');
    expect(
      suspectReason({ name: 'obs64.exe', displayName: 'obs64', sessions: 4, presence: 0.5, roughPresence: 1, cleanPresence: 0.25, lift: 0.75, avgMb: 700, maxMb: 900, avgCpu: 12 }, 'memory'),
    ).toBe('Running in 100% of sessions where memory was nearly full, 25% of the others');
  });
});
