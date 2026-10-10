/**
 * "Owned but never played": games in the library with no playtime anywhere — no store-reported
 * minutes, no store last-played date and no session tracked by VYSTRAL. Pure, so the selection,
 * the age labels and the "Try it tonight" picks are unit-tested.
 *
 * Honest dates: stores don't tell VYSTRAL when you bought something, so the age is the date
 * VYSTRAL first saw the game (`Game.added`), and the label says so. If a store ever provides an
 * acquisition date it goes first in {@link ownedSince} with its own label.
 */
import type { Game } from '../bridge/types';
import { importedMinutes, isInstalled, lastPlayed } from './format';
import { hashString } from './color';

/** Statuses that mean "I've dealt with this one" — never offered as unplayed picks. */
const DONE = new Set(['beaten', 'completed', 'abandoned']);

/**
 * The one definition of "never played", used by Home, the Library filter, search and suggestions:
 * no session VYSTRAL recorded, no tracked time, no store last-played date and no store playtime.
 * Ignores whether the game is hidden (callers decide that).
 */
export function hasNeverBeenPlayed(g: Game): boolean {
  if (g.trackedSeconds > 0 || g.sessionCount > 0) return false;
  // Track D1: the user said they played it somewhere VYSTRAL can't see.
  if (g.playedMarkedAt) return false;
  if (lastPlayed(g).at) return false;
  const minutes = importedMinutes(g);
  return minutes == null || minutes <= 0;
}

/** Never played and visible in the library. */
export function isNeverPlayed(g: Game): boolean {
  return !g.hidden && hasNeverBeenPlayed(g);
}

/** Never played and not marked as finished or abandoned. */
export function isWaiting(g: Game): boolean {
  return isNeverPlayed(g) && !DONE.has(g.status ?? '');
}

export interface OwnedSince {
  at: string;
  /** Where the date comes from: currently always the first time VYSTRAL saw the game. */
  source: 'firstSeen';
}

export function ownedSince(g: Game): OwnedSince | null {
  return Number.isFinite(Date.parse(g.added)) ? { at: g.added, source: 'firstSeen' } : null;
}

const DAY = 86_400_000;

/** "3 years", "5 months", "2 weeks", "4 days", "today" — the span only, for composing labels. */
export function ageSpan(fromIso: string, now = Date.now()): string {
  const days = Math.max(0, Math.floor((now - Date.parse(fromIso)) / DAY));
  if (days < 1) return 'today';
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'}`;
  if (days < 60) {
    const w = Math.floor(days / 7);
    return `${w} ${w === 1 ? 'week' : 'weeks'}`;
  }
  if (days < 365) {
    const m = Math.floor(days / 30.44);
    return `${m} ${m === 1 ? 'month' : 'months'}`;
  }
  const y = Math.floor(days / 365.25);
  return `${y} ${y === 1 ? 'year' : 'years'}`;
}

/** Short caption under a card: "In VYSTRAL for 3 years" / "New to VYSTRAL today". */
export function ageLabel(g: Game, now = Date.now()): string {
  const since = ownedSince(g);
  if (!since) return 'Never played';
  const span = ageSpan(since.at, now);
  return span === 'today' ? 'New to VYSTRAL today' : `In VYSTRAL for ${span}`;
}

/** Tooltip/explanation of where the age comes from. */
export function ageSourceNote(source: OwnedSince['source']): string {
  return source === 'firstSeen'
    ? 'Counted from when VYSTRAL first found it in your library. Stores don’t share purchase dates.'
    : '';
}

/** Never-played games, longest-waiting first (ties: title). */
export function neverPlayedGames(games: readonly Game[]): Game[] {
  return games
    .filter(isWaiting)
    .sort((a, b) => (ownedSince(a)?.at ?? '9').localeCompare(ownedSince(b)?.at ?? '9') || a.sortTitle.localeCompare(b.sortTitle));
}

export interface TonightPick {
  game: Game;
  reason: string;
}

/**
 * Up to `count` gentle suggestions for tonight. Installed games come first (you can start right
 * away), then backlog-marked ones, then the longest-waiting. The order rotates daily with a stable
 * seed so the shelf changes from day to day but not between renders.
 */
export function tonightPicks(games: readonly Game[], now = Date.now(), count = 3): TonightPick[] {
  const pool = neverPlayedGames(games);
  if (pool.length === 0) return [];
  const day = Math.floor(now / DAY);
  const score = (g: Game) => {
    let s = 0;
    if (isInstalled(g)) s += 4;
    if (g.status === 'backlog') s += 2;
    if (g.favorite) s += 1.5;
    const since = ownedSince(g);
    if (since) s += Math.min(2, (now - Date.parse(since.at)) / (365 * DAY)); // up to +2 for two years waiting
    s += ((hashString(`${g.id}:${day}`) % 1000) / 1000) * 1.5; // daily rotation
    return s;
  };
  return pool
    .map((g) => ({ g, s: score(g) }))
    .sort((a, b) => b.s - a.s || a.g.sortTitle.localeCompare(b.g.sortTitle))
    .slice(0, count)
    .map(({ g }) => ({ game: g, reason: pickReason(g, now) }));
}

function pickReason(g: Game, now: number): string {
  const since = ownedSince(g);
  const waiting = since ? ageSpan(since.at, now) : null;
  if (isInstalled(g)) return waiting && waiting !== 'today' ? `Installed and waiting ${waiting}` : 'Installed and ready';
  if (g.status === 'backlog') return 'On your backlog';
  return waiting && waiting !== 'today' ? `Waiting ${waiting} · install from its store` : 'Install from its store';
}
