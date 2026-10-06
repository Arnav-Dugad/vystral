/**
 * Track M: "While you were away" text and links. Pure and unit-tested; the data comes from
 * call('away.summary') (sessions VYSTRAL noticed without launching them since Home was last opened).
 */
import type { AwaySummary, RecapAchievement, RecapSession } from '../bridge/types';
import { formatDuration, plural } from './format';
import { startOfDay } from '../views/journal/stats';

export function awayHeadline(s: AwaySummary): string {
  const games = s.games.length;
  return games === 1
    ? `You played ${s.games[0].title} for ${formatDuration(s.totalSeconds)}`
    : `You played ${plural(games, 'game')} for ${formatDuration(s.totalSeconds)}`;
}

/** Where the sessions came from, in plain words (background tracker while closed vs noticed while open). */
export function awayOrigin(s: AwaySummary): string {
  const bg = s.sessions.filter((x) => x.source === 'background').length;
  const detected = s.sessions.length - bg;
  if (detected === 0) return 'Tracked by VYSTRAL’s background helper while the app was closed';
  if (bg === 0) return 'Started outside VYSTRAL and noticed while it was open';
  return 'Started outside VYSTRAL — some while the app was closed';
}

/** The rarest unlock first, then newest. */
export function sortAchievements(list: RecapAchievement[]): RecapAchievement[] {
  return [...list].sort((a, b) => (a.globalPercent ?? 101) - (b.globalPercent ?? 101) || b.unlockedAt.localeCompare(a.unlockedAt));
}

/** Local start-of-day (ms) of a session, for the Journal day deep link. */
export function journalDay(session: Pick<RecapSession, 'start'>): number {
  return startOfDay(Date.parse(session.start));
}

export type AwayLink = { name: 'performance'; sessionId: string } | { name: 'journal'; tab: 'sessions'; day: number };

/** A session with recorded metrics opens in Performance; otherwise its day in the Journal. */
export function sessionLink(session: RecapSession): AwayLink {
  return session.perf.hasMetrics ? { name: 'performance', sessionId: session.id } : { name: 'journal', tab: 'sessions', day: journalDay(session) };
}

/** The latest day any of the sessions touched (for "Open in Journal"). */
export function latestDay(s: AwaySummary): number | null {
  const starts = s.sessions.map((x) => Date.parse(x.start)).filter(Number.isFinite);
  return starts.length ? startOfDay(Math.max(...starts)) : null;
}
