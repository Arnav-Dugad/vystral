import { describe, expect, it } from 'vitest';
import type { MediaItem } from '../../bridge/types';
import { buildRows, columnsFor, filterItems, flatten, gameFacets, groupByMonth, matchLabel, monthKey, monthLabel } from './grouping';

const item = (name: string, modifiedAt: string, extra: Partial<MediaItem> = {}): MediaItem => ({
  url: `https://media.vystral.example/${name}`,
  thumbUrl: `https://media.vystral.example/t/${name}`,
  name,
  kind: 'image',
  folderId: 'f1',
  modifiedAt,
  sizeBytes: 1000,
  gameId: null,
  matchedBy: null,
  ...extra,
});

describe('monthKey', () => {
  it('uses local time and pads the month', () => {
    const d = new Date(2026, 2, 15, 12);
    expect(monthKey(d.toISOString())).toBe('2026-03');
  });
  it('returns null for invalid dates', () => {
    expect(monthKey('not a date')).toBeNull();
  });
});

describe('groupByMonth', () => {
  const items = [
    item('a', new Date(2026, 0, 5).toISOString()),
    item('b', new Date(2026, 2, 1).toISOString()),
    item('c', 'garbage'),
    item('d', new Date(2026, 2, 20).toISOString()),
    item('e', new Date(2025, 11, 31).toISOString()),
  ];

  it('groups newest month first with newest items first and unknown last', () => {
    const groups = groupByMonth(items);
    expect(groups.map((g) => g.key)).toEqual(['2026-03', '2026-01', '2025-12', 'unknown']);
    expect(groups[0].items.map((i) => i.name)).toEqual(['d', 'b']);
    expect(groups[3].items.map((i) => i.name)).toEqual(['c']);
    expect(groups[3].year).toBeNull();
  });

  it('handles empty input', () => {
    expect(groupByMonth([])).toEqual([]);
  });

  it('labels months', () => {
    expect(monthLabel({ year: 2026, month: 2 }, 'en-US')).toBe('March 2026');
    expect(monthLabel({ year: null, month: null })).toBe('Unknown date');
  });
});

describe('filters and facets', () => {
  const items = [
    item('a', '2026-01-01T00:00:00Z', { gameId: 'g1', matchedBy: 'steam-appid' }),
    item('b', '2026-01-02T00:00:00Z', { gameId: 'g1', matchedBy: 'filename', kind: 'video' }),
    item('c', '2026-01-03T00:00:00Z', { gameId: 'g2', matchedBy: 'filename' }),
    item('d', '2026-01-04T00:00:00Z'),
  ];

  it('filters by game, unsorted and kind', () => {
    expect(filterItems(items, { type: 'all' }, 'all')).toHaveLength(4);
    expect(filterItems(items, { type: 'game', id: 'g1' }, 'all').map((i) => i.name)).toEqual(['a', 'b']);
    expect(filterItems(items, { type: 'unsorted' }, 'all').map((i) => i.name)).toEqual(['d']);
    expect(filterItems(items, { type: 'all' }, 'video').map((i) => i.name)).toEqual(['b']);
    expect(filterItems(items, { type: 'game', id: 'g1' }, 'image').map((i) => i.name)).toEqual(['a']);
  });

  it('counts facets by game with match sources, unsorted last', () => {
    const f = gameFacets(items);
    expect(f.map((x) => x.gameId)).toEqual(['g1', 'g2', null]);
    expect(f[0]).toMatchObject({ count: 2, steamAppId: 1, filename: 1 });
    expect(f[2].count).toBe(1);
  });

  it('describes matches', () => {
    expect(matchLabel('steam-appid')).toMatch(/Steam app ID/);
    expect(matchLabel('filename')).toMatch(/file name/);
    expect(matchLabel(null)).toMatch(/Not matched/);
  });
});

describe('grid rows', () => {
  it('computes columns with a floor of one', () => {
    expect(columnsFor(1000, 200, 12)).toBe(4);
    expect(columnsFor(100, 200, 12)).toBe(1);
    expect(columnsFor(0, 200, 12)).toBe(1);
  });

  it('chunks groups into rows with flat start indices', () => {
    const groups = groupByMonth([
      ...Array.from({ length: 5 }, (_, i) => item(`m${i}`, new Date(2026, 3, 10 - i).toISOString())),
      ...Array.from({ length: 2 }, (_, i) => item(`n${i}`, new Date(2026, 1, 10 - i).toISOString())),
    ]);
    const rows = buildRows(groups, 2);
    expect(rows.map((r) => r.type)).toEqual(['header', 'items', 'items', 'items', 'header', 'items']);
    const itemRows = rows.filter((r) => r.type === 'items');
    expect(itemRows.map((r) => r.startIndex)).toEqual([0, 2, 4, 5]);
    expect(itemRows[2].items).toHaveLength(1);
    const flat = flatten(groups);
    expect(flat[5].name).toBe('n0');
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});
