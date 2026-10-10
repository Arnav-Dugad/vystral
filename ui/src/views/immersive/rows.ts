/**
 * Immersive rows (Track L). Pure, so which rows appear, what they hold and the time-of-day order
 * are unit-tested. Everything comes from the user's own library; nothing needs the network.
 */
import type { CollectionInfo, Game, InstallProgress, LaunchPhase, PlatformKey } from '../../bridge/types';
import { importedMinutes, isInstalled, lastPlayed, PLATFORM_NAMES, plural } from '../../lib/format';
import { isWaiting } from '../../lib/neverPlayed';
import { suggestGames } from '../../lib/recommend';
import { applyRowOrder } from './rowOrder';
import type { DiscoverItem, NoteAction } from './discoverRows';

export type Tile =
  | { kind: 'game'; key: string; game: Game; /** The "Last played" slot: wider, labelled, always first. */ pinned?: boolean }
  | { kind: 'store'; key: string; platform: PlatformKey; count: number; sample: Game | null }
  | { kind: 'genre'; key: string; genre: string; count: number; sample: Game | null }
  /** Track T: the game that's running (or starting) — A returns to it. */
  | { kind: 'playing'; key: string; game: Game; phase: LaunchPhase; startedAt: string | null }
  /** Track T: a Steam install or update in progress. */
  | { kind: 'download'; key: string; game: Game; progress: InstallProgress }
  /** Track T: a sort or filter chip on the All games toolbar. */
  | { kind: 'tool'; key: string; tool: LibraryTool }
  /** Track C6: a game you don't own (a search result, your Watching list, your Steam wishlist). */
  | { kind: 'discover'; key: string; item: DiscoverItem }
  /** Track C6: opens the search keyboard (query null) or runs a suggested search. */
  | { kind: 'search'; key: string; query: string | null; label: string; sample: Game | null }
  /** Track C6: a status card in Discover (searching, nothing found, offline…), with an optional action. */
  | { kind: 'note'; key: string; title: string; body: string; action: NoteAction | null; busy?: boolean };

export type LibrarySort = 'az' | 'recent' | 'played' | 'added';
export const LIBRARY_SORTS: readonly LibrarySort[] = ['az', 'recent', 'played', 'added'];
export const SORT_LABEL: Record<LibrarySort, string> = { az: 'A–Z', recent: 'Recently played', played: 'Most played', added: 'Recently added' };

export type LibraryTool =
  | { type: 'sort'; sort: LibrarySort }
  | { type: 'filter'; filter: LibraryFilter | null; label: string; count: number; active: boolean };

export type RowKind = 'continue' | 'picked' | 'favorites' | 'installed' | 'new' | 'unplayed' | 'collection' | 'stores' | 'genres' | 'library' | 'playing' | 'downloads' | 'tools' | 'discover';

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
  /** Track T: a short row of chips (the All games toolbar). */
  compact?: boolean;
}

/** Track T: what's live right now (a running game, Steam downloads) for the Home rows. */
export interface LiveState {
  playing?: { game: Game; phase: LaunchPhase; startedAt: string | null } | null;
  downloads?: { game: Game; progress: InstallProgress }[];
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

/**
 * The Home rows. `order` (Track Z) is your own row order (row ids); empty = the automatic,
 * time-of-day order. Live rows are placed after it either way.
 */
export function homeRows(visible: readonly Game[], collections: readonly CollectionInfo[], now: number, hour: number, live: LiveState = {}, order: readonly string[] = []): Row[] {
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
  const ordered = orderRows(
    rows.filter((r) => r.tiles.length > 0 && !(r.browse && r.tiles.length < 2)),
    hour,
  );
  return withLiveRows(applyRowOrder(ordered, order), live);
}

/**
 * Track T: "Now playing" leads while a game starts or runs (one wide tile: A returns to it), and
 * "Downloads" (Steam installs and updates in progress) follows Continue.
 */
export function withLiveRows(rows: Row[], live: LiveState): Row[] {
  const out = [...rows];
  const downloads = (live.downloads ?? []).slice(0, ROW_CAP);
  if (downloads.length) {
    const row: Row = {
      id: 'downloads',
      kind: 'downloads',
      title: 'Downloads',
      meta: downloads.some((d) => d.progress.kind === 'update') ? 'Installs and updates in Steam' : 'Installing in Steam',
      tiles: downloads.map((d) => ({ kind: 'download' as const, key: `downloads:${d.game.id}`, game: d.game, progress: d.progress })),
    };
    const at = out.findIndex((r) => r.kind === 'continue');
    out.splice(at >= 0 ? at + 1 : 0, 0, row);
  }
  const p = live.playing;
  if (p) {
    out.unshift({
      id: 'playing',
      kind: 'playing',
      title: 'Now playing',
      wide: true,
      tiles: [{ kind: 'playing', key: `playing:${p.game.id}`, game: p.game, phase: p.phase, startedAt: p.startedAt }],
    });
  }
  return out;
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
export const tileGame = (t: Tile | null | undefined): Game | null =>
  !t ? null
    : t.kind === 'game' || t.kind === 'playing' || t.kind === 'download' ? t.game
    : t.kind === 'store' || t.kind === 'genre' || t.kind === 'search' ? t.sample
    : null;

export function tileLabel(t: Tile): string {
  switch (t.kind) {
    case 'game': return `${t.game.title}${isInstalled(t.game) ? '' : ', not installed'}`;
    case 'store': return `${PLATFORM_NAMES[t.platform]}, ${plural(t.count, 'game')}`;
    case 'genre': return `${t.genre}, ${plural(t.count, 'game')}`;
    case 'playing': return `${t.phase === 'running' ? 'Now playing' : 'Starting'}: ${t.game.title}. Return to game`;
    case 'download': return `${t.game.title}, ${t.progress.kind === 'update' ? 'updating' : 'installing'}`;
    case 'tool': return toolLabel(t.tool);
    case 'discover': return `${t.item.title}${t.item.year ? `, ${t.item.year}` : ''}${t.item.price ? `, ${t.item.price}` : ''}. Not in your library`;
    case 'search': return t.query ? `Search for ${t.query}` : 'Search any game';
    case 'note': return `${t.title}. ${t.body}`;
  }
}

export function toolLabel(tool: LibraryTool): string {
  if (tool.type === 'sort') return `Sort: ${SORT_LABEL[tool.sort]}`;
  return `${tool.label}, ${plural(tool.count, 'game')}${tool.active ? ', selected' : ''}`;
}

/* ------------------------------------------------------------------ Track T: sorted grid, toolbar, quick jump */

export const playedSeconds = (g: Game) => g.trackedSeconds + (importedMinutes(g) ?? 0) * 60;

function ageBucket(iso: string | null | undefined, now: number): number {
  if (!iso) return 5;
  const days = (now - Date.parse(iso)) / 86_400_000;
  if (!Number.isFinite(days)) return 5;
  if (days < 1) return 0;
  if (days < 7) return 1;
  if (days < 31) return 2;
  if (days < 365) return 3;
  return 4;
}
const RECENT_LABELS = ['Played today', 'This week', 'This month', 'This year', 'Longer ago', 'Never played'];
const ADDED_LABELS = ['Added today', 'Added this week', 'Added this month', 'Added this year', 'Added earlier', 'Added earlier'];

function hoursLabel(seconds: number): string {
  if (seconds <= 0) return 'Not played yet';
  if (seconds < 3600) return 'Under an hour';
  const h = Math.floor(seconds / 3600);
  if (h >= 100) return '100+ hours';
  if (h >= 50) return '50–100 hours';
  if (h >= 20) return '20–50 hours';
  if (h >= 10) return '10–20 hours';
  if (h >= 5) return '5–10 hours';
  return '1–5 hours';
}

/** The section a game falls in under a sort: its letter (A–Z) or a time/playtime band. */
export function sectionOf(g: Game, sort: LibrarySort, now: number): string {
  switch (sort) {
    case 'az': {
      const c = g.sortTitle.charAt(0).toUpperCase();
      return /[A-Z]/.test(c) ? c : '#';
    }
    case 'recent': return RECENT_LABELS[ageBucket(lastPlayed(g).at, now)];
    case 'added': return ADDED_LABELS[ageBucket(g.added, now)];
    case 'played': return hoursLabel(playedSeconds(g));
  }
}

export function sortGames(games: readonly Game[], sort: LibrarySort): Game[] {
  const list = [...games];
  switch (sort) {
    case 'az': return list.sort(byTitle);
    case 'recent':
      return list.sort((a, b) => (lastPlayed(b).at ?? '').localeCompare(lastPlayed(a).at ?? '') || byTitle(a, b));
    case 'played': return list.sort((a, b) => playedSeconds(b) - playedSeconds(a) || byTitle(a, b));
    case 'added': return list.sort((a, b) => b.added.localeCompare(a.added) || byTitle(a, b));
  }
}

export function normalizeSort(v: unknown): LibrarySort {
  return LIBRARY_SORTS.includes(v as LibrarySort) ? (v as LibrarySort) : 'az';
}

export interface Jump {
  label: string;
  row: number;
  col: number;
}

/** The toolbar over the grid: the sort, then filters (all, installed, favourites, never played, each store). */
export function toolsRow(visible: readonly Game[], filter: LibraryFilter | null, sort: LibrarySort): Row {
  const chip = (f: LibraryFilter | null, label: string): Tile => ({
    kind: 'tool',
    key: `tools:${f ? JSON.stringify(f) : 'all'}`,
    tool: { type: 'filter', filter: f, label, count: filterGames(visible, f).length, active: sameFilter(filter, f) },
  });
  const quick = (['installed', 'favorites', 'unplayed'] as const)
    .map((kind) => chip({ kind }, filterLabel({ kind })))
    .filter((t) => t.kind === 'tool' && t.tool.type === 'filter' && (t.tool.count > 0 || t.tool.active));
  const stores = storeTiles(visible).flatMap((t) => (t.kind === 'store' ? [chip({ kind: 'store', platform: t.platform }, PLATFORM_NAMES[t.platform])] : []));
  const tiles: Tile[] = [{ kind: 'tool', key: 'tools:sort', tool: { type: 'sort', sort } }, chip(null, 'All'), ...quick, ...stores];
  // A filter that came from a genre tile shows as its own chip, so the toolbar always says what's on.
  if (filter?.kind === 'genre') tiles.splice(2, 0, chip(filter, filter.genre));
  return {
    id: 'tools',
    kind: 'tools',
    title: 'Sort and filter',
    meta: `${filter ? filterLabel(filter) : 'All games'} · ${plural(filterGames(visible, filter).length, 'game')}`,
    compact: true,
    tiles,
  };
}

/**
 * Track T: the All games view — a toolbar row, then the grid sorted by `sort` with section titles
 * (letters for A–Z, time or playtime bands otherwise), and the quick-jump targets LT/RT step through.
 */
export function libraryView(
  visible: readonly Game[],
  filter: LibraryFilter | null,
  sort: LibrarySort,
  now: number,
  columns = GRID_COLUMNS,
): { rows: Row[]; jumps: Jump[] } {
  const sorted = sortGames(filterGames(visible, filter), sort);
  const sections = sorted.map((g) => sectionOf(g, sort, now));
  const rows: Row[] = [toolsRow(visible, filter, sort)];
  for (let i = 0, n = 0; i < sorted.length; i += columns, n++) {
    const a = sections[i];
    const b = sections[Math.min(sorted.length, i + columns) - 1];
    rows.push({
      id: `lib-${n}`,
      kind: 'library',
      title: a === b ? a : sort === 'az' ? `${a} – ${b}` : `${a} · ${b}`,
      tiles: sorted.slice(i, i + columns).map((g) => gameTile(g, `lib-${n}`)),
    });
  }
  const jumps: Jump[] = [];
  sections.forEach((s, i) => {
    if (i === 0 || s !== sections[i - 1]) jumps.push({ label: s, row: 1 + Math.floor(i / columns), col: i % columns });
  });
  return { rows, jumps };
}

const posOf = (j: { row: number; col: number }) => j.row * 10_000 + j.col;

/** The next quick-jump target after a position (dir 1) or the one before it (dir −1); null at the ends. */
export function nextJump(jumps: readonly Jump[], row: number, col: number, dir: 1 | -1): Jump | null {
  const here = posOf({ row, col });
  if (dir > 0) return jumps.find((j) => posOf(j) > here) ?? null;
  for (let i = jumps.length - 1; i >= 0; i--) if (posOf(jumps[i]) < here) return jumps[i];
  return null;
}

/** The section a position is in (for the rail's highlight). */
export function jumpAt(jumps: readonly Jump[], row: number, col: number): Jump | null {
  const here = posOf({ row, col });
  let cur: Jump | null = null;
  for (const j of jumps) if (posOf(j) <= here) cur = j;
  return cur;
}
