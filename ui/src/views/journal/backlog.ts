/**
 * Pure computations for the Journal's Backlog card, built from the status history VYSTRAL
 * records when you change a game's status. Nothing is inferred: a game only counts as
 * "in the backlog" on days after you marked it so. Local-time calendar maths (DST-safe).
 */
import type { GameStatus, StatusHistoryEntry } from '../../bridge/types';
import { addDays, startOfDay, type JSession } from './stats';

const DAY_MS = 86_400_000;

export interface StatusEvent {
  gameId: string;
  status: GameStatus | null;
  atMs: number;
}

export function normalizeHistory(list: readonly StatusHistoryEntry[]): StatusEvent[] {
  const out: StatusEvent[] = [];
  for (const e of list) {
    const atMs = Date.parse(e.at);
    if (Number.isFinite(atMs)) out.push({ gameId: e.gameId, status: e.status ?? null, atMs });
  }
  // Stable: equal timestamps keep their recorded order.
  return out.map((e, i) => [e, i] as const).sort((a, b) => a[0].atMs - b[0].atMs || a[1] - b[1]).map(([e]) => e);
}

export type StatusCounts = Record<GameStatus, number>;

export function emptyCounts(): StatusCounts {
  return { backlog: 0, playing: 0, beaten: 0, completed: 0, abandoned: 0 };
}

/** Current number of games per status (games without a status are not counted). */
export function currentCounts(games: readonly { status?: GameStatus | null }[]): StatusCounts {
  const c = emptyCounts();
  for (const g of games) if (g.status) c[g.status]++;
  return c;
}

export interface BacklogPoint {
  /** Local midnight of the day (or of the first day of the week) this point summarises. */
  start: number;
  /** Games in the Backlog at the end of that period. */
  backlog: number;
  /** Games marked Playing at the end of that period. */
  playing: number;
  /** Games finished (Beaten or Completed 100%) so far, at the end of that period. */
  finished: number;
}

export interface BacklogSeries {
  unit: 'day' | 'week';
  points: BacklogPoint[];
}

/** Daily for up to this many days of history, weekly beyond it. */
export const DAILY_LIMIT = 120;

/**
 * Backlog size over time: one point per day (or week) from the day of the first recorded status
 * change through today, each holding the state at the end of that period.
 */
export function backlogSeries(events: readonly StatusEvent[], now: number): BacklogSeries {
  if (events.length === 0) return { unit: 'day', points: [] };
  const first = startOfDay(events[0].atMs);
  const today = startOfDay(now);
  const spanDays = Math.max(0, Math.round((today - first) / DAY_MS)) + 1;
  const unit: 'day' | 'week' = spanDays > DAILY_LIMIT ? 'week' : 'day';
  const step = unit === 'day' ? 1 : 7;

  const state = new Map<string, GameStatus | null>();
  const tally = emptyCounts();
  const apply = (e: StatusEvent) => {
    const prev = state.get(e.gameId) ?? null;
    if (prev) tally[prev]--;
    if (e.status) tally[e.status]++;
    state.set(e.gameId, e.status);
  };

  const points: BacklogPoint[] = [];
  let i = 0;
  for (let start = first; start <= today; start = addDays(start, step)) {
    const end = addDays(start, step); // exclusive
    while (i < events.length && events[i].atMs < end) apply(events[i++]);
    points.push({ start, backlog: tally.backlog, playing: tally.playing, finished: tally.beaten + tally.completed });
  }
  return { unit, points };
}

export interface FinishedGame {
  gameId: string;
  status: 'beaten' | 'completed';
  atMs: number;
}

/**
 * Games you finished in a calendar year: the first time each was marked Beaten or Completed 100%
 * that year. Games you've since moved back to another status are left out. Newest first.
 */
export function finishedInYear(events: readonly StatusEvent[], year: number, currentStatus: (gameId: string) => GameStatus | null | undefined): FinishedGame[] {
  const from = new Date(year, 0, 1).getTime();
  const to = new Date(year + 1, 0, 1).getTime();
  const firstByGame = new Map<string, FinishedGame>();
  for (const e of events) {
    if (e.atMs < from || e.atMs >= to || (e.status !== 'beaten' && e.status !== 'completed')) continue;
    if (!firstByGame.has(e.gameId)) firstByGame.set(e.gameId, { gameId: e.gameId, status: e.status, atMs: e.atMs });
  }
  const out: FinishedGame[] = [];
  for (const f of firstByGame.values()) {
    const now = currentStatus(f.gameId);
    if (now === 'beaten' || now === 'completed') out.push({ ...f, status: now });
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}

export interface TimeToBeat {
  /** Games with both a "Playing" and a later "Beaten"/"Completed" mark. */
  games: number;
  /** Average calendar days between those two marks. */
  avgDays: number | null;
  /** How many of those games have VYSTRAL-tracked play between the marks. */
  trackedGames: number;
  /** Average tracked play time between the marks, over `trackedGames`. */
  avgTrackedSeconds: number | null;
}

/**
 * Average time to beat, from your own marks: for each game, from the first time it was marked
 * Playing to the first time after that it was marked Beaten or Completed 100%. Play time is the
 * sum of VYSTRAL-tracked sessions that started in that window; store playtime isn't included.
 */
export function timeToBeat(events: readonly StatusEvent[], sessions: readonly Pick<JSession, 'gameId' | 'startMs' | 'seconds'>[]): TimeToBeat {
  const spans: { gameId: string; from: number; to: number }[] = [];
  const started = new Map<string, number>();
  const done = new Set<string>();
  for (const e of events) {
    if (done.has(e.gameId)) continue;
    if (e.status === 'playing' && !started.has(e.gameId)) started.set(e.gameId, e.atMs);
    else if ((e.status === 'beaten' || e.status === 'completed') && started.has(e.gameId)) {
      spans.push({ gameId: e.gameId, from: started.get(e.gameId)!, to: e.atMs });
      done.add(e.gameId);
    }
  }
  if (spans.length === 0) return { games: 0, avgDays: null, trackedGames: 0, avgTrackedSeconds: null };

  const byGame = new Map<string, Pick<JSession, 'startMs' | 'seconds'>[]>();
  for (const s of sessions) {
    let list = byGame.get(s.gameId);
    if (!list) byGame.set(s.gameId, (list = []));
    list.push(s);
  }
  let days = 0;
  let tracked = 0;
  let trackedGames = 0;
  for (const sp of spans) {
    days += (sp.to - sp.from) / DAY_MS;
    const secs = (byGame.get(sp.gameId) ?? []).filter((s) => s.startMs >= sp.from && s.startMs <= sp.to).reduce((n, s) => n + s.seconds, 0);
    if (secs > 0) {
      tracked += secs;
      trackedGames++;
    }
  }
  return {
    games: spans.length,
    avgDays: days / spans.length,
    trackedGames,
    avgTrackedSeconds: trackedGames ? tracked / trackedGames : null,
  };
}

/** Plain-language summary of the backlog series, for the chart's accessible name. */
export function describeBacklog(series: BacklogSeries, fmtDate: (ms: number) => string): string {
  const pts = series.points;
  if (pts.length === 0) return 'Backlog size over time: no status changes recorded yet.';
  const first = pts[0];
  const last = pts[pts.length - 1];
  const peak = pts.reduce((m, p) => (p.backlog > m.backlog ? p : m), first);
  const change = last.backlog - first.backlog;
  const trend = change === 0 ? 'unchanged' : change > 0 ? `up ${change}` : `down ${-change}`;
  return `Backlog size per ${series.unit} since ${fmtDate(first.start)}: ${last.backlog} now, ${trend} from ${first.backlog}. Peak ${peak.backlog} on ${fmtDate(peak.start)}.`;
}
