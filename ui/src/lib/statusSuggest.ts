/**
 * Smart status suggestions. They are only ever *offered* (a chip in the status picker);
 * nothing here changes a game's status on its own. Pure, so it is unit-tested.
 */
import type { Game, GameStatus } from '../bridge/types';

const DAY = 86_400_000;

export interface StatusSuggestion {
  /** Stable id per rule and game state, so a dismissal sticks until the situation changes. */
  id: string;
  status: GameStatus;
  /** The question shown to the user. */
  text: string;
}

export interface SuggestInput {
  game: Pick<Game, 'id' | 'status' | 'statusChangedAt' | 'installations' | 'trackedSeconds' | 'sessionCount'>;
  /** Start times (ms) of sessions VYSTRAL tracked for this game, any order. */
  sessionStarts: readonly number[];
  now: number;
}

export const PLAYING_SESSIONS = 3;
export const PLAYING_WINDOW_DAYS = 7;
export const STALE_DAYS = 45;

const COUNT_WORD = ['zero', 'once', 'twice'];
const times = (n: number) => (n < COUNT_WORD.length ? COUNT_WORD[n] : `${n} times`);

/** The single most useful suggestion for a game, or null. */
export function suggestStatus({ game, sessionStarts, now }: SuggestInput): StatusSuggestion | null {
  const status = game.status ?? null;
  const recent = sessionStarts.filter((t) => t <= now && now - t < PLAYING_WINDOW_DAYS * DAY).length;

  // Played a lot this week but not marked Playing. Finished games may simply be replayed: leave them alone.
  if ((status === null || status === 'backlog' || status === 'abandoned') && recent >= PLAYING_SESSIONS)
    return { id: `playing:${status ?? 'none'}`, status: 'playing', text: `You’ve played this ${times(recent)} this week — mark as Playing?` };

  // Marked Playing a while ago, but nothing recent anywhere we can see.
  if (status === 'playing') {
    const last = lastPlayedMs(game, sessionStarts);
    const markedAt = game.statusChangedAt ? Date.parse(game.statusChangedAt) : NaN;
    const markedLongAgo = !Number.isFinite(markedAt) || now - markedAt > STALE_DAYS * DAY;
    if (last !== null && markedLongAgo && now - last > STALE_DAYS * DAY) {
      const weeks = Math.floor((now - last) / (7 * DAY));
      return { id: `stale:${Math.floor(last / DAY)}`, status: 'backlog', text: `Not played in ${weeks} weeks — move back to Backlog?` };
    }
  }

  // Never started anywhere, installed, and no status yet.
  if (status === null && sessionStarts.length === 0 && game.trackedSeconds === 0 && neverPlayedInStores(game) && game.installations.some((i) => i.state === 'installed'))
    return { id: 'unstarted', status: 'backlog', text: 'Not started yet — add it to your Backlog?' };

  return null;
}

function lastPlayedMs(game: SuggestInput['game'], sessionStarts: readonly number[]): number | null {
  let last: number | null = null;
  for (const t of sessionStarts) if (last === null || t > last) last = t;
  for (const i of game.installations) {
    const t = i.importedLastPlayed ? Date.parse(i.importedLastPlayed) : NaN;
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
}

function neverPlayedInStores(game: SuggestInput['game']): boolean {
  return game.installations.every((i) => !i.importedLastPlayed && !i.importedPlaytimeMinutes);
}

/* ------------------------------------------------------------ dismissals (per viewer) */

const KEY = 'vystral.statusSuggest.dismissed';

export function isDismissed(gameId: string, id: string): boolean {
  try {
    const map = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
    return map[gameId] === id;
  } catch {
    return false;
  }
}

export function dismiss(gameId: string, id: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
    map[gameId] = id;
    const keys = Object.keys(map);
    if (keys.length > 500) delete map[keys[0]];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the chip simply comes back next time.
  }
}
