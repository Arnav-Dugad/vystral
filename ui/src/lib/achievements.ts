/**
 * Pure helpers for the achievement timeline, the near-completion shelf and unlock toasts.
 * Rarity follows Steam's global unlock percentage: ≤ 5% is "rare", ≤ 1% is "ultra rare".
 */
import type { AchievementFeedItem, AchievementUnlockEvent, NearCompletion } from '../bridge/types';

export const RARE_PERCENT = 5;
export const ULTRA_PERCENT = 1;

export type Rarity = 'ultra' | 'rare' | null;

export function rarity(percent: number | null | undefined): Rarity {
  if (percent == null || !Number.isFinite(percent) || percent < 0) return null;
  if (percent <= ULTRA_PERCENT) return 'ultra';
  if (percent <= RARE_PERCENT) return 'rare';
  return null;
}

/** "0.4%", "3.2%", "27%", "<0.1%". */
export function formatPercent(p: number): string {
  if (p > 0 && p < 0.1) return '<0.1%';
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export interface FeedDay {
  dayStart: number;
  items: AchievementFeedItem[];
  rare: number;
}

/**
 * Groups feed items by the local day they were unlocked, newest day first, newest unlock first.
 * Items with an unreadable timestamp are dropped (the backend only sends dated unlocks).
 */
export function groupFeedByDay(items: readonly AchievementFeedItem[]): FeedDay[] {
  const parsed = items
    .map((item) => ({ item, at: Date.parse(item.unlockedAt) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at || a.item.gameTitle.localeCompare(b.item.gameTitle) || a.item.name.localeCompare(b.item.name));
  const days: FeedDay[] = [];
  for (const { item, at } of parsed) {
    const day = startOfLocalDay(at);
    let current = days[days.length - 1];
    if (!current || current.dayStart !== day) {
      current = { dayStart: day, items: [], rare: 0 };
      days.push(current);
    }
    current.items.push(item);
    if (rarity(item.globalPercent)) current.rare++;
  }
  return days;
}

/** Adds a page to the loaded feed without duplicates (a refresh can shift offsets by a few items). */
export function mergeFeed(current: readonly AchievementFeedItem[], page: readonly AchievementFeedItem[]): AchievementFeedItem[] {
  const key = (i: AchievementFeedItem) => `${i.appId}/${i.apiName}`;
  const seen = new Set(current.map(key));
  return [...current, ...page.filter((i) => !seen.has(key(i)))];
}

/** Games ≥ 70% complete, fewest achievements left first, then most complete, then most recently active. */
export function sortNearCompletion(list: readonly NearCompletion[]): NearCompletion[] {
  return list
    .filter((n) => n.total > 0 && n.unlocked < n.total && n.unlocked / n.total >= 0.7)
    .slice()
    .sort(
      (a, b) =>
        a.total - a.unlocked - (b.total - b.unlocked) ||
        b.unlocked / b.total - a.unlocked / a.total ||
        (b.lastUnlockAt ?? '').localeCompare(a.lastUnlockAt ?? '') ||
        a.gameTitle.localeCompare(b.gameTitle),
    );
}

/** Toast copy for achievements unlocked during a session. */
export function unlockToastText(e: Pick<AchievementUnlockEvent, 'items' | 'gameTitle' | 'rareThreshold' | 'rareCount'>): { title: string; body: string } {
  const n = e.items.length;
  const title = n === 1 ? `Achievement unlocked in ${e.gameTitle}` : `You unlocked ${n} achievements in ${e.gameTitle}`;
  const names = e.items.slice(0, 3).map((i) => i.name);
  let body = names.join(', ') + (n > names.length ? ` and ${n - names.length} more` : '');
  if (e.rareThreshold != null && e.rareCount > 0) {
    const who = e.rareCount === n && n > 1 ? 'All' : String(e.rareCount);
    body = `${who} ${e.rareCount === 1 ? 'is' : 'are'} rarer than ${e.rareThreshold}% of players · ${body}`;
  }
  return { title, body };
}
