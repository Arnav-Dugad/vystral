/**
 * Achievement unlock shimmer: which tint a sweep gets, and which unlocks are "new to you" on a
 * surface (so the sweep plays once, the first time you see them). Pure apart from the small
 * last-visit store, which tolerates storage being unavailable.
 */
import { rarity } from './achievements';

/** common: subtle silver · rare (≤5% of players): gold · ultra rare (≤1%): prismatic. */
export type ShimmerTier = 'common' | 'rare' | 'ultra';

export function shimmerTier(globalPercent: number | null | undefined): ShimmerTier {
  return rarity(globalPercent) ?? 'common';
}

const RANK: Record<ShimmerTier, number> = { common: 0, rare: 1, ultra: 2 };

/** The rarest tier among several unlocks (a toast tints itself by its best item). */
export function bestTier(tiers: readonly (ShimmerTier | null | undefined)[]): ShimmerTier {
  let best: ShimmerTier = 'common';
  for (const t of tiers) if (t && RANK[t] > RANK[best]) best = t;
  return best;
}

const DAY = 86_400_000;
/** On a first visit, unlocks from the last day count as new. */
export const FIRST_VISIT_WINDOW = DAY;
/** Never shimmer anything older than this, however long you've been away. */
export const MAX_FRESH_AGE = 14 * DAY;

/** True when an unlock happened after `since` and recently enough to still feel like news. */
export function isFresh(unlockedAt: string | null | undefined, since: number, now = Date.now()): boolean {
  if (!unlockedAt) return false;
  const t = Date.parse(unlockedAt);
  return Number.isFinite(t) && t > since && now - t <= MAX_FRESH_AGE && t <= now + 60_000;
}

const KEY = 'vystral.achievements.lastSeen.v1';

function readAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * The previous visit to a surface ("timeline", "game:<id>"), recording this one. Unlocks newer than
 * the returned time are new to you. Keeps at most 200 surfaces.
 */
export function takeLastSeen(scope: string, now = Date.now()): number {
  const all = readAll();
  const prev = typeof all[scope] === 'number' && Number.isFinite(all[scope]) ? all[scope] : now - FIRST_VISIT_WINDOW;
  all[scope] = now;
  const entries = Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, 200);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // storage unavailable: everything from the last day counts as new each time — harmless
  }
  return prev;
}
