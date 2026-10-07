/**
 * Track Y: playtime by hour of the week. Sessions are split at every local hour boundary, so a session
 * from 22:40 to 01:15 adds 20 minutes to 22:00, an hour to 23:00 and 1h 15m across Sunday/Monday. All
 * maths uses the PC's time zone. Hours are stepped by real time (+1h, then floored to the local hour),
 * so DST days stay right: the repeated autumn hour gets both real hours, the skipped spring hour none.
 */
import type { JSession } from './stats';

export const HOURS = 24;
export const DAYS = 7;
const HOUR_MS = 3_600_000;

/** Index into the 7×24 grid: JS weekday (0 = Sunday) × 24 + local hour. */
export const cellIndex = (weekday: number, hour: number) => weekday * HOURS + hour;

function floorHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/** Splits one session into local clock hours: [hourStartMs, seconds][]. */
export function splitAcrossHours(startMs: number, seconds: number): { hourStart: number; seconds: number }[] {
  if (!(seconds > 0) || !Number.isFinite(startMs)) return [];
  const out: { hourStart: number; seconds: number }[] = [];
  const end = startMs + seconds * 1000;
  let cursor = startMs;
  let guard = 0;
  while (cursor < end && guard++ < 24 * 400) {
    const hourStart = floorHour(cursor);
    let next = floorHour(hourStart + HOUR_MS);
    if (next <= cursor) next = cursor + HOUR_MS; // defensive: never loop on odd zone data
    const sliceEnd = Math.min(end, next);
    out.push({ hourStart, seconds: (sliceEnd - cursor) / 1000 });
    cursor = sliceEnd;
  }
  return out;
}

export interface HourGrid {
  /** Seconds per cell (length 168), index = weekday × 24 + hour. */
  seconds: number[];
  /** Distinct sessions touching each cell. */
  sessions: number[];
  total: number;
  sessionCount: number;
}

export function hourOfWeek(sessions: readonly JSession[]): HourGrid {
  const seconds = new Array<number>(DAYS * HOURS).fill(0);
  const counts = new Array<number>(DAYS * HOURS).fill(0);
  let total = 0;
  let sessionCount = 0;
  for (const s of sessions) {
    const parts = splitAcrossHours(s.startMs, s.seconds);
    if (!parts.length) continue;
    sessionCount++;
    const touched = new Set<number>();
    for (const p of parts) {
      const d = new Date(p.hourStart);
      const i = cellIndex(d.getDay(), d.getHours());
      seconds[i] += p.seconds;
      total += p.seconds;
      touched.add(i);
    }
    for (const i of touched) counts[i]++;
  }
  return { seconds, sessions: counts, total, sessionCount };
}

export interface PrimeTime {
  weekday: number;
  startHour: number;
  /** Window length in hours. */
  hours: number;
  seconds: number;
  /** Share of all play in this window, 0–1. */
  share: number;
}

/**
 * The busiest `hours`-long window of the week. It may wrap past midnight into the next day (and from
 * Saturday into Sunday); ties go to the earliest window. Null without enough play to mean anything.
 */
export function primeTime(grid: HourGrid, hours = 3, minSeconds = 2 * 3600, minSessions = 3): PrimeTime | null {
  if (grid.total < minSeconds || grid.sessionCount < minSessions) return null;
  const n = grid.seconds.length;
  let best = -1;
  let bestAt = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < hours; k++) sum += grid.seconds[(i + k) % n];
    if (sum > best + 1e-9) {
      best = sum;
      bestAt = i;
    }
  }
  if (best <= 0) return null;
  // Trim quiet edge hours, so a two-hour habit reads "11 pm – 1 am", not "10 pm – 1 am".
  let start = bestAt;
  let len = hours;
  const quiet = (i: number) => grid.seconds[i % n] < best * 0.1;
  while (len > 1 && quiet(start)) {
    start = (start + 1) % n;
    len--;
  }
  while (len > 1 && quiet(start + len - 1)) len--;
  return { weekday: Math.floor(start / HOURS), startHour: start % HOURS, hours: len, seconds: best, share: best / grid.total };
}

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

/** The part of the day a window mostly sits in (by its middle hour). */
export function dayPart(startHour: number, hours: number): DayPart {
  const mid = (startHour + hours / 2) % 24;
  if (mid >= 5 && mid < 12) return 'morning';
  if (mid >= 12 && mid < 17) return 'afternoon';
  if (mid >= 17 && mid < 22) return 'evening';
  return 'night';
}

/** Rows in the locale's week order, starting at `weekStart` (0 = Sunday). */
export function weekdayOrder(weekStart: number): number[] {
  return Array.from({ length: DAYS }, (_, i) => (weekStart + i) % DAYS);
}

/** Arrow-key movement inside the grid (row = position in weekdayOrder, col = hour). Null when the key isn't handled. */
export function moveCell(row: number, col: number, key: string): { row: number; col: number } | null {
  switch (key) {
    case 'ArrowRight': return { row, col: Math.min(HOURS - 1, col + 1) };
    case 'ArrowLeft': return { row, col: Math.max(0, col - 1) };
    case 'ArrowDown': return { row: Math.min(DAYS - 1, row + 1), col };
    case 'ArrowUp': return { row: Math.max(0, row - 1), col };
    case 'Home': return { row, col: 0 };
    case 'End': return { row, col: HOURS - 1 };
    default: return null;
  }
}
