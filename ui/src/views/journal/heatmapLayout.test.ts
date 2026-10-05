import { describe, expect, it } from 'vitest';
import type { JSession } from './stats';
import { dayStats, layout, levelFor, moveDay, rangeBounds, rangeStreaks, thresholds, weekStartDay, yearsWithData } from './heatmapLayout';

const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m, d, h, min).getTime();
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime();
let seq = 0;
const s = (startMs: number, seconds: number, gameId = 'g1'): JSession => ({ id: `s${++seq}`, gameId, startMs, seconds, hasMetrics: false });

describe('week start', () => {
  it('follows the locale and falls back to Monday', () => {
    expect([0, 1]).toContain(weekStartDay('en-US')); // Sunday where the engine knows week info
    expect(weekStartDay('de-DE')).toBe(1);
    expect(weekStartDay('not a locale!!')).toBe(1);
  });
});

describe('layout', () => {
  it('builds a 53-column calendar year with Monday rows', () => {
    const l = layout(2026, at(2026, 9, 5), 1);
    // 1 Jan 2026 is a Thursday: three padding days before it in the first Monday-based week.
    expect(l.cols).toBe(53);
    expect(l.weekdays).toEqual([1, 2, 3, 4, 5, 6, 0]);
    const first = l.rows.flat().filter((c) => c.inRange).sort((a, b) => a.day - b.day)[0];
    expect(first).toMatchObject({ day: day(2026, 0, 1), col: 0, row: 3 });
    expect(l.rows.flat().filter((c) => c.inRange)).toHaveLength(365);
    expect(l.rows.flat().find((c) => c.day === day(2026, 11, 31))!.future).toBe(true);
    expect(l.rows.flat().find((c) => c.day === day(2026, 9, 5))!.future).toBe(false);
    expect(l.months.map((m) => m.month)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('needs 54 columns for a leap year that starts on the last weekday', () => {
    // 2000 started on a Saturday and had 366 days: with Sunday-first weeks it spans 54 columns.
    expect(layout(2000, at(2026, 0, 1), 0).cols).toBe(54);
  });

  it('covers the past 365 days ending today', () => {
    const now = at(2026, 9, 5, 21);
    const { start, end } = rangeBounds('past', now);
    expect(end).toBe(day(2026, 9, 5));
    expect(start).toBe(day(2025, 9, 6));
    const l = layout('past', now, 0);
    const cells = l.rows.flat().filter((c) => c.inRange);
    expect(cells).toHaveLength(365);
    expect(cells.every((c) => !c.future)).toBe(true);
    // Every column holds at most 7 days, every row at most one per column.
    for (const row of l.rows) expect(new Set(row.map((c) => c.col)).size).toBe(row.length);
  });
});

describe('quantisation', () => {
  it('uses fixed thresholds for sparse data', () => {
    expect(thresholds([10, 200])).toEqual([30, 90, 180]);
  });

  it('uses rounded quartiles that always increase', () => {
    const th = thresholds([12, 18, 25, 40, 55, 70, 95, 130, 200, 260]);
    expect(th).toEqual([30, 60, 120]);
    const flat = thresholds(Array(12).fill(60));
    expect(flat[0]).toBeLessThan(flat[1]);
    expect(flat[1]).toBeLessThan(flat[2]);
  });

  it('maps minutes to five levels', () => {
    const th: [number, number, number] = [30, 90, 180];
    expect([0, 60, 30 * 60, 31 * 60, 90 * 60, 120 * 60, 600 * 60].map((sec) => levelFor(sec, th))).toEqual([0, 1, 1, 2, 2, 3, 4]);
  });
});

describe('day stats and streaks', () => {
  it('splits sessions at midnight and lists games by time', () => {
    const days = dayStats([s(at(2026, 2, 1, 23, 30), 3600, 'a'), s(at(2026, 2, 1, 10), 600, 'b'), s(at(2026, 2, 1, 12), 300, 'a')]);
    const d1 = days.get(day(2026, 2, 1))!;
    expect(d1.seconds).toBe(1800 + 600 + 300);
    expect(d1.sessions).toBe(3);
    expect(d1.games.map((g) => g.gameId)).toEqual(['a', 'b']);
    const d2 = days.get(day(2026, 2, 2))!;
    expect(d2).toMatchObject({ seconds: 1800, sessions: 0 });
    expect(yearsWithData(days.keys())).toEqual([2026]);
  });

  it('computes current and longest streaks inside the range', () => {
    const now = at(2026, 2, 10, 9);
    const days = dayStats([
      s(at(2026, 2, 1), 600), s(at(2026, 2, 2), 600), s(at(2026, 2, 3), 600), s(at(2026, 2, 4), 600),
      s(at(2026, 2, 8), 600), s(at(2026, 2, 9), 600), // today (10th) not played yet: streak continues from yesterday
    ]);
    const { start, end } = rangeBounds('past', now);
    expect(rangeStreaks(days, start, end, now)).toEqual({ daysPlayed: 6, seconds: 3600, longest: 4, current: 2 });
    const past = rangeBounds(2025, now);
    expect(rangeStreaks(days, past.start, past.end, now)).toEqual({ daysPlayed: 0, seconds: 0, longest: 0, current: null });
  });
});

describe('keyboard movement', () => {
  const first = day(2026, 0, 1);
  const last = day(2026, 9, 5);
  it('moves by day, week and month and stays inside the range', () => {
    const d = day(2026, 2, 10);
    expect(moveDay(d, 'ArrowDown', first, last)).toBe(day(2026, 2, 11));
    expect(moveDay(d, 'ArrowUp', first, last)).toBe(day(2026, 2, 9));
    expect(moveDay(d, 'ArrowRight', first, last)).toBe(day(2026, 2, 17));
    expect(moveDay(d, 'ArrowLeft', first, last)).toBe(day(2026, 2, 3));
    expect(moveDay(d, 'PageDown', first, last)).toBe(day(2026, 3, 10));
    expect(moveDay(first, 'ArrowLeft', first, last)).toBe(first);
    expect(moveDay(last, 'ArrowRight', first, last)).toBe(last);
    expect(moveDay(d, 'Home', first, last)).toBe(first);
    expect(moveDay(d, 'End', first, last)).toBe(last);
    expect(moveDay(d, 'a', first, last)).toBeNull();
  });
});
