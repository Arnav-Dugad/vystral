/**
 * Immersive rows (Track L). Pure, so which rows appear, what they hold and the time-of-day order
 * are unit-tested. Everything comes from the user's own library; nothing needs the network.
 */
import type { CollectionInfo, Game, PlatformKey } from '../../bridge/types';
import { isInstalled, lastPlayed, PLATFORM_NAMES, plural } from '../../lib/format';
import { isWaiting } from '../../lib/neverPlayed';
import { suggestGames } from '../../lib/recommend';

export type Tile =
  | { kind: 'game'; key: string; game: Game; /** The "Last played" slot: wider, labelled, always first. */ pinned?: boolean }
  | { kind: 'store'; key: string; platform: PlatformKey; count: number; sample: Game | null }
  | { kind: 'genre'; key: string; genre: string; count: number; sample: Game | null };

export type RowKind = 'continue' | 'picked' | 'favorites' | 'installed' | 'new' | 'unplayed' | 'collection' | 'stores' | 'genres' | 'library';

export interface Row {
  id: string;
  kind: RowKind;
  title: string;
  meta?: string;
  tiles: Tile[];
  /** Landscape cards. */
  wide?: boolean;
  /** Browse tiles (stores, genres) rather than games. */
  browse?: boolean;
}

export type LibraryFilter =
  | { kind: 'store'; platform: PlatformKey }
  | { kind: 'genre'; genre: string }
  | { kind: 'installed' }
  | { kind: 'favorites' }
  | { kind: 'unplayed' };

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';

export const GRID_COLUMNS = 7;
const ROW_CAP = 30;
const MAX_COLLECTION_ROWS = 4;
const MAX_GENRES = 10;

export function dayPart(hour: number): DayPart {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 23) return 'evening';
  return 'night';
}

export function greeting(hour: number): string {
  return { morning: 'Good morning', afternoon: 'Good afternoon', evening: 'Good evening', night: 'Late session' }[dayPart(hour)];
}

/**
 * Row order by time of day. "Continue" always leads (picking up where you left off is the most
 * common thing to do). Mornings lean toward discovery (picks, new arrivals, the backlog);
 * evenings toward what you already love (favourites, your collections); late nights toward the
 * familiar. Browse rows (stores, genres) always come last.
 */
export const ROW_ORDER: Record<DayPart, RowKind[]> = {
  morning: ['continue', 'picked', 'new', 'unplayed', 'favorites', 'collection', 'installed', 'stores', 'genres'],
  afternoon: ['continue', 'picked', 'favorites', 'new', 'unplayed', 'collection', 'installed', 'genres', 'stores'],
  evening: ['continue', 'favorites', 'picked', 'collection', 'unplayed', 'new', 'installed', 'genres', 'stores'],
  night: ['continue', 'favorites', 'collection', 'picked', 'new', 'installed', 'unplayed', 'genres', 'stores'],
};

/** Stable sort of rows by the time-of-day order; rows of the same kind keep their relative order. */
export function orderRows(rows: readonly Row[], hour: number): Row[] {
  const order = ROW_ORDER[dayPart(hour)];
  const rank = (k: RowKind) => {
    const i = order.indexOf(k);
    return i < 0 ? order.length : i;
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank(a.r.kind) - rank(b.r.kind) || a.i - b.i)
    .map((x) => x.r);
}

const gameTile = (game: Game, rowId: string, pinned?: boolean): Tile => ({ kind: 'game', key: `${rowId}:${game.id}`, game, pinned });
const byTitle = (a: Game, b: Game) => a.sortTitle.localeCompare(b.sortTitle);

/** Store browse tiles: one per store you have games from, most games first. */
export function storeTiles(visible: readonly Game[]): Tile[] {
  const by = new Map<PlatformKey, Game[]>();
  for (const g of visible) for (const p of new Set(g.installations.map((i) => i.platform))) by.set(p, [...(by.get(p) ?? []), g]);
  return [...by.entries()]
    .sort((a, b) => b[1].length - a[1].length || PLATFORM_NAMES[a[0]].localeCompare(PLATFORM_NAMES[b[0]]))
    .map(([platform, games]) => ({ kind: 'store' as const, key: `store:${platform}`, platform, count: games.length, sample: pickSample(games) }));
}

/** Genre browse tiles: the most common genres with at least two games. */
export function genreTiles(visible: readonly Game[], max = MAX_GENRES): Tile[] {
  const by = new Map<string, Game[]>();
  for (const g of visible) for (const genre of g.genres) by.set(genre, [...(by.get(genre) ?? []), g]);
  return [...by.entries()]
    .filter(([, games]) => games.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([genre, games]) => ({ kind: 'genre' as const, key: `genre:${genre}`, genre, count: games.length, sample: pickSample(games) }));
}

/** The game whose art represents a browse tile: the most recently played, else the first with hero art, else the first. */
function pickSample(games: readonly Game[]): Game | null {
  const played = games.filter((g) => lastPlayed(g).at).sort((a, b) => lastPlayed(b).at!.localeCompare(lastPlayed(a).at!));
  return played[0] ?? games.find((g) => g.art.hero) ?? games[0] ?? null;
}

export function homeRows(visible: readonly Game[], collections: readonly CollectionInfo[], now: number, hour: number): Row[] {
  const recent = visible
    .filter((g) => isInstalled(g) && lastPlayed(g).at)
    .sort((a, b) => lastPlayed(b).at!.localeCompare(lastPlayed(a).at!))
    .slice(0, 15);
  const unplayed = visible
    .filter(isWaiting)
    .sort((a, b) => Number(isInstalled(b)) - Number(isInstalled(a)) || b.added.localeCompare(a.added))
    .slice(0, 20);
  const rows: Row[] = [
    { id: 'continue', kind: 'continue', title: 'Continue playing', wide: true, tiles: recent.map((g, i) => gameTile(g, 'continue', i === 0)) },
    { id: 'picked', kind: 'picked', title: 'Picked for you', meta: 'From what you play', tiles: suggestGames([...visible], now, 15).map((s) => gameTile(s.game, 'picked')) },
    { id: 'favorites', kind: 'favorites', title: 'Favorites', tiles: visible.filter((g) => g.favorite).slice(0, ROW_CAP).map((g) => gameTile(g, 'favorites')) },
    { id: 'new', kind: 'new', title: 'Recently added', tiles: [...visible].sort((a, b) => b.added.localeCompare(a.added)).slice(0, 15).map((g) => gameTile(g, 'new')) },
    { id: 'unplayed', kind: 'unplayed', title: 'Never played', meta: 'Waiting in your library', tiles: unplayed.map((g) => gameTile(g, 'unplayed')) },
    ...collections
      .filter((c) => !c.rule)
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => {
        const games = visible.filter((g) => g.collections.includes(c.id)).sort(byTitle).slice(0, ROW_CAP);
        return { id: `collection:${c.id}`, kind: 'collection' as const, title: c.name, meta: plural(games.length, 'game'), tiles: games.map((g) => gameTile(g, `collection:${c.id}`)) };
      })
      .filter((r) => r.tiles.length > 0)
      .slice(0, MAX_COLLECTION_ROWS),
    { id: 'installed', kind: 'installed', title: 'Installed', tiles: visible.filter(isInstalled).sort(byTitle).slice(0, 40).map((g) => gameTile(g, 'installed')) },
    { id: 'stores', kind: 'stores', title: 'Your stores', meta: 'Browse by store', browse: true, tiles: storeTiles(visible) },
    { id: 'genres', kind: 'genres', title: 'Genres', meta: 'Browse by genre', browse: true, tiles: genreTiles(visible) },
  ];
  // Rows with nothing in them never show (no empty first row when nothing was played yet).
  return orderRows(
    rows.filter((r) => r.tiles.length > 0 && !(r.browse && r.tiles.length < 2)),
    hour,
  );
}

export function filterGames(visible: readonly Game[], filter: LibraryFilter | null): Game[] {
  if (!filter) return [...visible];
  switch (filter.kind) {
    case 'store': return visible.filter((g) => g.installations.some((i) => i.platform === filter.platform));
    case 'genre': return visible.filter((g) => g.genres.includes(filter.genre));
    case 'installed': return visible.filter(isInstalled);
    case 'favorites': return visible.filter((g) => g.favorite);
    case 'unplayed': return visible.filter(isWaiting);
  }
}

export function filterLabel(filter: LibraryFilter): string {
  switch (filter.kind) {
    case 'store': return PLATFORM_NAMES[filter.platform];
    case 'genre': return filter.genre;
    case 'installed': return 'Installed';
    case 'favorites': return 'Favorites';
    case 'unplayed': return 'Never played';
  }
}

export const sameFilter = (a: LibraryFilter | null, b: LibraryFilter | null) => JSON.stringify(a) === JSON.stringify(b);

/** The A–Z grid, optionally filtered, as rows of {@link GRID_COLUMNS}. */
export function libraryRows(visible: readonly Game[], filter: LibraryFilter | null, columns = GRID_COLUMNS): Row[] {
  const sorted = filterGames(visible, filter).sort(byTitle);
  const letter = (g?: Game) => {
    const c = g?.sortTitle.charAt(0).toUpperCase() ?? '';
    return /[A-Z]/.test(c) ? c : '#';
  };
  return Array.from({ length: Math.ceil(sorted.length / columns) }, (_, i) => {
    const slice = sorted.slice(i * columns, i * columns + columns);
    const a = letter(slice[0]);
    const b = letter(slice[slice.length - 1]);
    return {
      id: `lib-${i}`,
      kind: 'library' as const,
      title: i === 0 ? (filter ? filterLabel(filter) : 'All games') : a === b ? a : `${a} – ${b}`,
      meta: i === 0 ? plural(sorted.length, 'game') : undefined,
      tiles: slice.map((g) => gameTile(g, `lib-${i}`)),
    };
  });
}

/** The game a tile shows (browse tiles show a representative game's art). */
export const tileGame = (t: Tile | null | undefined): Game | null => (!t ? null : t.kind === 'game' ? t.game : t.sample);

export function tileLabel(t: Tile): string {
  switch (t.kind) {
    case 'game': return `${t.game.title}${isInstalled(t.game) ? '' : ', not installed'}`;
    case 'store': return `${PLATFORM_NAMES[t.platform]}, ${plural(t.count, 'game')}`;
    case 'genre': return `${t.genre}, ${plural(t.count, 'game')}`;
  }
}
