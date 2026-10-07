import { describe, expect, it } from 'vitest';
import { cellIndex, dayPart, hourOfWeek, moveCell, primeTime, splitAcrossHours, weekdayOrder } from './hourOfWeek';
import type { JSession } from './stats';

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
let seq = 0;
const s = (start: number, seconds: number, gameId = 'g'): JSession => ({ id: `s${++seq}`, gameId, startMs: start, seconds, hasMetrics: false, source: 'tracked' });
const H = 3600;

describe('splitAcrossHours', () => {
  it('splits at local hour boundaries', () => {
    const parts = splitAcrossHours(at(2026, 3, 7, 22, 40), 2 * H + 35 * 60); // 22:40 → 01:15
    expect(parts.map((p) => [new Date(p.hourStart).getHours(), p.seconds / 60])).toEqual([[22, 20], [23, 60], [0, 60], [1, 15]]);
    expect(parts.reduce((a, p) => a + p.seconds, 0)).toBe(2 * H + 35 * 60);
  });

  it('ignores empty and invalid sessions', () => {
    expect(splitAcrossHours(at(2026, 3, 7), 0)).toEqual([]);
    expect(splitAcrossHours(Number.NaN, 60)).toEqual([]);
  });

  it('keeps every real second across DST changes', () => {
    // Whatever the machine's zone does on these dates, nothing is lost or double-counted.
    for (const start of [at(2026, 3, 29, 0, 30), at(2026, 10, 25, 0, 30), at(2026, 3, 8, 0, 30), at(2026, 11, 1, 0, 30)]) {
      const parts = splitAcrossHours(start, 4 * H);
      expect(parts.reduce((a, p) => a + p.seconds, 0)).toBeCloseTo(4 * H, 6);
      for (const p of parts) expect(new Date(p.hourStart).getMinutes()).toBe(0);
    }
  });
});

describe('hourOfWeek', () => {
  it('bins seconds by local weekday and hour, wrapping Saturday night into Sunday', () => {
    const sat = at(2026, 3, 7, 23, 30); // 7 March 2026 is a Saturday
    expect(new Date(sat).getDay()).toBe(6);
    const grid = hourOfWeek([s(sat, H), s(at(2026, 3, 10, 9), 30 * 60)]);
    expect(grid.seconds[cellIndex(6, 23)]).toBe(30 * 60);
    expect(grid.seconds[cellIndex(0, 0)]).toBe(30 * 60);
    expect(grid.seconds[cellIndex(2, 9)]).toBe(30 * 60);
    expect(grid.total).toBe(1.5 * H);
    expect(grid.sessionCount).toBe(2);
    expect(grid.sessions[cellIndex(6, 23)]).toBe(1);
  });
});

describe('primeTime', () => {
  it('finds the busiest three-hour window, including across midnight', () => {
    const sessions = [
      s(at(2026, 3, 6, 23), 2 * H), // Fri 23:00 → Sat 01:00
      s(at(2026, 3, 13, 23), 2 * H),
      s(at(2026, 3, 11, 18), H), // a quieter Wednesday
    ];
    const p = primeTime(hourOfWeek(sessions))!;
    expect(p.weekday).toBe(5);
    expect(p.startHour).toBe(23);
    expect(p.hours).toBe(2); // the empty 22:00 hour is trimmed
    expect(p.seconds).toBe(4 * H);
    expect(p.share).toBeCloseTo(0.8, 6);
  });

  it('is null with too little play', () => {
    expect(primeTime(hourOfWeek([s(at(2026, 3, 6, 20), H)]))).toBeNull();
    expect(primeTime(hourOfWeek([]))).toBeNull();
  });

  it('names the part of the day by the window middle', () => {
    expect(dayPart(20, 3)).toBe('evening');
    expect(dayPart(23, 3)).toBe('night');
    expect(dayPart(8, 3)).toBe('morning');
    expect(dayPart(13, 3)).toBe('afternoon');
  });
});

describe('grid helpers', () => {
  it('orders rows from the week start and moves with the arrow keys', () => {
    expect(weekdayOrder(1)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(moveCell(0, 0, 'ArrowLeft')).toEqual({ row: 0, col: 0 });
    expect(moveCell(6, 23, 'ArrowDown')).toEqual({ row: 6, col: 23 });
    expect(moveCell(2, 5, 'End')).toEqual({ row: 2, col: 23 });
    expect(moveCell(2, 5, 'x')).toBeNull();
  });
});
