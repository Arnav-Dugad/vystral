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
 *
 * Track D1 adds records that also read the library, the achievement feed and IGDB time-to-beat estimates (passed in a
 * {@link RecordContext}); without that context they simply stay locked.
 */
import type { Session, TimeToBeat } from '../../bridge/types';
import { isObserved } from '../../lib/sessions';
import { addDays, splitAcrossDays, startOfDay, startOfMonth } from './stats';

export type RecordId = 'first' | 'longestSession' | 'bestDay' | 'bestWeek' | 'varietyWeek' | 'streak' | 'nightOwl' | 'earlyBird' | 'comeback'
  // Track D1
  | 'weekendWarrior' | 'marathonMonth' | 'gameStreak' | 'varietyMonth' | 'achievementDay' | 'speedrun' | 'century' | 'genreHours'
  | 'oldestGame' | 'bestFps' | 'coolest';

/** Display order of the badges. */
export const RECORD_IDS: readonly RecordId[] = [
  'longestSession', 'bestDay', 'bestWeek', 'weekendWarrior', 'marathonMonth', 'streak', 'gameStreak', 'varietyWeek', 'varietyMonth',
  'nightOwl', 'earlyBird', 'comeback', 'achievementDay', 'speedrun', 'century', 'genreHours', 'oldestGame', 'bestFps', 'coolest', 'first',
];

/** A finished session reduced to what records need. */
export interface RSession {
  id: string;
  gameId: string;
  startMs: number;
  endMs: number;
  seconds: number;
  /** Track D1: the session's average frame rate and GPU temperature, when it was measured. */
  fps?: number | null;
  tempC?: number | null;
}

/** Track D1: what the records beyond sessions need. Everything is optional; a record without its data stays locked. */
export interface RecordContext {
  /** Library facts per game id. */
  games?: ReadonlyMap<string, { genres?: readonly string[]; releaseDate?: string | null; status?: string | null; statusChangedAt?: string | null }>;
  /** Achievement unlocks (any order). */
  achievements?: readonly { gameId: string | null; unlockedAt: string }[];
  /** IGDB time-to-beat estimates per game id (seconds). */
  ttb?: Readonly<Record<string, TimeToBeat>> | null;
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
  /** Track D1: a word the record needs besides its value (the genre for genre hours). */
  label?: string | null;
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
/** Track D1: the century badge — the first time one game passed this many hours. */
export const CENTURY_HOURS = 100;
/** Track D1: frame-rate and temperature records only count sessions at least this long (a menu isn't a session). */
export const PERF_MIN_SECONDS = 20 * MIN;
/** Track D1: the speedrun record needs this much tracked play and a time-to-beat estimate at least this long. */
export const SPEEDRUN_MIN_SECONDS = HOUR;

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
  // Track D1 (session-based ones only; the others need the library and are never toasted).
  weekendWarrior: 3 * HOUR,
  marathonMonth: 10 * HOUR,
  gameStreak: 3,
  varietyMonth: 5,
  bestFps: 60,
  coolest: Infinity,
  century: Infinity,
  achievementDay: Infinity,
  speedrun: Infinity,
  genreHours: Infinity,
  oldestGame: Infinity,
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
    const perf = perfOf(s.perfSummary);
    out.push({ id: s.id, gameId: s.gameId, startMs, endMs, seconds, fps: perf.fps, tempC: perf.tempC });
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
}

/** Track D1: the average frame rate and GPU temperature from a stored summary (untrusted JSON, so checked). */
export function perfOf(json: string | null | undefined): { fps: number | null; tempC: number | null } {
  if (!json || json.length > 20000) return { fps: null, tempC: null };
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) && v > lo && v < hi ? v : null);
    return { fps: num(o?.fpsAvg, 0, 2000), tempC: num(o?.gpuTempAvgC, 0, 130) };
  } catch {
    return { fps: null, tempC: null };
  }
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

/** Every record the sessions (and, for Track D1's, the context) hold. Records not earned yet are absent. */
export function computeRecords(list: readonly Session[] | readonly RSession[], ctx: RecordContext = {}): Records {
  const sessions = isRSessions(list) ? list : finishedSessions(list as readonly Session[]);
  const out: Records = {};
  // Achievements don't need sessions.
  const ach = achievementDay(ctx.achievements);
  if (ach) out.achievementDay = ach;
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

  extraRecords(sessions, days, out, ctx);
  return out;
}

/* ---------------------------------------------------------------- Track D1 */

const rec = (id: RecordId, score: number, value: number, at: number, extra: Partial<PersonalRecord> = {}): PersonalRecord =>
  ({ id, score, value, at, until: null, gameId: null, sessionId: null, day: startOfDay(at), ...extra });

/** The calendar year of a release date ("2015", "2015-03-02", an ISO date), or null. */
export function releaseYear(date: string | null | undefined): number | null {
  const m = /^(\d{4})/.exec(date ?? '');
  const y = m ? Number(m[1]) : NaN;
  return y >= 1950 && y <= 2100 ? y : null;
}

/** Local Saturday 00:00 of the weekend holding `dayStart`, or null on a weekday. */
export function weekendOf(dayStart: number): number | null {
  const dow = new Date(dayStart).getDay();
  return dow === 6 ? dayStart : dow === 0 ? addDays(dayStart, -1) : null;
}

/** Most achievements unlocked on one local day. */
function achievementDay(list: RecordContext['achievements']): PersonalRecord | null {
  if (!list?.length) return null;
  const days = new Map<number, Map<string, number>>();
  for (const a of list) {
    const t = Date.parse(a.unlockedAt);
    if (!Number.isFinite(t)) continue;
    const d = startOfDay(t);
    const games = days.get(d) ?? new Map<string, number>();
    games.set(a.gameId ?? '', (games.get(a.gameId ?? '') ?? 0) + 1);
    days.set(d, games);
  }
  let best: PersonalRecord | null = null;
  for (const d of [...days.keys()].sort((a, b) => a - b)) {
    const games = days.get(d)!;
    const n = [...games.values()].reduce((x, y) => x + y, 0);
    if (!best || n > best.score) best = rec('achievementDay', n, n, d, { gameId: topGame(games) || null });
  }
  return best;
}

function extraRecords(sessions: readonly RSession[], days: Map<number, Bucket>, out: Records, ctx: RecordContext) {
  // Weekends and calendar months, from the per-day buckets (sessions already split at midnight).
  const weekends = new Map<number, Bucket>();
  const months = new Map<number, Bucket>();
  for (const b of [...days.values()].sort((x, y) => x.key - y.key)) {
    const sat = weekendOf(b.key);
    for (const [map, key] of [[weekends, sat], [months, startOfMonth(b.key)]] as const) {
      if (key == null) continue;
      let m = map.get(key);
      if (!m) map.set(key, (m = { key, seconds: 0, games: new Map(), best: null }));
      m.seconds += b.seconds;
      for (const [g, secs] of b.games) m.games.set(g, (m.games.get(g) ?? 0) + secs);
      if (b.best && (!m.best || b.best.seconds > m.best.seconds)) m.best = b.best;
    }
  }
  const weekend = bestBucket(weekends, (b) => b.seconds);
  if (weekend) {
    const sunday = addDays(weekend.key, 1);
    out.weekendWarrior = rec('weekendWarrior', weekend.seconds, weekend.seconds, weekend.key, { until: sunday, gameId: topGame(weekend.games), sessionId: weekend.best?.id ?? null, day: days.has(sunday) ? sunday : weekend.key });
  }
  const monthEnd = (start: number) => addDays(startOfMonth(addDays(start, 32)), -1);
  const month = bestBucket(months, (b) => b.seconds);
  if (month) out.marathonMonth = rec('marathonMonth', month.seconds, month.seconds, month.key, { until: monthEnd(month.key), gameId: topGame(month.games), sessionId: month.best?.id ?? null, day: lastDayIn(days, month.key) });
  const variety = bestBucket(months, (b) => b.games.size);
  if (variety && variety.games.size >= 2) out.varietyMonth = rec('varietyMonth', variety.games.size, variety.games.size, variety.key, { until: monthEnd(variety.key), gameId: topGame(variety.games), sessionId: variety.best?.id ?? null, day: lastDayIn(days, variety.key) });

  // The longest run of consecutive days playing the same game.
  const perGame = new Map<string, number[]>();
  for (const b of [...days.values()].sort((x, y) => x.key - y.key)) for (const g of b.games.keys()) {
    const list = perGame.get(g) ?? [];
    list.push(b.key);
    perGame.set(g, list);
  }
  let streak: { gameId: string; from: number; to: number; n: number } | null = null;
  for (const [g, sorted] of perGame) {
    let from = sorted[0];
    let n = 1;
    for (let i = 1; i <= sorted.length; i++) {
      if (i < sorted.length && addDays(sorted[i - 1], 1) === sorted[i]) { n++; continue; }
      const to = sorted[i - 1];
      if (n >= STREAK_MIN && (!streak || n > streak.n || (n === streak.n && from < streak.from))) streak = { gameId: g, from, to, n };
      if (i < sorted.length) { from = sorted[i]; n = 1; }
    }
  }
  if (streak) {
    const s = streak;
    const longest = sessions.filter((x) => x.gameId === s.gameId && x.endMs > s.from && x.startMs < addDays(s.to, 1)).sort((a, b) => b.seconds - a.seconds)[0];
    out.gameStreak = rec('gameStreak', s.n, s.n, s.from, { until: s.to, gameId: s.gameId, sessionId: longest?.id ?? null, day: s.to });
  }

  // Century: the first moment one game passed 100 hours of tracked play.
  const total = new Map<string, number>();
  for (const s of sessions) {
    const before = total.get(s.gameId) ?? 0;
    const after = before + s.seconds;
    total.set(s.gameId, after);
    if (!out.century && before < CENTURY_HOURS * HOUR && after >= CENTURY_HOURS * HOUR) {
      const at = s.startMs + (CENTURY_HOURS * HOUR - before) * 1000;
      out.century = rec('century', -at, at, at, { gameId: s.gameId, sessionId: s.id });
    }
  }

  // Best frame rate and coolest-running session (measured sessions of a real length only).
  for (const s of sessions) {
    if (s.seconds < PERF_MIN_SECONDS) continue;
    if (s.fps != null && (!out.bestFps || s.fps > out.bestFps.score)) out.bestFps = rec('bestFps', s.fps, s.fps, s.startMs, { gameId: s.gameId, sessionId: s.id });
    if (s.tempC != null && (!out.coolest || -s.tempC > out.coolest.score)) out.coolest = rec('coolest', -s.tempC, s.tempC, s.startMs, { gameId: s.gameId, sessionId: s.id });
  }

  const games = ctx.games;
  if (!games) return;

  // Hours on one genre (a game counts toward each of its genres).
  const genre = new Map<string, Map<string, number>>();
  for (const [g, secs] of total) for (const name of new Set((games.get(g)?.genres ?? []).map((x) => x.trim()).filter(Boolean))) {
    const m = genre.get(name) ?? new Map<string, number>();
    m.set(g, secs);
    genre.set(name, m);
  }
  let bestGenre: { name: string; secs: number; games: Map<string, number> } | null = null;
  for (const [name, m] of [...genre.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const secs = [...m.values()].reduce((a, b) => a + b, 0);
    if (!bestGenre || secs > bestGenre.secs) bestGenre = { name, secs, games: m };
  }
  if (bestGenre) {
    const inGenre = bestGenre.games;
    const last = sessions.filter((s) => inGenre.has(s.gameId)).at(-1)!;
    out.genreHours = rec('genreHours', bestGenre.secs, bestGenre.secs, last.startMs, { gameId: topGame(inGenre), label: bestGenre.name, sessionId: last.id });
  }

  // The oldest game you played, by release year (the first session of it).
  for (const s of sessions) {
    const y = releaseYear(games.get(s.gameId)?.releaseDate);
    if (y == null) continue;
    if (!out.oldestGame || 3000 - y > out.oldestGame.score) out.oldestGame = rec('oldestGame', 3000 - y, y, s.startMs, { gameId: s.gameId, sessionId: s.id });
  }

  // Fastest finish against IGDB's estimate: tracked play before you marked it Beaten (or Completed).
  const ttb = ctx.ttb;
  if (!ttb) return;
  for (const [gameId, g] of [...games.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if ((g.status !== 'beaten' && g.status !== 'completed') || !g.statusChangedAt) continue;
    const doneAt = Date.parse(g.statusChangedAt);
    const t = ttb[gameId];
    const target = !t ? null : g.status === 'completed' ? t.completionist ?? t.extras ?? t.main : t.main ?? t.extras ?? t.completionist;
    if (!Number.isFinite(doneAt) || !target || !(target >= SPEEDRUN_MIN_SECONDS)) continue;
    const played = sessions.filter((s) => s.gameId === gameId && s.startMs < doneAt).reduce((a, s) => a + s.seconds, 0);
    if (played < SPEEDRUN_MIN_SECONDS) continue;
    const ratio = target / played;
    if (!out.speedrun || ratio > out.speedrun.score)
      out.speedrun = rec('speedrun', ratio, Math.round((played / target) * 100), doneAt, { gameId, label: g.status === 'completed' ? 'completionist' : 'main story' });
  }
}

function lastDayIn(days: Map<number, Bucket>, monthStart: number): number {
  let last = monthStart;
  for (const d of days.keys()) if (startOfMonth(d) === monthStart && d > last) last = d;
  return last;
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

/**
 * Track D1: badges earned for the first time since `seen` was saved — the unlock fanfare plays for these, once. Nothing
 * on a first visit (`seen` null): every badge appears at once then, and minting them in is celebration enough.
 */
export function unlockedSince(records: Records, seen: Partial<Record<RecordId, number>> | null): RecordId[] {
  if (!seen) return [];
  return RECORD_IDS.filter((id) => records[id] && seen[id] == null);
}

export function scoresOf(records: Records): Partial<Record<RecordId, number>> {
  const out: Partial<Record<RecordId, number>> = {};
  for (const id of RECORD_IDS) if (records[id]) out[id] = records[id]!.score;
  return out;
}
