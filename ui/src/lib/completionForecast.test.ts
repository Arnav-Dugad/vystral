import { describe, expect, it } from 'vitest';
import type { TimeToBeat } from '../bridge/types';
import { aboutSpan, completionForecast, roughDate, spanRange, type Forecast } from './completionForecast';

const H = 3600;
const DAY = 86_400_000;
const NOW = new Date(2026, 9, 7, 20).getTime();
const ttb = (main: number | null, extras: number | null = null, completionist: number | null = null): TimeToBeat => ({
  main, extras, completionist, count: 40, fetched: '2026-10-01T00:00:00Z', source: 'igdb',
});
/** One session of `hours` every `everyDays`, for `count` sessions, newest at `NOW - offsetDays`. */
const cadence = (count: number, hours: number, everyDays = 3, offsetDays = 1) =>
  Array.from({ length: count }, (_, i) => ({ startMs: NOW - (offsetDays + i * everyDays) * DAY, seconds: hours * H }));

const ok = (r: ReturnType<typeof completionForecast>): Forecast => {
  if (!('forecast' in r)) throw new Error(`skipped: ${r.skip}`);
  return r.forecast;
};

describe('completionForecast', () => {
  it('uses sessions per week × average length over the last four weeks', () => {
    // 8 sessions of 1.5 h in 4 weeks → 3 h a week. 20 h main, 8 h played → 12 h left → 4 weeks.
    const f = ok(completionForecast({ played: 8 * H, ttb: ttb(20 * H), sessions: cadence(8, 1.5), now: NOW }));
    expect(f.target).toBe('main');
    expect(f.sessionsPerWeek).toBe(2);
    expect(f.avgSession).toBe(1.5 * H);
    expect(f.weekly).toBe(3 * H);
    expect(f.weeks).toBeCloseTo(4, 9);
    expect(f.weeksLow).toBeLessThan(f.weeks);
    expect(f.weeksHigh).toBeGreaterThan(f.weeks);
    expect(f.steadiness).toBe('steady');
  });

  it('ignores sessions older than four weeks', () => {
    const sessions = [...cadence(4, 2, 2), { startMs: NOW - 40 * DAY, seconds: 50 * H }];
    const f = ok(completionForecast({ played: 10 * H, ttb: ttb(30 * H), sessions, now: NOW }));
    expect(f.weekly).toBe(2 * H);
    expect(f.sessionsInWindow).toBe(4);
  });

  it('widens the range when weeks are uneven', () => {
    const bursty = [...cadence(3, 4, 1, 1), { startMs: NOW - 25 * DAY, seconds: 0.5 * H }];
    const f = ok(completionForecast({ played: 2 * H, ttb: ttb(40 * H), sessions: bursty, now: NOW }));
    expect(f.steadiness).toBe('uneven');
    expect(f.weeksHigh / f.weeksLow).toBeGreaterThan(2);
  });

  it('targets the next estimate once the main story is passed', () => {
    const f = ok(completionForecast({ played: 22 * H, ttb: ttb(20 * H, 30 * H), sessions: cadence(6, 2), now: NOW }));
    expect(f.target).toBe('extras');
    expect(f.remaining).toBe(8 * H);
  });

  it('hides the forecast when data is thin, stale, finished or far off', () => {
    const base = { played: 5 * H, ttb: ttb(20 * H), now: NOW };
    const skip = (r: ReturnType<typeof completionForecast>) => ('skip' in r ? r.skip : 'shown');
    expect(skip(completionForecast({ ...base, sessions: cadence(2, 3) }))).toBe('thin');
    expect(skip(completionForecast({ ...base, sessions: cadence(3, 2, 0) }))).toBe('thin'); // all on one day
    expect(skip(completionForecast({ ...base, sessions: cadence(4, 0.2) }))).toBe('thin'); // under an hour
    expect(skip(completionForecast({ ...base, sessions: cadence(4, 2, 1, 16) }))).toBe('stale');
    expect(skip(completionForecast({ ...base, sessions: cadence(6, 2), status: 'beaten' }))).toBe('finished');
    expect(skip(completionForecast({ ...base, ttb: null, sessions: cadence(6, 2) }))).toBe('noEstimate');
    expect(skip(completionForecast({ ...base, played: 25 * H, sessions: cadence(6, 2) }))).toBe('pastEstimate');
    expect(skip(completionForecast({ ...base, ttb: ttb(500 * H), sessions: cadence(3, 0.5, 5) }))).toBe('tooFar');
  });
});

describe('forecast wording', () => {
  it('rounds to friendly spans', () => {
    expect(aboutSpan(0.1)).toBe('about a day');
    expect(aboutSpan(0.5)).toBe('about 4 days');
    expect(aboutSpan(1.2)).toBe('about a week');
    expect(aboutSpan(3.2)).toBe('about 3 weeks');
    expect(aboutSpan(13)).toBe('about 3 months');
  });

  it('gives ranges in one unit', () => {
    expect(spanRange(0.5, 1.2)).toBe('3–9 days');
    expect(spanRange(2.4, 5.1)).toBe('2–6 weeks');
    expect(spanRange(6, 14)).toBe('1–4 months');
    expect(spanRange(3, 3)).toBe('3–4 weeks');
    // Across units, the low end keeps its own unit instead of being rounded up.
    expect(spanRange(0.3, 3)).toBe('2 days – 3 weeks');
    expect(spanRange(2, 14)).toBe('2 weeks – 4 months');
  });

  it('names a rough date', () => {
    expect(roughDate(NOW, 2)).toMatch(/^(early|mid|late) /);
  });
});
