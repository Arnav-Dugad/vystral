import type { AchievementFeedItem } from '../../bridge/types';

/** Track L: rare unlocks worth an attract-mode slide — ≤10% of players, newest first, at most six. */
export function highlightAchievements(items: readonly AchievementFeedItem[], max = 6): AchievementFeedItem[] {
  return items
    .filter((i) => i.globalPercent != null && i.globalPercent <= 10)
    .sort((a, b) => b.unlockedAt.localeCompare(a.unlockedAt))
    .slice(0, max);
}
