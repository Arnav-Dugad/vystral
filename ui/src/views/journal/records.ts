/**
 * Track C6: personal records, shown as collectible badges in the Journal and celebrated when a session beats one.
 *
 * Pure, so every rule is unit-tested. Only finished sessions VYSTRAL observed itself count: open sessions (no end
 * yet), store-imported playtime and zero-length sessions never do. All calendar maths is in the user's local time
 * zone and DST-safe (days are stepped with the helpers in ./stats, never by adding 24 h). A session that crosses
 * midnight counts toward both days for the "per day" and "per week" records.
 *
 * Every record has a score where higher is better. A tie never takes a record from whoever set it first, and a
 * record only counts as broken when the new score is strictly higher.
 */
import type { Session } from '../../bridge/types';
import { isObserved } from '../../lib/sessions';
import { addDays, splitAcrossDays, startOfDay } from './stats';

export type RecordId = 'first' | 'longestSession' | 'bestDay' | 'bestWeek' | 'varietyWeek' | 'streak' | 'nightOwl' | 'earlyBird' | 'comeback';

/** Display order of the badges. */
export const RECORD_IDS: readonly RecordId[] = ['longestSession', 'bestDay', 'bestWeek', 'streak', 'varietyWeek', 'nightOwl', 'earlyBird', 'comeback', 'first'];

/** A finished session reduced to what records need. */
export interface RSession {
  id: string;
  gameId: string;
  startMs: number;
  endMs: number;
  seconds: number;
}

export interface PersonalRecord {
  id: RecordId;
  /** Higher is better. Units depend on the record (seconds, days, games, minutes on the night clock…). */
  score: number;
  /** The value in its natural unit: seconds, days, games, or minutes of the day (local) for night owl and early bird. */
  value: number;
  /** When it was set (local ms): the session's start, or the start of the day, week or streak. */
  at: number;
  /** Last day of a span record (streak, week), local midnight. */
  until: number | null;
  /** The game that set it (the most played one, for day, week and streak records). */
  gameId: string | null;
  /** The session to open from the badge (the longest one, for day, week and streak records). */
  sessionId: string | null;
  /** The local day to show in the Journal timeline for this record. */
  day: number;
}

export type Records = Partial<Record<RecordId, PersonalRecord>>;

const MIN = 60;
const HOUR = 3600;

/** Night owl counts finishes between 21:00 and 05:59; early bird counts starts between 04:00 and 08:59. */
export const NIGHT_FROM = 21 * 60;
export const NIGHT_UNTIL = 6 * 60;
export const MORNING_FROM = 4 * 60;
export const MORNING_UNTIL = 9 * 60;
/** A comeback is a return to a game after at least this many days away. */
export const COMEBACK_DAYS = 30;
/** Streaks need at least two days in a row to count as one. */
export const STREAK_MIN = 2;

/**
 * Below these, beating a record isn't worth a toast (the first week of use would be nothing but toasts).
 * Badges still show; only the celebration waits.
 */
export const CELEBRATE_FLOOR: Record<Exclude<RecordId, 'first'>, number> = {
  longestSession: 30 * MIN,
  bestDay: 1 * HOUR,
  bestWeek: 3 * HOUR,
  varietyWeek: 3,
  streak: 3,
  // Scores on the night clock: 23:00 or later.
  nightOwl: nightScore(23 * 60),
  // Scores for starts at 07:00 or earlier.
  earlyBird: morningScore(7 * 60),
  comeback: COMEBACK_DAYS,
};

/** Minutes past local midnight. */
export function minuteOfDay(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** Night clock: 18:00 = 0 … 05:59 = 719. Later in the night scores higher. */
export function nightScore(minute: number): number {
  return (minute - 18 * 60 + 1440) % 1440;
}

export function isNightFinish(minute: number): boolean {
  return minute >= NIGHT_FROM || minute < NIGHT_UNTIL;
}

/** Earlier in the morning scores higher (04:00 = 300, 08:59 = 1). */
export function morningScore(minute: number): number {
  return MORNING_UNTIL - minute;
}

export function isEarlyStart(minute: number): boolean {
  return minute >= MORNING_FROM && minute < MORNING_UNTIL;
}

/** Local Monday 00:00 of the week holding `ms`. */
export function startOfWeek(ms: number): number {
  const day = startOfDay(ms);
  const dow = (new Date(day).getDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
}

/** Finished, observed sessions with a real length, oldest first. Open sessions are left out. */
export function finishedSessions(list: readonly Session[]): RSession[] {
  const out: RSession[] = [];
  for (const s of list) {
    if (!s || !isObserved(s.source) || s.end == null) continue;
    const startMs = Date.parse(s.start);
    if (!Number.isFinite(startMs)) continue;
    const seconds = Number.isFinite(s.durationSeconds) && s.durationSeconds > 0 ? s.durationSeconds : 0;
    if (seconds <= 0) continue;
    const parsedEnd = Date.parse(s.end);
    // The recorded length is the truth; the end time only refines it when it agrees (clock changes, rounding).
    const endMs = Number.isFinite(parsedEnd) && parsedEnd > startMs && Math.abs(parsedEnd - startMs - seconds * 1000) < 120_000 ? parsedEnd : startMs + seconds * 1000;
    out.push({ id: s.id, gameId: s.gameId, startMs, endMs, seconds });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

interface Bucket {
  key: number;
  seconds: number;
  games: Map<string, number>;
  /** Longest part of a session inside this bucket. */
  best: { id: string; seconds: number } | null;
}

function addTo(map: Map<number, Bucket>, key: number, s: RSession, seconds: number) {
  let b = map.get(key);
  if (!b) map.set(key, (b = { key, seconds: 0, games: new Map(), best: null }));
  b.seconds += seconds;
  b.games.set(s.gameId, (b.games.get(s.gameId) ?? 0) + seconds);
  if (!b.best || seconds > b.best.seconds) b.best = { id: s.id, seconds };
}

function topGame(games: Map<string, number>): string | null {
  let id: string | null = null;
  let best = -1;
  for (const [g, secs] of games) if (secs > best) [id, best] = [g, secs];
  return id;
}

/** Highest-scoring bucket; ties keep the earliest. */
function bestBucket(buckets: Map<number, Bucket>, score: (b: Bucket) => number): Bucket | null {
  let best: Bucket | null = null;
  let bestScore = -Infinity;
  for (const b of [...buckets.values()].sort((x, y) => x.key - y.key)) {
    const sc = score(b);
    if (sc > bestScore) [best, bestScore] = [b, sc];
  }
  return best;
}

/** Every record the sessions hold. Records not earned yet are absent. */
export function computeRecords(list: readonly Session[] | readonly RSession[]): Records {
  const sessions = isRSessions(list) ? list : finishedSessions(list as readonly Session[]);
  const out: Records = {};
  if (!sessions.length) return out;

  // First session ever.
  const first = sessions[0];
  out.first = { id: 'first', score: -first.startMs, value: first.startMs, at: first.startMs, until: null, gameId: first.gameId, sessionId: first.id, day: startOfDay(first.startMs) };

  // Longest session; night owl; early bird.
  for (const s of sessions) {
    const cur = out.longestSession;
    if (!cur || s.seconds > cur.score) out.longestSession = { id: 'longestSession', score: s.seconds, value: s.seconds, at: s.startMs, until: null, gameId: s.gameId, sessionId: s.id, day: startOfDay(s.startMs) };

    const endMinute = minuteOfDay(s.endMs);
    if (isNightFinish(endMinute)) {
      const sc = nightScore(endMinute);
      if (!out.nightOwl || sc > out.nightOwl.score) out.nightOwl = { id: 'nightOwl', score: sc, value: endMinute, at: s.startMs, until: null, gameId: s.gameId, sessionId: s.id, day: startOfDay(s.startMs) };
    }
    const startMinute = minuteOfDay(s.startMs);
    if (isEarlyStart(startMinute)) {
      const sc = morningScore(startMinute);
      if (!out.earlyBird || sc > out.earlyBird.score) out.earlyBird = { id: 'earlyBird', score: sc, value: startMinute, at: s.startMs, until: null, gameId: s.gameId, sessionId: s.id, day: startOfDay(s.startMs) };
    }
  }

  // Per day and per week, splitting sessions at local midnight.
  const days = new Map<number, Bucket>();
  const weeks = new Map<number, Bucket>();
  for (const s of sessions) {
    for (const part of splitAcrossDays(s.startMs, s.seconds)) {
      if (part.seconds <= 0) continue;
      addTo(days, part.dayStart, s, part.seconds);
      addTo(weeks, startOfWeek(part.dayStart), s, part.seconds);
    }
  }
  const day = bestBucket(days, (b) => b.seconds);
  if (day) out.bestDay = { id: 'bestDay', score: day.seconds, value: day.seconds, at: day.key, until: day.key, gameId: topGame(day.games), sessionId: day.best?.id ?? null, day: day.key };
  const week = bestBucket(weeks, (b) => b.seconds);
  if (week) out.bestWeek = { id: 'bestWeek', score: week.seconds, value: week.seconds, at: week.key, until: addDays(week.key, 6), gameId: topGame(week.games), sessionId: week.best?.id ?? null, day: lastActiveDay(days, week.key) };
  const variety = bestBucket(weeks, (b) => b.games.size);
  if (variety) out.varietyWeek = { id: 'varietyWeek', score: variety.games.size, value: variety.games.size, at: variety.key, until: addDays(variety.key, 6), gameId: topGame(variety.games), sessionId: variety.best?.id ?? null, day: lastActiveDay(days, variety.key) };

  // Longest run of consecutive days with play.
  const dayKeys = [...days.keys()].sort((a, b) => a - b);
  let run: number[] = [];
  let bestRun: number[] = [];
  for (const d of dayKeys) {
    run = run.length && addDays(run[run.length - 1], 1) === d ? [...run, d] : [d];
    if (run.length > bestRun.length) bestRun = run;
  }
  if (bestRun.length >= STREAK_MIN) {
    const games = new Map<string, number>();
    let longest: { id: string; seconds: number } | null = null;
    for (const d of bestRun) {
      const b = days.get(d)!;
      for (const [g, secs] of b.games) games.set(g, (games.get(g) ?? 0) + secs);
      if (b.best && (!longest || b.best.seconds > longest.seconds)) longest = b.best;
    }
    const end = bestRun[bestRun.length - 1];
    out.streak = { id: 'streak', score: bestRun.length, value: bestRun.length, at: bestRun[0], until: end, gameId: topGame(games), sessionId: longest?.id ?? null, day: end };
  }

  // Comeback: the longest time away from a game before playing it again.
  const lastEnd = new Map<string, number>();
  for (const s of sessions) {
    const prev = lastEnd.get(s.gameId);
    if (prev != null && s.startMs > prev) {
      const away = Math.round((startOfDay(s.startMs) - startOfDay(prev)) / 86_400_000);
      if (away >= COMEBACK_DAYS && (!out.comeback || away > out.comeback.score))
        out.comeback = { id: 'comeback', score: away, value: away, at: s.startMs, until: null, gameId: s.gameId, sessionId: s.id, day: startOfDay(s.startMs) };
    }
    lastEnd.set(s.gameId, Math.max(prev ?? -Infinity, s.endMs));
  }
  return out;
}

function lastActiveDay(days: Map<number, Bucket>, weekStart: number): number {
  let last = weekStart;
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    if (days.has(d)) last = d;
  }
  return last;
}

function isRSessions(list: readonly unknown[]): list is readonly RSession[] {
  const x = list[0] as RSession | undefined;
  return !!x && typeof x.startMs === 'number' && typeof x.endMs === 'number';
}

export interface BrokenRecord {
  id: Exclude<RecordId, 'first'>;
  before: PersonalRecord;
  after: PersonalRecord;
}

/**
 * The records a just-finished session beat: compared with every other finished session, strictly better and above
 * the celebration floor. A record set for the first time (nothing to beat) isn't celebrated, and neither is a session
 * that's still open or unknown.
 */
export function recordsBrokenBy(list: readonly Session[], sessionId: string): BrokenRecord[] {
  const all = finishedSessions(list);
  if (!all.some((s) => s.id === sessionId)) return [];
  const before = computeRecords(all.filter((s) => s.id !== sessionId));
  const after = computeRecords(all);
  const out: BrokenRecord[] = [];
  for (const id of RECORD_IDS) {
    if (id === 'first') continue;
    const b = before[id];
    const a = after[id];
    if (!a || !b || a.score <= b.score || a.score < CELEBRATE_FLOOR[id]) continue;
    out.push({ id, before: b, after: a });
  }
  return out;
}

/** Records whose score went up since `seen` (a map of record id → score), for the badges' "New" ribbon. */
export function improvedSince(records: Records, seen: Partial<Record<RecordId, number>> | null): Set<RecordId> {
  const out = new Set<RecordId>();
  if (!seen) return out;
  for (const id of RECORD_IDS) {
    const r = records[id];
    if (r && (seen[id] == null || r.score > seen[id]!)) out.add(id);
  }
  return out;
}

export function scoresOf(records: Records): Partial<Record<RecordId, number>> {
  const out: Partial<Record<RecordId, number>> = {};
  for (const id of RECORD_IDS) if (records[id]) out[id] = records[id]!.score;
  return out;
}
