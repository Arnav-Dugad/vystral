/**
 * Track Y: "At your pace you'll finish X in about 3 weeks."
 *
 * Inputs, all already on this PC: the IGDB time-to-beat estimate (only with the user's own IGDB key),
 * your playtime (the larger of tracked and store-reported, as the time-to-beat bar uses), and your
 * recent cadence for this game: sessions per week × average session length over the last four weeks,
 * which is simply the hours played in those four weeks ÷ 4.
 *
 * Honest by construction:
 * - It needs at least 3 sessions on 2 different days and an hour of play in the last 4 weeks, and a
 *   session in the last 2 weeks; otherwise there is no pace to speak of and nothing is shown.
 * - The range combines two uncertainties: how steady your weekly play is (the spread of the four weekly
 *   totals) and how far one player can be from IGDB's average (±25% of the estimate).
 * - Finished, abandoned or past-every-estimate games, and forecasts beyond a year, are not shown.
 */
import type { GameStatus, TimeToBeat } from '../bridge/types';
import { ttbProgress, type TtbKey } from './timeToBeat';

export const WINDOW_DAYS = 28;
export const MIN_SESSIONS = 3;
export const MIN_DAYS = 2;
export const MIN_WINDOW_SECONDS = 3600;
export const STALE_DAYS = 14;
/** How far one player's time can reasonably be from IGDB's average. */
export const ESTIMATE_SPREAD = 0.25;
export const MAX_WEEKS = 52;

const DAY_MS = 86_400_000;
const DONE = new Set<GameStatus>(['beaten', 'completed', 'abandoned']);

export interface ForecastSession {
  startMs: number;
  seconds: number;
}

export interface Forecast {
  target: TtbKey;
  targetSeconds: number;
  played: number;
  remaining: number;
  /** Average seconds per week over the window. */
  weekly: number;
  sessionsPerWeek: number;
  avgSession: number;
  /** Weeks to finish: likely, and the honest range around it. */
  weeks: number;
  weeksLow: number;
  weeksHigh: number;
  sessionsInWindow: number;
  /** "steady" when the four weeks were similar, "uneven" when they varied a lot. */
  steadiness: 'steady' | 'uneven';
}

export type ForecastSkip = 'noEstimate' | 'finished' | 'pastEstimate' | 'thin' | 'stale' | 'tooFar';

export function completionForecast(input: {
  played: number;
  ttb: TimeToBeat | null | undefined;
  sessions: readonly ForecastSession[];
  now: number;
  status?: GameStatus | null;
}): { forecast: Forecast } | { skip: ForecastSkip } {
  const pr = ttbProgress(input.played, input.ttb);
  if (!pr) return { skip: 'noEstimate' };
  if (input.status && DONE.has(input.status)) return { skip: 'finished' };
  const next = pr.next;
  if (!next) return { skip: 'pastEstimate' };

  const from = input.now - WINDOW_DAYS * DAY_MS;
  const recent = input.sessions.filter((s) => s.startMs >= from && s.startMs <= input.now && s.seconds > 0);
  const total = recent.reduce((a, s) => a + s.seconds, 0);
  const days = new Set(recent.map((s) => new Date(s.startMs).toDateString())).size;
  if (recent.length < MIN_SESSIONS || days < MIN_DAYS || total < MIN_WINDOW_SECONDS) return { skip: 'thin' };
  const last = Math.max(...recent.map((s) => s.startMs));
  if (input.now - last > STALE_DAYS * DAY_MS) return { skip: 'stale' };

  // Four weekly totals, newest last.
  const weeksTotals = [0, 0, 0, 0];
  for (const s of recent) {
    const w = Math.min(3, Math.floor((input.now - s.startMs) / (7 * DAY_MS)));
    weeksTotals[3 - w] += s.seconds;
  }
  const weekly = total / 4;
  const mean = weekly;
  const sd = Math.sqrt(weeksTotals.reduce((a, w) => a + (w - mean) ** 2, 0) / weeksTotals.length);
  const paceHigh = Math.min(mean * 2, mean + sd);
  const paceLow = Math.max(mean * 0.5, mean - sd);

  const remaining = next.seconds - pr.played;
  const remainingLow = Math.max(next.seconds * (1 - ESTIMATE_SPREAD) - pr.played, remaining * 0.25);
  const remainingHigh = next.seconds * (1 + ESTIMATE_SPREAD) - pr.played;

  const weeks = remaining / weekly;
  const weeksLow = remainingLow / paceHigh;
  const weeksHigh = remainingHigh / paceLow;
  if (weeks > MAX_WEEKS) return { skip: 'tooFar' };

  return {
    forecast: {
      target: next.key,
      targetSeconds: next.seconds,
      played: pr.played,
      remaining,
      weekly,
      sessionsPerWeek: recent.length / 4,
      avgSession: total / recent.length,
      weeks,
      weeksLow: Math.min(weeksLow, weeks),
      weeksHigh: Math.max(weeksHigh, weeks),
      sessionsInWindow: recent.length,
      steadiness: sd > mean * 0.6 ? 'uneven' : 'steady',
    },
  };
}

/** "about 3 weeks", "about 5 days", "about 4 months", "under a week". */
export function aboutSpan(weeks: number): string {
  const days = weeks * 7;
  if (days < 1.5) return 'about a day';
  if (days < 6.5) return `about ${Math.round(days)} days`;
  if (weeks < 1.5) return 'about a week';
  if (weeks < 9) return `about ${Math.round(weeks)} weeks`;
  const months = weeks / 4.345;
  return months < 1.5 ? 'about a month' : `about ${Math.round(months)} months`;
}

type SpanUnit = 'day' | 'week' | 'month';
const unitOf = (w: number): SpanUnit => (w * 7 < 14 ? 'day' : w < 9 ? 'week' : 'month');
const inUnit = (w: number, u: SpanUnit) => (u === 'day' ? w * 7 : u === 'week' ? w : w / 4.345);
const words = (n: number, u: SpanUnit) => `${n} ${u}${n === 1 ? '' : 's'}`;

/** "2–5 weeks", "4–9 days", "1–3 months", or across units "10 days – 3 weeks". Never rounds the low end up. */
export function spanRange(low: number, high: number): string {
  const hu = unitOf(high);
  const lu = unitOf(low);
  const hi = Math.ceil(inUnit(high, hu));
  if (lu === hu || Math.floor(inUnit(low, hu)) >= 1) {
    const lo = Math.max(1, Math.floor(inUnit(low, hu)));
    return `${lo}–${Math.max(lo + 1, hi)} ${hu}s`;
  }
  return `${words(Math.max(1, Math.floor(inUnit(low, lu))), lu)} – ${words(hi, hu)}`;
}

/** The date a number of weeks from now, as "late October" / "early November". */
export function roughDate(now: number, weeks: number): string {
  const d = new Date(now + weeks * 7 * DAY_MS);
  const part = d.getDate() <= 10 ? 'early' : d.getDate() <= 20 ? 'mid' : 'late';
  const month = new Intl.DateTimeFormat(undefined, { month: 'long', year: d.getFullYear() !== new Date(now).getFullYear() ? 'numeric' : undefined }).format(d);
  return `${part} ${month}`;
}
