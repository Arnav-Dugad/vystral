import { describe, expect, it } from 'vitest';
import type { NewsBlock } from '../bridge/types';
import { commonness, formatMinutes, formatPercent, friendsPlayedHeadline, groupNewsBlocks, sinceLastPlayed, updatedSince } from './steamExtras';

describe('friends who played', () => {
  it('names one or two friends and counts more', () => {
    expect(friendsPlayedHeadline([])).toBe('None of your friends played this recently');
    expect(friendsPlayedHeadline([{ name: 'Rook' }])).toBe('Rook played this recently');
    expect(friendsPlayedHeadline([{ name: 'Rook' }, { name: 'Juniper' }])).toBe('Rook and Juniper played this recently');
    expect(friendsPlayedHeadline([{ name: 'A' }, { name: 'B' }, { name: 'C' }])).toBe('3 friends played this recently');
  });

  it('formats minutes', () => {
    expect(formatMinutes(0)).toBe('1 min');
    expect(formatMinutes(45)).toBe('45 min');
    expect(formatMinutes(185)).toBe('3 h 5 min');
    expect(formatMinutes(600)).toBe('10 h');
  });
});

describe('achievement guide words', () => {
  it('turns global percentages into plain words', () => {
    expect(commonness(72).label).toBe('Most players get this');
    expect(commonness(30).tone).toBe('easy');
    expect(commonness(8).label).toBe('Uncommon');
    expect(commonness(2).label).toBe('Rare');
    expect(commonness(0.4).label).toBe('Ultra rare');
    expect(commonness(null).tone).toBe('unknown');
    expect(formatPercent(0.05)).toBe('<0.1%');
    expect(formatPercent(4.25)).toBe('4.3%');
    expect(formatPercent(64.5)).toBe('65%');
  });
});

describe('news', () => {
  const b = (kind: NewsBlock['kind'], text = 'x'): NewsBlock => ({ kind, spans: [{ text }], image: null, imageId: null });

  it('groups consecutive list items into one list', () => {
    const groups = groupNewsBlocks([b('h'), b('li', '1'), b('li', '2'), b('p'), b('li', '3')]);
    expect(groups.map((g) => g.kind)).toEqual(['block', 'list', 'block', 'list']);
    expect(groups[1].kind === 'list' && groups[1].items.length).toBe(2);
    expect(groupNewsBlocks([])).toEqual([]);
  });

  it('highlights posts newer than your last session', () => {
    const posts = [
      { date: '2026-03-09T10:00:00Z', patch: true },
      { date: '2026-03-08T10:00:00Z', patch: false },
      { date: '2026-03-01T10:00:00Z', patch: true },
    ];
    expect(updatedSince(posts[0], '2026-03-05T00:00:00Z')).toBe(true);
    expect(updatedSince(posts[2], '2026-03-05T00:00:00Z')).toBe(false);
    expect(updatedSince(posts[0], null)).toBe(false);
    expect(updatedSince({ date: 'bad' }, '2026-03-05T00:00:00Z')).toBe(false);
    expect(sinceLastPlayed(posts, '2026-03-05T00:00:00Z')).toEqual({ count: 2, patches: 1 });
    expect(sinceLastPlayed(posts, undefined)).toEqual({ count: 0, patches: 0 });
  });
});
