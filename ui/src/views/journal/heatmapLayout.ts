/**
 * Pure layout and maths for the Journal's play calendar (a GitHub-style year grid).
 * Rows are weekdays (starting on the locale's first day of the week), columns are weeks.
 * Only VYSTRAL-tracked sessions have dates, so only they appear here.
 */
import { addDays, daysBetween, splitAcrossDays, startOfDay, type JSession } from './stats';

export type HeatRange = 'past' | number;
export type Level = 0 | 1 | 2 | 3 | 4;

export interface HeatDay {
  day: number;
  seconds: number;
  sessions: number;
  /** Games played that day, most time first. */
  games: { gameId: string; seconds: number }[];
}

export interface HeatCell {
  day: number;
  col: number;
  row: number;
  /** Inside the selected range (cells before the range start only pad the first week). */
  inRange: boolean;
  /** After today: shown faintly, not focusable. */
  future: boolean;
}

export interface HeatLayout {
  start: number;
  end: number;
  cols: number;
  /** Row-major: rows[weekdayRow][col]. */
  rows: HeatCell[][];
  months: { col: number; month: number; year: number }[];
  /** JS weekday (0 = Sunday) of each row. */
  weekdays: number[];
}

/** First day of the week for a locale, as a JS weekday (0 = Sunday … 6 = Saturday). Monday when unknown. */
export function weekStartDay(locale?: string): number {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : undefined) ?? 'en-GB';
    const loc = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = typeof loc.getWeekInfo === 'function' ? loc.getWeekInfo() : loc.weekInfo;
    const first = info?.firstDay;
    if (typeof first === 'number' && first >= 1 && first <= 7) return first % 7;
  } catch {
    // Unknown locale tag: fall back to Monday.
  }
  return 1;
}

/** Inclusive local-midnight bounds of a range: the past 365 days, or a calendar year. */
export function rangeBounds(range: HeatRange, now: number): { start: number; end: number } {
  const today = startOfDay(now);
  if (range === 'past') return { start: addDays(today, -364), end: today };
  return { start: new Date(range, 0, 1).getTime(), end: new Date(range, 11, 31).getTime() };
}

/** Per-day totals. A session that runs past midnight counts toward both days. */
export function dayStats(sessions: readonly JSession[]): Map<number, HeatDay> {
  const map = new Map<number, HeatDay>();
  const perGame = new Map<number, Map<string, number>>();
  for (const s of sessions) {
    const startDay = startOfDay(s.startMs);
    for (const part of splitAcrossDays(s.startMs, s.seconds)) {
      let d = map.get(part.dayStart);
      if (!d) map.set(part.dayStart, (d = { day: part.dayStart, seconds: 0, sessions: 0, games: [] }));
      d.seconds += part.seconds;
      if (part.dayStart === startDay) d.sessions++;
      let g = perGame.get(part.dayStart);
      if (!g) perGame.set(part.dayStart, (g = new Map()));
      g.set(s.gameId, (g.get(s.gameId) ?? 0) + part.seconds);
    }
  }
  for (const [day, games] of perGame) {
    map.get(day)!.games = [...games.entries()].map(([gameId, seconds]) => ({ gameId, seconds })).sort((a, b) => b.seconds - a.seconds || a.gameId.localeCompare(b.gameId));
  }
  return map;
}

/** Calendar years that have at least one tracked day, newest first. */
export function yearsWithData(days: Iterable<number>): number[] {
  const set = new Set<number>();
  for (const d of days) set.add(new Date(d).getFullYear());
  return [...set].sort((a, b) => b - a);
}

export function layout(range: HeatRange, now: number, weekStart: number): HeatLayout {
  const { start, end } = rangeBounds(range, now);
  const today = startOfDay(now);
  const lead = (new Date(start).getDay() - weekStart + 7) % 7;
  const gridStart = addDays(start, -lead);
  const total = daysBetween(gridStart, end) + 1;
  const cols = Math.ceil(total / 7);
  const weekdays = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const rows: HeatCell[][] = weekdays.map(() => []);
  const months: HeatLayout['months'] = [];
  let lastMonthCol = -10;
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < 7; r++) {
      const day = addDays(gridStart, c * 7 + r);
      if (day > end) continue;
      const inRange = day >= start;
      rows[r].push({ day, col: c, row: r, inRange, future: day > today });
      const d = new Date(day);
      // A month label sits over the first column that contains the month's first in-range day.
      if (inRange && (d.getDate() === 1 || day === start)) {
        if (c - lastMonthCol >= 3) {
          months.push({ col: c, month: d.getMonth(), year: d.getFullYear() });
          lastMonthCol = c;
        } else if (d.getDate() === 1 && months.length) {
          // Too close to the previous label (range started late in a month): the new month wins.
          months[months.length - 1] = { col: c, month: d.getMonth(), year: d.getFullYear() };
          lastMonthCol = c;
        }
      }
    }
  }
  return { start, end, cols, rows, months, weekdays };
}

const NICE = [5, 10, 15, 20, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480, 600, 720, 960];
const FALLBACK: [number, number, number] = [30, 90, 180];

/**
 * Minute thresholds between levels 1–2, 2–3 and 3–4: the quartiles of the active days in view,
 * rounded up to friendly numbers and strictly increasing. Fixed 30/90/180 min with fewer than 8 active days.
 */
export function thresholds(minutes: readonly number[]): [number, number, number] {
  const v = minutes.filter((m) => m > 0).sort((a, b) => a - b);
  if (v.length < 8) return FALLBACK;
  const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))];
  const out: number[] = [];
  for (const raw of [q(0.25), q(0.5), q(0.75)]) {
    let nice = NICE.find((n) => n >= raw) ?? NICE[NICE.length - 1];
    const prev = out[out.length - 1];
    if (prev != null && nice <= prev) nice = NICE.find((n) => n > prev) ?? prev + 60;
    out.push(nice);
  }
  return out as [number, number, number];
}

export function levelFor(seconds: number, th: readonly [number, number, number]): Level {
  if (!(seconds > 0)) return 0;
  const m = seconds / 60;
  if (m <= th[0]) return 1;
  if (m <= th[1]) return 2;
  if (m <= th[2]) return 3;
  return 4;
}

export interface StreakInfo {
  daysPlayed: number;
  seconds: number;
  longest: number;
  /** Days in a row ending today (or yesterday, so it isn't "broken" before today's session); null for past years. */
  current: number | null;
}

export function rangeStreaks(days: ReadonlyMap<number, HeatDay>, start: number, end: number, now: number): StreakInfo {
  const today = startOfDay(now);
  const played = [...days.keys()].filter((d) => d >= start && d <= end).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev: number | null = null;
  let seconds = 0;
  for (const d of played) {
    run = prev != null && addDays(prev, 1) === d ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = d;
    seconds += days.get(d)!.seconds;
  }
  let current: number | null = null;
  if (today >= start && today <= end) {
    const set = new Set(played);
    let cursor = set.has(today) ? today : addDays(today, -1);
    current = 0;
    while (set.has(cursor) && cursor >= start) {
      current++;
      cursor = addDays(cursor, -1);
    }
  }
  return { daysPlayed: played.length, seconds, longest, current };
}

/** Keyboard movement in the grid: ←/→ a week, ↑/↓ a day, Home/End the range ends, PageUp/PageDown a month. */
export function moveDay(day: number, key: string, first: number, last: number): number | null {
  let next: number;
  switch (key) {
    case 'ArrowLeft': next = addDays(day, -7); break;
    case 'ArrowRight': next = addDays(day, 7); break;
    case 'ArrowUp': next = addDays(day, -1); break;
    case 'ArrowDown': next = addDays(day, 1); break;
    case 'Home': next = first; break;
    case 'End': next = last; break;
    case 'PageUp':
    case 'PageDown': {
      const d = new Date(day);
      d.setMonth(d.getMonth() + (key === 'PageUp' ? -1 : 1));
      next = startOfDay(d.getTime());
      break;
    }
    default: return null;
  }
  return Math.min(last, Math.max(first, next));
}
