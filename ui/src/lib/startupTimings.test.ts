import { describe, expect, it } from 'vitest';
import type { StartupRun } from '../bridge/types.trackC2';
import { formatStartup, median, phasesOf, regressionText, summarize, totalOf } from './startupTimings';
import { previewStartupRuns } from '../bridge/preview.trackC2';

const run = (readyMs: number, extra: Partial<StartupRun> = {}): StartupRun => ({
  at: '2026-10-09T08:00:00Z', backendMs: 250, webViewMs: 620, firstPaintMs: 900, readyMs, cachedFirstPaint: true, ...extra,
});

describe('startup timings', () => {
  it('splits a start into four stacked phases', () => {
    const p = phasesOf(run(1400));
    expect(p.map((x) => x.ms)).toEqual([250, 370, 280, 500]);
    expect(p[3].to).toBe(1400);
    expect(totalOf(run(1400))).toBe(1400);
  });

  it('never makes a negative or out-of-order phase', () => {
    const p = phasesOf(run(800, { webViewMs: 100, firstPaintMs: Number.NaN }));
    expect(p.every((x) => x.ms >= 0)).toBe(true);
    expect(p.map((x) => x.to)).toEqual([250, 250, 250, 800]);
  });

  it('medians', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('flags the newest start only when it is much slower than usual', () => {
    const usual = [1300, 1400, 1450, 1380, 1420].map((ms) => run(ms));
    expect(summarize([...usual, run(1600)]).regression).toBeNull(); // a little slower
    expect(summarize([...usual, run(1900)]).regression).toBeNull(); // 1.36×: not "much"
    const slow = summarize([...usual, run(4200, { firstPaintMs: 2500 })]);
    expect(slow.regression).not.toBeNull();
    expect(slow.regression!.baselineMs).toBe(1400);
    expect(slow.regression!.factor).toBeCloseTo(3, 5);
    expect(slow.regression!.phase).toBe('firstPaint');
    expect(regressionText(slow.regression!, 4200)).toContain('3.0× your usual 1.40 s');
  });

  it('needs a few earlier starts and a real absolute difference', () => {
    expect(summarize([run(1000), run(1000), run(5000)]).regression).toBeNull();
    // 400 ms → 800 ms is twice as long but under the 700 ms floor.
    expect(summarize([400, 400, 400, 400, 800].map((ms) => run(ms, { backendMs: 100, webViewMs: 200, firstPaintMs: 300 }))).regression).toBeNull();
  });

  it('summarises', () => {
    const s = summarize([run(1500), run(1200), run(1300)]);
    expect(s.count).toBe(3);
    expect(s.median).toBe(1350); // the starts before the newest
    expect(s.fastestMs).toBe(1200);
    expect(s.latestMs).toBe(1300);
    expect(summarize([]).latest).toBeNull();
  });

  it('formats', () => {
    expect(formatStartup(860)).toBe('860 ms');
    expect(formatStartup(1423)).toBe('1.42 s');
    expect(formatStartup(null)).toBe('—');
  });

  it('preview runs are well-formed, and ?startupSlow makes the last one a regression', () => {
    const runs = previewStartupRuns(Date.UTC(2026, 9, 10));
    expect(runs).toHaveLength(20);
    expect(runs.every((r) => r.backendMs <= r.webViewMs && r.webViewMs <= r.firstPaintMs && r.firstPaintMs <= r.readyMs)).toBe(true);
    expect(summarize(runs).regression).toBeNull();
    expect(summarize(previewStartupRuns(Date.UTC(2026, 9, 10), true)).regression).not.toBeNull();
  });
});
