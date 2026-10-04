import type { Game } from '../bridge/types';
import { importedMinutes, isInstalled, lastPlayed } from './format';

export interface Suggestion {
  game: Game;
  score: number;
  reason: string;
}

/**
 * Deterministic "what to play" suggestions from the user's own library. Every suggestion
 * carries the plain-language reason it was chosen; nothing here needs AI or the network.
 */
export function suggestGames(games: Game[], now = Date.now(), limit = 10): Suggestion[] {
  const playSeconds = (g: Game) => g.trackedSeconds + (importedMinutes(g) ?? 0) * 60;

  // Genre affinity: how much time the user spends in each genre.
  const affinity = new Map<string, number>();
  let total = 0;
  for (const g of games) {
    const s = playSeconds(g);
    if (s <= 0) continue;
    total += s;
    for (const genre of g.genres) affinity.set(genre, (affinity.get(genre) ?? 0) + s);
  }

  const out: Suggestion[] = [];
  for (const g of games) {
    if (g.hidden || !isInstalled(g)) continue;
    const lp = lastPlayed(g).at;
    const daysSince = lp ? (now - Date.parse(lp)) / 86400000 : Infinity;
    if (daysSince < 2) continue; // already playing it

    let topGenre: string | null = null;
    let genreScore = 0;
    for (const genre of g.genres) {
      const a = total > 0 ? (affinity.get(genre) ?? 0) / total : 0;
      if (a > genreScore) {
        genreScore = a;
        topGenre = genre;
      }
    }
    let score = genreScore * 4;
    let reason: string;
    if (!lp && g.trackedSeconds === 0) {
      score += 1.2;
      reason = topGenre && genreScore > 0.15 ? `Unplayed · you like ${topGenre}` : 'Installed, never played';
    } else if (daysSince > 21) {
      score += Math.min(2, daysSince / 60) + (playSeconds(g) > 5 * 3600 ? 1 : 0);
      const weeks = Math.round(daysSince / 7);
      reason = `Last played ${weeks > 8 ? `${Math.round(daysSince / 30)} months` : `${weeks} weeks`} ago`;
    } else {
      score += 0.6;
      reason = topGenre ? `You play a lot of ${topGenre}` : 'Ready to play';
    }
    if (g.favorite) {
      score += 1;
      reason = `Favorite · ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
    }
    if (g.userRating) score += (g.userRating - 3) * 0.4;
    out.push({ game: g, score, reason });
  }
  return out.sort((a, b) => b.score - a.score || a.game.sortTitle.localeCompare(b.game.sortTitle)).slice(0, limit);
}

/** Featured game for the Home hero: most recently played installed game, else a suggestion. */
export function featuredGame(games: Game[]): Game | null {
  const installed = games.filter((g) => !g.hidden && isInstalled(g));
  const recent = installed
    .map((g) => ({ g, at: lastPlayed(g).at }))
    .filter((x) => x.at)
    .sort((a, b) => b.at!.localeCompare(a.at!));
  return recent[0]?.g ?? suggestGames(games, Date.now(), 1)[0]?.game ?? installed[0] ?? games[0] ?? null;
}
