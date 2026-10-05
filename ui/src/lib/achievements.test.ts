import { describe, expect, it } from 'vitest';
import type { AchievementFeedItem, NearCompletion } from '../bridge/types';
import { formatPercent, groupFeedByDay, mergeFeed, rarity, sortNearCompletion, unlockToastText } from './achievements';

const item = (name: string, at: string, pct: number | null = 50, game = 'Ashen Crown', appId = '100'): AchievementFeedItem => ({
  appId, gameId: null, gameTitle: game, apiName: name, name, description: null, unlockedAt: at, globalPercent: pct, icon: null,
});

describe('rarity', () => {
  it('uses ≤ 5% for rare and ≤ 1% for ultra rare', () => {
    expect(rarity(0.4)).toBe('ultra');
    expect(rarity(1)).toBe('ultra');
    expect(rarity(1.01)).toBe('rare');
    expect(rarity(5)).toBe('rare');
    expect(rarity(5.1)).toBeNull();
    expect(rarity(null)).toBeNull();
    expect(rarity(Number.NaN)).toBeNull();
  });

  it('formats percentages for humans', () => {
    expect(formatPercent(0.05)).toBe('<0.1%');
    expect(formatPercent(3.21)).toBe('3.2%');
    expect(formatPercent(27.6)).toBe('28%');
  });
});

describe('groupFeedByDay', () => {
  it('groups by local day, newest first, and counts rare unlocks', () => {
    const days = groupFeedByDay([
      item('a', new Date(2026, 2, 3, 9).toISOString(), 30),
      item('b', new Date(2026, 2, 4, 23, 30).toISOString(), 0.8),
      item('c', new Date(2026, 2, 4, 0, 10).toISOString(), 4),
      item('bad', 'not a date'),
    ]);
    expect(days.map((d) => new Date(d.dayStart).getDate())).toEqual([4, 3]);
    expect(days[0].items.map((i) => i.name)).toEqual(['b', 'c']);
    expect(days[0].rare).toBe(2);
    expect(days[1].rare).toBe(0);
  });

  it('merges pages without duplicates', () => {
    const a = item('a', '2026-03-03T10:00:00Z');
    const b = item('b', '2026-03-02T10:00:00Z');
    expect(mergeFeed([a], [a, b]).map((i) => i.name)).toEqual(['a', 'b']);
    expect(mergeFeed([a], [{ ...a, appId: '200' }])).toHaveLength(2);
  });
});

describe('sortNearCompletion', () => {
  const n = (appId: string, total: number, unlocked: number, last: string | null = null): NearCompletion => ({
    appId, gameId: null, gameTitle: `Game ${appId}`, unlocked, total, remaining: total - unlocked, fraction: unlocked / total,
    rarestRemainingName: null, rarestRemainingPercent: null, rarestRemainingHidden: false, lastUnlockAt: last,
  });

  it('puts the closest games first and drops finished or distant ones', () => {
    const sorted = sortNearCompletion([n('a', 10, 7), n('b', 50, 47), n('c', 4, 3), n('d', 20, 20), n('e', 10, 6), n('f', 100, 97, '2026-03-02')]);
    expect(sorted.map((x) => x.appId)).toEqual(['c', 'f', 'b', 'a']);
  });
});

describe('unlockToastText', () => {
  it('summarises unlocks with the rarity threshold', () => {
    const items = [item('Grave Robber', '2026-03-03T10:00:00Z', 1.4), item('First Step', '2026-03-03T10:00:00Z', 60), item('Collector', '2026-03-03T10:00:00Z', 22)];
    expect(unlockToastText({ items, gameTitle: 'Ashen Crown', rareThreshold: 2, rareCount: 1 })).toEqual({
      title: 'You unlocked 3 achievements in Ashen Crown',
      body: '1 is rarer than 2% of players · Grave Robber, First Step, Collector',
    });
  });

  it('handles one unlock and many unlocks', () => {
    expect(unlockToastText({ items: [item('Solo', 'x')], gameTitle: 'G', rareThreshold: null, rareCount: 0 })).toEqual({ title: 'Achievement unlocked in G', body: 'Solo' });
    const many = Array.from({ length: 5 }, (_, i) => item(`A${i}`, 'x', 0.5));
    expect(unlockToastText({ items: many, gameTitle: 'G', rareThreshold: 1, rareCount: 5 }).body).toBe('All are rarer than 1% of players · A0, A1, A2 and 2 more');
  });
});
