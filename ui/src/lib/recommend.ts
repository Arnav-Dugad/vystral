import type { Game } from '../bridge/types';
import { byLastPlayed, isInstalled, lastPlayed } from './format';
import { buildTasteProfile, recommendLibrary, type RecSignals } from './recommendV2';

export interface Suggestion {
  game: Game;
  score: number;
  reason: string;
}

/**
 * Deterministic "what to play" suggestions from the user's own library: installed games only, each with the
 * plain-language reason it was chosen. Track D5: a thin wrapper over the one engine (lib/recommendV2.ts), kept for
 * callers that only have the library; pass `signals` for tags, time to beat, sessions, friends and the rest.
 */
export function suggestGames(games: Game[], now = Date.now(), limit = 10, signals?: Omit<RecSignals, 'now'>): Suggestion[] {
  const s: RecSignals = { ...signals, now };
  const profile = buildTasteProfile(games, s);
  const byId = new Map(games.map((g) => [g.id, g]));
  return recommendLibrary(games, profile, s, { limit, mode: 'installed' }).flatMap((r) => {
    const game = byId.get(r.id);
    return game ? [{ game, score: r.score, reason: r.reason }] : [];
  });
}

/** Featured game for the Home hero: most recently played installed game, else a suggestion. */
export function featuredGame(games: Game[]): Game | null {
  const installed = games.filter((g) => !g.hidden && isInstalled(g));
  const recent = installed.filter((g) => lastPlayed(g).at).sort((a, b) => byLastPlayed(a, b) || a.sortTitle.localeCompare(b.sortTitle));
  return recent[0] ?? suggestGames(games, Date.now(), 1)[0]?.game ?? installed[0] ?? games[0] ?? null;
}
