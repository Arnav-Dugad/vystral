import type { Game, PlatformKey } from '../bridge/types';
import { byLastPlayed, isInstalled, isMissing, lastPlayed } from './format';
import { neverPlayedGames, tonightPicks } from './neverPlayed';
import { featuredGame } from './recommend';
import { buildTasteProfile, gameFeatures, recommendLibrary, tasteMatch } from './recommendV2';

/**
 * Track AA: what Home shows, as game ids and a few numbers. Home renders from this, both from the live
 * library and from the cached first-paint snapshot (lib/firstPaint.ts), so the two produce the same
 * component tree and cards keep their identity when the live library replaces the cached one.
 */
export interface HomeModel {
  featuredId: string | null;
  continueIds: string[];
  suggestions: { id: string; reason: string }[];
  favoriteIds: string[];
  /** All favorites (the id list may be shortened in a snapshot). */
  favoriteCount: number;
  recentIds: string[];
  never: { count: number; picks: { id: string; reason: string }[]; restIds: string[] };
  pulse: { installed: number; needsClient: number; missing: number; platforms: [PlatformKey, number][] };
  /** Visible (not hidden) games in the library. */
  visibleCount: number;
}

const DAY = 86_400_000;

/** The Home view-model for a library (`games` should already exclude hidden games). Pure. */
export function buildHomeModel(visible: Game[], now: number): HomeModel {
  const featured = featuredGame(visible);
  // Track C1: the hero's game stays in Continue playing too (as its first card when it's the latest one): people
  // look for what they just played in the row, and a row that skips it reads as if the game went missing.
  const continueIds = visible
    .filter((g) => isInstalled(g) && lastPlayed(g).at)
    .sort((a, b) => byLastPlayed(a, b) || a.sortTitle.localeCompare(b.sortTitle))
    .slice(0, 12)
    .map((g) => g.id);
  const favorites = visible.filter((g) => g.favorite).sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  const recentIds = [...visible]
    .sort((a, b) => b.added.localeCompare(a.added))
    .filter((g) => now - Date.parse(g.added) < 30 * DAY)
    .slice(0, 16)
    .map((g) => g.id);
  // Track D5: one engine (recommend.v2) for "Picked for you" and the never-played "tonight" picks.
  const signals = { now };
  const profile = buildTasteProfile(visible, signals);
  const suggestions = recommendLibrary(visible, profile, signals, { limit: 12 }).map((r) => ({ id: r.id, reason: r.reason }));

  const waiting = neverPlayedGames(visible);
  const picks = tonightPicks(visible, now, 3, (g) => tasteMatch(gameFeatures(g), profile).match).map((p) => ({ id: p.game.id, reason: p.reason }));
  const pickIds = new Set(picks.map((p) => p.id));
  const restIds = waiting.filter((g) => !pickIds.has(g.id)).slice(0, 24).map((g) => g.id);

  const installed = visible.filter(isInstalled);
  const missing = visible.filter(isMissing).length;
  const needsClient = installed.filter((g) => g.installations.every((i) => i.state !== 'installed' || i.clientRequired)).length;
  const byPlatform = new Map<PlatformKey, number>();
  for (const g of installed) for (const p of new Set(g.installations.map((i) => i.platform))) byPlatform.set(p, (byPlatform.get(p) ?? 0) + 1);

  return {
    featuredId: featured?.id ?? null,
    continueIds,
    suggestions,
    favoriteIds: favorites.map((g) => g.id),
    favoriteCount: favorites.length,
    recentIds,
    never: { count: waiting.length, picks, restIds },
    pulse: { installed: installed.length, needsClient, missing, platforms: [...byPlatform.entries()].sort((a, b) => b[1] - a[1]) },
    visibleCount: visible.length,
  };
}

/** Every game id the model shows, featured first (no duplicates). */
export function homeModelIds(m: HomeModel): string[] {
  const ids = new Set<string>();
  if (m.featuredId) ids.add(m.featuredId);
  for (const id of m.continueIds) ids.add(id);
  for (const s of m.suggestions) ids.add(s.id);
  for (const id of m.favoriteIds) ids.add(id);
  for (const id of m.recentIds) ids.add(id);
  for (const p of m.never.picks) ids.add(p.id);
  for (const id of m.never.restIds) ids.add(id);
  return [...ids];
}

/** Looks the ids up, dropping any that aren't there (never a hole on a shelf). */
export function gamesFor(ids: readonly string[], byId: ReadonlyMap<string, Game>): Game[] {
  const out: Game[] = [];
  for (const id of ids) {
    const g = byId.get(id);
    if (g) out.push(g);
  }
  return out;
}
