/**
 * Track Z: the Immersive screensaver's rules, pure so they're unit-tested — which games it
 * showcases (the ones you haven't touched in a while), when their trailers may play, and the big
 * clock (12/24-hour text, burn-in drift).
 */
import type { Game } from '../../bridge/types';
import type { LiveBlock } from '../../lib/liveTiles';
import { byLastPlayed, isInstalled, lastPlayed } from '../../lib/format';
import { isWaiting } from '../../lib/neverPlayed';
import { playedSeconds } from './rows';

const DAY = 86_400_000;
/** Not played for this long counts as "a while". */
export const STALE_DAYS = 30;
/** Fewer rediscoveries than this and the recent favourites fill in, so the screensaver is never thin. */
const MIN_POOL = 6;
/** … up to this many slides in all. */
const TOP_UP = 12;

export type ShowcaseReason = 'stale' | 'waiting' | 'recent';

export interface Showcase {
  game: Game;
  reason: ShowcaseReason;
}

/**
 * Games to showcase, rediscoveries first: games you played (most-played first) but not in the last
 * {@link STALE_DAYS} days, interleaved two to one with installed games you never started (newest
 * additions first). Only installed games and favourites, so the screensaver never advertises what
 * you can't play. Topped up with your recent games when there are too few.
 */
export function showcasePool(games: readonly Game[], now: number, max = 24): Showcase[] {
  const eligible = games.filter((g) => !g.hidden && (isInstalled(g) || g.favorite));
  const stale = eligible
    .filter((g) => {
      const at = Date.parse(lastPlayed(g).at ?? '');
      return Number.isFinite(at) && now - at >= STALE_DAYS * DAY;
    })
    .sort((a, b) => playedSeconds(b) - playedSeconds(a) || a.sortTitle.localeCompare(b.sortTitle));
  const waiting = eligible
    .filter((g) => isWaiting(g) && isInstalled(g))
    .sort((a, b) => b.added.localeCompare(a.added) || a.sortTitle.localeCompare(b.sortTitle));
  const out: Showcase[] = [];
  let s = 0;
  let w = 0;
  while ((s < stale.length || w < waiting.length) && out.length < max) {
    if (s < stale.length) out.push({ game: stale[s++], reason: 'stale' });
    if (s < stale.length && out.length < max) out.push({ game: stale[s++], reason: 'stale' });
    if (w < waiting.length && out.length < max) out.push({ game: waiting[w++], reason: 'waiting' });
  }
  if (out.length < MIN_POOL) {
    const taken = new Set(out.map((x) => x.game.id));
    const recent = eligible
      .filter((g) => !taken.has(g.id))
      .sort((a, b) => byLastPlayed(a, b) || a.sortTitle.localeCompare(b.sortTitle));
    for (const g of recent) {
      if (out.length >= Math.min(max, TOP_UP)) break;
      out.push({ game: g, reason: 'recent' });
    }
  }
  return out;
}

/** The small line over a showcased game's logo. */
export function showcaseKicker(reason: ShowcaseReason): string | null {
  return reason === 'stale' ? 'It’s been a while' : reason === 'waiting' ? 'Still waiting for you' : null;
}

export type TrailerMode = 'play' | 'pause' | 'off';

/**
 * Whether the screensaver's trailers play. Every live-tile rule applies (Data saver, Offline,
 * Low quality, reduced motion, safe mode, a game running, a hidden window, the live tiles
 * setting), plus the screensaver's own switch; Windows' battery saver pauses them (the frame on
 * screen stays and the slides fall back to still art).
 */
export function trailerMode(c: { enabled: boolean; liveBlock: LiveBlock | null; batterySaver: boolean }): TrailerMode {
  if (!c.enabled || c.liveBlock) return 'off';
  if (c.batterySaver) return 'pause';
  return 'play';
}

/* ------------------------------------------------------------------ the big clock */

export interface ClockParts {
  /** "9:41" or "21:41". */
  time: string;
  /** "PM" / "AM" (as the locale writes it) on a 12-hour clock, else null. */
  period: string | null;
  /** "Tuesday, 7 October". */
  date: string;
  /** Read aloud / for tests: "9:41 PM". */
  label: string;
}

/**
 * The clock's text. `hour12` comes from the Windows regional format (null/undefined = the
 * interface language's default). 24-hour time keeps a leading zero ("09:05"); 12-hour doesn't.
 */
export function clockParts(d: Date, hour12?: boolean | null, locale?: string): ClockParts {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (hour12 != null) {
    opts.hour12 = hour12;
    if (!hour12) opts.hour = '2-digit';
  }
  const parts = new Intl.DateTimeFormat(locale, opts).formatToParts(d);
  const period = parts.find((p) => p.type === 'dayPeriod')?.value ?? null;
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  const sep = parts.find((p, i) => p.type === 'literal' && parts[i - 1]?.type === 'hour')?.value.trim() || ':';
  const time = `${hour}${sep}${minute}`;
  const date = new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  return { time, period, date, label: period ? `${time} ${period}` : time };
}

/** Twelve resting spots on a 4 × 3 grid around the centre (percent of the screen). */
const DRIFT_X = [-4.5, -1.5, 1.5, 4.5];
const DRIFT_Y = [-6, 0, 6];

/**
 * Burn-in protection: where the clock sits during a given minute, as an offset from centre in
 * percent of the screen (x within ±6 %, y within ±8 %). It visits all twelve spots of a grid every
 * twelve minutes in a scattered order (a step of 7 around a cycle of 12, so the next spot is never
 * the same one), each nudged by a small fixed jitter so the pattern never reads as a grid.
 */
export function clockDrift(minute: number): { x: number; y: number } {
  const m = Math.floor(minute);
  const spot = (((m * 7) % 12) + 12) % 12;
  // A small integer hash of the minute → two numbers in [-1, 1].
  let h = Math.imul(m ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  const jx = ((h & 0xffff) / 0xffff) * 2 - 1;
  const jy = (((h >>> 16) & 0xffff) / 0xffff) * 2 - 1;
  return {
    x: Math.round((DRIFT_X[spot % 4] + jx * 0.8) * 100) / 100,
    y: Math.round((DRIFT_Y[Math.floor(spot / 4)] + jy * 1.2) * 100) / 100,
  };
}

/** Minutes since the epoch (the drift's step). */
export const minuteOf = (t: number) => Math.floor(t / 60_000);
