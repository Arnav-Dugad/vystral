import type { Game } from '../bridge/types';
import { lastPlayed } from './format';
import { titleScore } from './search';

/**
 * Predictions for the on-screen keyboard, built only from titles in the user's own library:
 * - games: the best title matches (same scoring as the command bar), recent play breaking ties;
 *   with nothing typed yet, the games you played most recently.
 * - words: completions of the word being typed ("kin" → "Kingsfall") and, after a space,
 *   the word that follows in matching titles ("ashen " → "Crown"), so a title can be
 *   entered in a couple of presses.
 */

export interface WordPrediction {
  /** The word as it appears in a title. */
  word: string;
  /** The whole query after accepting it (with a trailing space, ready for the next word). */
  query: string;
}

const WORD_SPLIT = /[^\p{L}\p{N}'’]+/u;

function titleWords(title: string): string[] {
  return title
    .split(WORD_SPLIT)
    .map((w) => w.replace(/^['’]+|['’]+$/g, ''))
    .filter((w) => w.length > 0);
}

const lower = (s: string) => s.toLocaleLowerCase();

function recency(g: Game): number {
  const at = lastPlayed(g).at;
  return at ? Date.parse(at) : 0;
}

export function predictGames(games: Game[], query: string, limit = 7): Game[] {
  const visible = games.filter((g) => !g.hidden);
  const q = query.trim();
  if (!q) {
    return visible
      .filter((g) => recency(g) > 0)
      .sort((a, b) => recency(b) - recency(a) || a.sortTitle.localeCompare(b.sortTitle))
      .slice(0, limit);
  }
  const scored: { g: Game; s: number; r: number }[] = [];
  for (const g of visible) {
    const s = titleScore(g.title, q);
    if (s > 0) scored.push({ g, s, r: recency(g) });
  }
  scored.sort((a, b) => b.s - a.s || b.r - a.r || a.g.sortTitle.localeCompare(b.g.sortTitle));
  return scored.slice(0, limit).map((x) => x.g);
}

export function predictWords(games: Game[], query: string, limit = 4): WordPrediction[] {
  const tokens = query.replace(/^\s+/, '').split(/\s+/);
  const fragment = lower(tokens[tokens.length - 1] ?? '');
  const context = tokens.slice(0, -1).filter(Boolean);
  if (!fragment && context.length === 0) return [];
  const contextQuery = context.join(' ');
  const prefix = context.length ? `${contextQuery} ` : '';

  // Count each candidate once per title, remembering how the title spells it.
  const counts = new Map<string, { word: string; n: number }>();
  const add = (w: string) => {
    const key = lower(w);
    const hit = counts.get(key);
    if (hit) hit.n++;
    else counts.set(key, { word: w, n: 1 });
  };

  for (const g of games) {
    if (g.hidden) continue;
    // Only titles that match the words already typed (as word prefixes) contribute.
    if (context.length && titleScore(g.title, contextQuery) < 70) continue;
    const words = titleWords(g.title);
    if (fragment) {
      const seen = new Set<string>();
      for (const w of words) {
        const lw = lower(w);
        if (lw.length > fragment.length && lw.startsWith(fragment) && !seen.has(lw)) {
          seen.add(lw);
          add(w);
        }
      }
    } else {
      // Next word: the word after the last typed one.
      const lastTyped = lower(context[context.length - 1]);
      const i = words.findIndex((w) => lower(w).startsWith(lastTyped));
      if (i >= 0 && i + 1 < words.length) add(words[i + 1]);
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.word.length - b.word.length || a.word.localeCompare(b.word))
    .slice(0, limit)
    .map(({ word }) => ({ word, query: `${prefix}${word} ` }));
}
