/**
 * Pure computations for the Gaming Journal. Everything here works on sessions VYSTRAL
 * recorded itself (source 'tracked', 'detected' or 'background'); store-imported playtime never enters these numbers.
 * All calendar maths uses the user's local time zone and is DST-safe (days are stepped
 * with Date#setDate, never by adding 24h).
 */
import type { Session } from '../../bridge/types';
import { isObserved, type ObservedSource } from '../../lib/sessions';

export type Range = 'week' | 'month' | 'year' | 'all';

/** Rolling window length per range (today included). */
export const RANGE_DAYS: Record<Exclude<Range, 'all'>, number> = { week: 7, month: 30, year: 365 };

const DAY_MS = 86_400_000;

/** A tracked session reduced to what the journal needs, with the start parsed once. */
export interface JSession {
  id: string;
  gameId: string;
  startMs: number;
  seconds: number;
  hasMetrics: boolean;
  /** Track H: how VYSTRAL noticed the game (launched, detected while open, background tracker). */
  source: ObservedSource;
}

export function normalizeSessions(list: readonly Session[]): JSession[] {
  const out: JSession[] = [];
  for (const s of list) {
    if (!isObserved(s.source)) continue;
    const startMs = Date.parse(s.start);
    if (!Number.isFinite(startMs)) continue;
    const seconds = Number.isFinite(s.durationSeconds) && s.durationSeconds > 0 ? s.durationSeconds : 0;
    out.push({ id: s.id, gameId: s.gameId, startMs, seconds, hasMetrics: !!s.perfSummary, source: s.source });
  }
  return out.sort((a, b) => b.startMs - a.startMs);
}

/* ---------------------------------------------------------------- calendar helpers */

export function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(ms: number, n: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** Whole calendar days from a to b (both local midnights); robust to 23h/25h DST days. */
export function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
}

/** Splits a session at local midnights so play after 00:00 counts for the next day. */
export function splitAcrossDays(startMs: number, seconds: number): { dayStart: number; seconds: number }[] {
  if (!(seconds > 0)) return [{ dayStart: startOfDay(startMs), seconds: 0 }];
  const out: { dayStart: number; seconds: number }[] = [];
  const end = startMs + seconds * 1000;
  let cursor = startMs;
  while (cursor < end) {
    const dayStart = startOfDay(cursor);
    const sliceEnd = Math.min(end, addDays(dayStart, 1));
    out.push({ dayStart, seconds: (sliceEnd - cursor) / 1000 });
    cursor = sliceEnd;
  }
  return out;
}

/** Seconds played per local day (key = local midnight in ms). Days with a 0s session are kept. */
export function dailyTotals(sessions: readonly JSession[]): Map<number, number> {
  const map = new Map<number, number>();
  for (const s of sessions) for (const part of splitAcrossDays(s.startMs, s.seconds)) map.set(part.dayStart, (map.get(part.dayStart) ?? 0) + part.seconds);
  return map;
}

/* ---------------------------------------------------------------- ranges & totals */

export function rangeStart(range: Range, now: number): number {
  if (range === 'all') return Number.NEGATIVE_INFINITY;
  return addDays(startOfDay(now), -(RANGE_DAYS[range] - 1));
}

/** Sessions that started inside the rolling window. */
export function inRange(sessions: readonly JSession[], range: Range, now: number): JSession[] {
  if (range === 'all') return sessions.slice();
  const from = rangeStart(range, now);
  return sessions.filter((s) => s.startMs >= from);
}

export interface Totals {
  seconds: number;
  sessions: number;
  games: number;
  activeDays: number;
  longest: JSession | null;
}

export function computeTotals(sessions: readonly JSession[]): Totals {
  let seconds = 0;
  let longest: JSession | null = null;
  const games = new Set<string>();
  for (const s of sessions) {
    seconds += s.seconds;
    games.add(s.gameId);
    if (!longest || s.seconds > longest.seconds) longest = s;
  }
  return { seconds, sessions: sessions.length, games: games.size, activeDays: dailyTotals(sessions).size, longest };
}

/**
 * Consecutive days with at least one tracked session, ending today — or yesterday, so a
 * streak isn't shown as broken before today's session has happened.
 */
export function currentStreak(sessions: readonly JSession[], now: number): number {
  const days = new Set(dailyTotals(sessions).keys());
  let cursor = startOfDay(now);
  if (!days.has(cursor)) cursor = addDays(cursor, -1);
  let n = 0;
  while (days.has(cursor)) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

export function longestStreak(sessions: readonly JSession[]): { days: number; endDay: number | null } {
  const days = [...dailyTotals(sessions).keys()].sort((a, b) => a - b);
  let best = 0;
  let bestEnd: number | null = null;
  let run = 0;
  let prev: number | null = null;
  for (const d of days) {
    run = prev != null && addDays(prev, 1) === d ? run + 1 : 1;
    if (run > best) {
      best = run;
      bestEnd = d;
    }
    prev = d;
  }
  return { days: best, endDay: bestEnd };
}

/* ---------------------------------------------------------------- chart buckets */

export interface Bucket {
  /** Local midnight that opens the bucket. */
  start: number;
  /** Exclusive end (local midnight). */
  end: number;
  seconds: number;
  sessions: number;
}

/**
 * Play time per bucket for the selected range. Week/month/year are daily bars over the last
 * 7/30/365 days; all-time is daily while the history fits in a year, weekly beyond that.
 * Buckets are aligned so the last one ends today.
 */
export function playtimeBuckets(sessions: readonly JSession[], range: Range, now: number): { buckets: Bucket[]; unit: 'day' | 'week' } {
  const today = startOfDay(now);
  let first: number;
  if (range === 'all') {
    let earliest = today;
    for (const s of sessions) earliest = Math.min(earliest, startOfDay(s.startMs));
    first = Math.min(earliest, addDays(today, -29));
  } else {
    first = rangeStart(range, now);
  }
  const dayCount = daysBetween(first, today) + 1;
  const size = dayCount > 366 ? 7 : 1;
  const count = Math.ceil(dayCount / size);
  const buckets: Bucket[] = [];
  for (let j = 0; j < count; j++) {
    const start = addDays(today, -((count - 1 - j) * size + (size - 1)));
    buckets.push({ start, end: addDays(start, size), seconds: 0, sessions: 0 });
  }
  const indexOf = (dayStart: number) => {
    const back = daysBetween(dayStart, today);
    if (back < 0) return -1;
    const j = count - 1 - Math.floor(back / size);
    return j >= 0 ? j : -1;
  };
  for (const s of sessions) {
    const j = indexOf(startOfDay(s.startMs));
    if (j >= 0) buckets[j].sessions++;
    for (const part of splitAcrossDays(s.startMs, s.seconds)) {
      const k = indexOf(part.dayStart);
      if (k >= 0) buckets[k].seconds += part.seconds;
    }
  }
  return { buckets, unit: size === 1 ? 'day' : 'week' };
}

/* ---------------------------------------------------------------- games & genres */

export interface GameTotal {
  gameId: string;
  seconds: number;
  sessions: number;
  lastMs: number;
}

export function topGames(sessions: readonly JSession[], limit = Number.POSITIVE_INFINITY): GameTotal[] {
  const map = new Map<string, GameTotal>();
  for (const s of sessions) {
    const g = map.get(s.gameId);
    if (g) {
      g.seconds += s.seconds;
      g.sessions++;
      g.lastMs = Math.max(g.lastMs, s.startMs);
    } else {
      map.set(s.gameId, { gameId: s.gameId, seconds: s.seconds, sessions: 1, lastMs: s.startMs });
    }
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds || b.lastMs - a.lastMs).slice(0, limit);
}

export interface GenreTotal {
  genre: string;
  seconds: number;
  games: number;
}

/**
 * Tracked time per genre. A game counts fully toward each of its genres (so genre totals
 * can add up to more than total play time); games without genres are skipped.
 */
export function genreTotals(sessions: readonly JSession[], genresOf: (gameId: string) => readonly string[] | undefined): GenreTotal[] {
  const map = new Map<string, GenreTotal>();
  for (const g of topGames(sessions)) {
    const genres = new Set((genresOf(g.gameId) ?? []).map((x) => x.trim()).filter(Boolean));
    for (const genre of genres) {
      const t = map.get(genre);
      if (t) {
        t.seconds += g.seconds;
        t.games++;
      } else {
        map.set(genre, { genre, seconds: g.seconds, games: 1 });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.seconds - a.seconds || a.genre.localeCompare(b.genre));
}

/* ---------------------------------------------------------------- timeline */

export interface DayGroup {
  dayStart: number;
  seconds: number;
  sessions: JSession[];
}

/** Sessions grouped by the local day they started, newest day first, newest session first. */
export function groupByDay(sessions: readonly JSession[]): DayGroup[] {
  const sorted = sessions.slice().sort((a, b) => b.startMs - a.startMs);
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const s of sorted) {
    const day = startOfDay(s.startMs);
    if (!current || current.dayStart !== day) {
      current = { dayStart: day, seconds: 0, sessions: [] };
      groups.push(current);
    }
    current.sessions.push(s);
    current.seconds += s.seconds;
  }
  return groups;
}

/** Takes whole day groups until at least `limit` sessions are included (never splits a day). */
export function takeGroups(groups: readonly DayGroup[], limit: number): { shown: DayGroup[]; shownSessions: number } {
  const shown: DayGroup[] = [];
  let n = 0;
  for (const g of groups) {
    if (n >= limit) break;
    shown.push(g);
    n += g.sessions.length;
  }
  return { shown, shownSessions: n };
}

/* ---------------------------------------------------------------- milestones */

export const GAME_HOUR_MILESTONES = [10, 50, 100] as const;
export const TOTAL_HOUR_MILESTONES = [100, 500, 1000] as const;
export const SESSION_MILESTONES = [100, 500, 1000, 5000] as const;

export type Milestone =
  | { id: string; kind: 'first'; at: number; gameId: string; sessionId: string }
  | { id: string; kind: 'gameHours'; at: number; gameId: string; hours: number }
  | { id: string; kind: 'totalHours'; at: number; hours: number }
  | { id: string; kind: 'sessionCount'; at: number; count: number; gameId: string }
  | { id: string; kind: 'longestSession'; at: number; gameId: string; sessionId: string; seconds: number }
  | { id: string; kind: 'longestStreak'; at: number; days: number }
  /** `month` is the month's first day; `at` is the last day played in it (when it was settled). */
  | { id: string; kind: 'topMonth'; at: number; month: number; seconds: number };

/**
 * Milestones derived only from recorded sessions, oldest first. Hour milestones are dated to
 * the moment inside the session where the running total crossed the threshold.
 */
export function milestones(sessions: readonly JSession[]): Milestone[] {
  if (!sessions.length) return [];
  const chrono = sessions.slice().sort((a, b) => a.startMs - b.startMs);
  const out: Milestone[] = [];

  const first = chrono[0];
  out.push({ id: 'first', kind: 'first', at: first.startMs, gameId: first.gameId, sessionId: first.id });

  const perGame = new Map<string, number>();
  let total = 0;
  chrono.forEach((s, i) => {
    const before = perGame.get(s.gameId) ?? 0;
    const after = before + s.seconds;
    for (const h of GAME_HOUR_MILESTONES) {
      const mark = h * 3600;
      if (before < mark && after >= mark) out.push({ id: `game-${s.gameId}-${h}`, kind: 'gameHours', at: s.startMs + (mark - before) * 1000, gameId: s.gameId, hours: h });
    }
    perGame.set(s.gameId, after);

    const totalAfter = total + s.seconds;
    for (const h of TOTAL_HOUR_MILESTONES) {
      const mark = h * 3600;
      if (total < mark && totalAfter >= mark) out.push({ id: `total-${h}`, kind: 'totalHours', at: s.startMs + (mark - total) * 1000, hours: h });
    }
    total = totalAfter;

    const count = i + 1;
    if ((SESSION_MILESTONES as readonly number[]).includes(count)) out.push({ id: `sessions-${count}`, kind: 'sessionCount', at: s.startMs, count, gameId: s.gameId });
  });

  let longest = chrono[0];
  for (const s of chrono) if (s.seconds > longest.seconds) longest = s;
  if (longest.seconds > 0) out.push({ id: 'longest', kind: 'longestSession', at: longest.startMs, gameId: longest.gameId, sessionId: longest.id, seconds: longest.seconds });

  const streak = longestStreak(chrono);
  if (streak.days >= 3 && streak.endDay != null) out.push({ id: 'streak', kind: 'longestStreak', at: streak.endDay, days: streak.days });

  const months = new Map<number, { seconds: number; lastDay: number }>();
  for (const [day, secs] of dailyTotals(chrono)) {
    const m = startOfMonth(day);
    const cur = months.get(m);
    if (cur) {
      cur.seconds += secs;
      cur.lastDay = Math.max(cur.lastDay, day);
    } else months.set(m, { seconds: secs, lastDay: day });
  }
  if (months.size >= 2) {
    let best: [number, { seconds: number; lastDay: number }] | null = null;
    for (const entry of months) if (!best || entry[1].seconds > best[1].seconds) best = entry;
    if (best && best[1].seconds > 0) out.push({ id: 'top-month', kind: 'topMonth', at: best[1].lastDay, month: best[0], seconds: best[1].seconds });
  }

  return out.sort((a, b) => a.at - b.at);
}

/* ---------------------------------------------------------------- year in review */

export interface YearReview {
  year: number;
  seconds: number;
  sessions: number;
  games: number;
  activeDays: number;
  months: number[];
  busiestMonth: number;
  topGame: GameTotal | null;
  topGenre: GenreTotal | null;
  longest: JSession | null;
  longestStreakDays: number;
}

/** Recap of one calendar year; null when nothing was tracked that year. */
export function yearInReview(sessions: readonly JSession[], year: number, genresOf: (gameId: string) => readonly string[] | undefined): YearReview | null {
  const yearSessions = sessions.filter((s) => new Date(s.startMs).getFullYear() === year);
  if (!yearSessions.length) return null;
  const months = Array.from({ length: 12 }, () => 0);
  let activeDays = 0;
  for (const [day, secs] of dailyTotals(yearSessions)) {
    const d = new Date(day);
    if (d.getFullYear() !== year) continue;
    months[d.getMonth()] += secs;
    activeDays++;
  }
  let busiestMonth = 0;
  months.forEach((v, i) => {
    if (v > months[busiestMonth]) busiestMonth = i;
  });
  const t = computeTotals(yearSessions);
  return {
    year,
    seconds: t.seconds,
    sessions: t.sessions,
    games: t.games,
    activeDays,
    months,
    busiestMonth,
    topGame: topGames(yearSessions, 1)[0] ?? null,
    topGenre: genreTotals(yearSessions, genresOf)[0] ?? null,
    longest: t.longest,
    longestStreakDays: longestStreak(yearSessions).days,
  };
}
