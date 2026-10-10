/**
 * Track D1: "Similar in your library" — games you already own that resemble this one, with the ones you've forgotten
 * (never played, or not for months) lifted to the front. Pure, local and fast: Steam community tags from the library
 * tag map (Track C4), genres, a series guess from the titles, and — when IGDB facts are cached for this game — its
 * series and "similar games" names. Every pick says why in a few words.
 */
import type { Game, LibraryTags } from '../bridge/types';
import { lastPlayed } from './format';
import { hasNeverBeenPlayed } from './neverPlayed';

export interface SimilarFacts {
  /** IGDB "similar games" names for this game (cached facts only). */
  similar?: readonly string[];
  /** IGDB series and franchise names for this game. */
  series?: readonly string[];
}

export interface SimilarPick {
  game: Game;
  score: number;
  /** "Shares Open World · Racing · not played in 8 months". */
  why: string;
  sameSeries: boolean;
  forgotten: 'never' | 'long' | null;
}

const DAY = 86_400_000;
/** Strongest tags of this game that count (Steam lists up to 20; the tail is noise). */
const MY_TAGS = 12;
/** A candidate's tags looked at (its strongest ones). */
const THEIR_TAGS = 15;
/** A pick needs at least this much in common. */
export const MIN_SCORE = 1.4;
/** "Forgotten": not played for this long. */
export const FORGOTTEN_DAYS = 60;

const EDITION = /\b(remastered|remaster|definitive|deluxe|ultimate|complete|goty|game of the year|anniversary|enhanced|director'?s cut|edition|hd|redux|reloaded)\b/g;
const ROMAN = /\b(ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii)\b/g;

/** Lower-case words only, for comparing titles. */
export function normTitle(t: string): string {
  return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The series a title probably belongs to: the part before a subtitle (":" or " - "), without edition words, sequel
 * numbers or roman numerals. "Forza Horizon 5" and "Forza Horizon 4: Premium" share "forza horizon". Null when what's
 * left is too short to mean anything.
 */
export function seriesKey(title: string): string | null {
  const head = title.split(/\s[-–—]\s|:/)[0];
  const k = normTitle(head).replace(EDITION, ' ').replace(ROMAN, ' ').replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  return k.length >= 4 ? k : null;
}

/** "8 months", "a year", "3 years". */
export function awaySpan(days: number): string {
  if (days < 365) {
    const m = Math.max(2, Math.round(days / 30.44));
    return `${m} months`;
  }
  const y = Math.floor(days / 365);
  return y === 1 ? 'a year' : `${y} years`;
}

function forgottenOf(g: Game, now: number): { kind: 'never' | 'long' | 'recent' | null; days: number } {
  if (hasNeverBeenPlayed(g)) return { kind: 'never', days: Infinity };
  const at = lastPlayed(g).at;
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return { kind: null, days: 0 };
  const days = Math.max(0, (now - t) / DAY);
  if (days >= FORGOTTEN_DAYS) return { kind: 'long', days };
  if (days <= 14) return { kind: 'recent', days };
  return { kind: null, days };
}

export function similarInLibrary(
  game: Game,
  library: readonly Game[],
  opts: { tags?: LibraryTags | null; facts?: SimilarFacts | null; now?: number; limit?: number } = {},
): SimilarPick[] {
  const now = opts.now ?? Date.now();
  const tagMap = opts.tags?.games ?? {};
  const tagName = new Map((opts.tags?.tags ?? []).map((t) => [t.id, t.name]));
  const mine = (tagMap[game.id] ?? []).slice(0, MY_TAGS);
  const myWeight = new Map(mine.map((id, i) => [id, 1 - i / (2 * MY_TAGS)]));
  const myGenres = new Map(game.genres.map((g) => [g.trim().toLowerCase(), g.trim()]));
  const mySeries = seriesKey(game.title);
  const igdbSeries = (opts.facts?.series ?? []).map((s) => normTitle(s.replace(/\bseries\b/i, ''))).filter((s) => s.length >= 4);
  const igdbSimilar = new Set((opts.facts?.similar ?? []).map(normTitle).filter(Boolean));
  const myTitle = normTitle(game.title);

  const picks: SimilarPick[] = [];
  for (const g of library) {
    if (g.id === game.id || g.hidden || g.notOwned) continue;
    const title = normTitle(g.title);
    if (title === myTitle) continue; // another edition of the same game
    let score = 0;
    const shared: string[] = [];

    // Community tags: weighted by how strongly players applied them to this game.
    const theirs = (tagMap[g.id] ?? []).slice(0, THEIR_TAGS);
    const hasTags = mine.length > 0 && theirs.length > 0;
    for (const id of theirs) {
      const w = myWeight.get(id);
      if (w == null) continue;
      score += w;
      const name = tagName.get(id);
      if (name) shared.push(name);
    }
    // Keep the shared tags in this game's order (its strongest first).
    shared.sort((a, b) => mine.findIndex((id) => tagName.get(id) === a) - mine.findIndex((id) => tagName.get(id) === b));

    // Genres: worth less when tags already describe both games (they overlap).
    for (const genre of g.genres) {
      const own = myGenres.get(genre.trim().toLowerCase());
      if (!own) continue;
      score += hasTags ? 0.35 : 0.9;
      if (!shared.some((x) => x.toLowerCase() === own.toLowerCase())) shared.push(own);
    }

    const sameSeries = (!!mySeries && seriesKey(g.title) === mySeries) || igdbSeries.some((s) => title.startsWith(s));
    if (sameSeries) score += 3;
    const igdb = igdbSimilar.has(title);
    if (igdb) score += 2;
    if (score < MIN_SCORE) continue;

    // Forgotten games first: never played, or not for months. Games you're playing right now step back a little.
    const f = forgottenOf(g, now);
    if (f.kind === 'never') score *= 1.35;
    else if (f.kind === 'long') score *= 1 + Math.min(0.35, (f.days / 30.44) * 0.03);
    else if (f.kind === 'recent') score *= 0.8;
    if (g.status === 'abandoned') score *= 0.7;

    const parts: string[] = [];
    if (sameSeries) parts.push('Same series');
    if (shared.length) parts.push(`Shares ${shared.slice(0, 2).join(' · ')}`);
    else if (igdb && !sameSeries) parts.push('IGDB calls it similar');
    if (f.kind === 'never') parts.push('never played');
    else if (f.kind === 'long') parts.push(`not played in ${awaySpan(f.days)}`);
    picks.push({ game: g, score, why: parts.join(' · '), sameSeries, forgotten: f.kind === 'never' || f.kind === 'long' ? f.kind : null });
  }
  return picks.sort((a, b) => b.score - a.score || a.game.sortTitle.localeCompare(b.game.sortTitle)).slice(0, opts.limit ?? 10);
}
