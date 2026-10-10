/**
 * Track D1: the library, achievement and time-to-beat facts the newer personal records read. Everything is local:
 * the achievement feed is VYSTRAL's own cache (read a page at a time, capped), estimates come from the cached IGDB
 * facts, and nothing here asks the network for anything.
 */
import { useEffect, useMemo, useState } from 'react';
import { call, on } from '../../bridge/bridge';
import type { AchievementFeed, Game } from '../../bridge/types';
import { useTimeToBeatMap } from '../../state/recap';
import type { RecordContext } from './records';

/** Unlocks read for the "most achievements in a day" record (newest first, so a capped read keeps the recent ones). */
export const MAX_UNLOCKS = 3000;
const PAGE = 100;

export function useAchievementUnlocks(): { gameId: string | null; unlockedAt: string }[] | null {
  const [list, setList] = useState<{ gameId: string | null; unlockedAt: string }[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const out: { gameId: string | null; unlockedAt: string }[] = [];
      try {
        for (let offset = 0; offset < MAX_UNLOCKS; offset += PAGE) {
          const feed = await call<AchievementFeed>('achievements.feed', { offset, limit: PAGE });
          if (!alive || !feed || !Array.isArray(feed.items)) return;
          for (const i of feed.items) if (typeof i?.unlockedAt === 'string') out.push({ gameId: typeof i.gameId === 'string' ? i.gameId : null, unlockedAt: i.unlockedAt });
          if (!feed.hasMore || feed.items.length === 0) break;
        }
      } catch {
        // No achievement data (Steam not connected, or an error): the record stays locked.
      }
      if (alive) setList(out);
    };
    void load();
    const offs = [on('achievements.unlocked', () => void load()), on('steam.achievementsUpdated', () => void load())];
    return () => {
      alive = false;
      offs.forEach((off) => off());
    };
  }, []);
  return list;
}

export function useRecordContext(gamesById: Map<string, Game>): RecordContext {
  const achievements = useAchievementUnlocks();
  const ttb = useTimeToBeatMap();
  return useMemo(() => ({ games: gamesById, achievements: achievements ?? undefined, ttb: ttb?.games ?? null }), [gamesById, achievements, ttb]);
}
