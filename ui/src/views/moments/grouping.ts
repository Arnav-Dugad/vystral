import type { MediaItem } from '../../bridge/types';

/**
 * Pure helpers for the Moments Vault: month grouping (by file date), filtering, per-game
 * facets and row building for the virtualized grid. No DOM, no bridge — unit tested.
 */

export interface MonthGroup {
  /** `YYYY-MM` in local time, or `unknown` for unreadable dates. */
  key: string;
  year: number | null;
  /** 0-based month, null when unknown. */
  month: number | null;
  items: MediaItem[];
}

export type KindFilter = 'all' | 'image' | 'video';
export type GameFilter = { type: 'all' } | { type: 'unsorted' } | { type: 'game'; id: string };

export interface GameFacet {
  gameId: string | null;
  count: number;
  steamAppId: number;
  filename: number;
}

export type GridRow =
  | { type: 'header'; key: string; group: MonthGroup }
  | { type: 'items'; key: string; items: MediaItem[]; startIndex: number };

const time = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export function monthKey(iso: string): string | null {
  const t = time(iso);
  if (t == null) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Newest first, items within a month newest first; unknown dates go last. Stable for equal dates. */
export function groupByMonth(items: readonly MediaItem[]): MonthGroup[] {
  const sorted = items
    .map((item, i) => ({ item, i, t: time(item.modifiedAt) }))
    .sort((a, b) => {
      if (a.t == null && b.t == null) return a.i - b.i;
      if (a.t == null) return 1;
      if (b.t == null) return -1;
      return b.t - a.t || a.i - b.i;
    });
  const groups: MonthGroup[] = [];
  let current: MonthGroup | null = null;
  for (const { item, t } of sorted) {
    const key = t == null ? 'unknown' : monthKey(item.modifiedAt)!;
    if (!current || current.key !== key) {
      const d = t == null ? null : new Date(t);
      current = { key, year: d ? d.getFullYear() : null, month: d ? d.getMonth() : null, items: [] };
      groups.push(current);
    }
    current.items.push(item);
  }
  return groups;
}

export function monthLabel(group: Pick<MonthGroup, 'year' | 'month'>, locale?: string): string {
  if (group.year == null || group.month == null) return 'Unknown date';
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(new Date(group.year, group.month, 1));
}

export function matchesFilter(item: MediaItem, game: GameFilter, kind: KindFilter): boolean {
  if (kind !== 'all' && item.kind !== kind) return false;
  if (game.type === 'unsorted') return item.gameId == null;
  if (game.type === 'game') return item.gameId === game.id;
  return true;
}

export function filterItems(items: readonly MediaItem[], game: GameFilter, kind: KindFilter): MediaItem[] {
  return items.filter((i) => matchesFilter(i, game, kind));
}

/** Per-game counts, largest first; "Unsorted" (null) always last. */
export function gameFacets(items: readonly MediaItem[]): GameFacet[] {
  const map = new Map<string | null, GameFacet>();
  for (const item of items) {
    let f = map.get(item.gameId);
    if (!f) map.set(item.gameId, (f = { gameId: item.gameId, count: 0, steamAppId: 0, filename: 0 }));
    f.count++;
    if (item.matchedBy === 'steam-appid') f.steamAppId++;
    else if (item.matchedBy === 'filename') f.filename++;
  }
  return [...map.values()].sort((a, b) => {
    if (a.gameId == null) return 1;
    if (b.gameId == null) return -1;
    return b.count - a.count || a.gameId.localeCompare(b.gameId);
  });
}

/** How many tiles fit a row given a minimum tile width. */
export function columnsFor(width: number, minTile: number, gap: number): number {
  if (!(width > 0)) return 1;
  return Math.max(1, Math.floor((width + gap) / (minTile + gap)));
}

/**
 * Flattens month groups into header rows and fixed-width item rows. `startIndex` is the
 * position of the row's first item in the flat (grouped) order used by the lightbox.
 */
export function buildRows(groups: readonly MonthGroup[], columns: number): GridRow[] {
  const cols = Math.max(1, Math.floor(columns));
  const rows: GridRow[] = [];
  let index = 0;
  for (const group of groups) {
    rows.push({ type: 'header', key: `h-${group.key}`, group });
    for (let i = 0; i < group.items.length; i += cols) {
      const slice = group.items.slice(i, i + cols);
      rows.push({ type: 'items', key: `r-${group.key}-${i}`, items: slice, startIndex: index });
      index += slice.length;
    }
  }
  return rows;
}

/** Flat order matching buildRows' startIndex. */
export function flatten(groups: readonly MonthGroup[]): MediaItem[] {
  return groups.flatMap((g) => g.items);
}

export function matchLabel(matchedBy: MediaItem['matchedBy']): string {
  if (matchedBy === 'steam-appid') return 'Matched by Steam app ID';
  if (matchedBy === 'filename') return 'Matched by file name';
  return 'Not matched to a game';
}
