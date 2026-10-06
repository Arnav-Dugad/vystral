import { describe, expect, it } from 'vitest';
import type { CollectionInfo, Game, Installation, PlatformKey } from '../../bridge/types';
import { dayPart, filterGames, genreTiles, greeting, homeRows, libraryRows, orderRows, ROW_ORDER, storeTiles, tileGame, tileLabel, type Row } from './rows';
import { applyFilter, clampRow, colOf, focusGame, INITIAL_NAV, locate, moveNav, pick, switchTab } from './nav';
import { radialHit, radialOffset, radialStep } from './radial';
import { batteryLabel, batteryLevel, controllerLabel, elapsed, networkLabel, wifiArcs } from './systemStatus';
import { nextTourStep, TOUR_STEPS } from './Tour';
import { highlightAchievements } from './attractSlides';
import { sparkVectors } from './PlayBurst';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: null,
    drive: null, sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: 0,
    userLaunchArgs: null, manualLink: false, lastSeen: daysAgo(0), ...over,
  };
}

function game(title: string, over: Partial<Game> = {}, installs: Installation[] = [inst()]): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: installs, collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: daysAgo(30), ...over,
  } as Game;
}

const played = (title: string, days: number, over: Partial<Game> = {}, platform: PlatformKey = 'steam') =>
  game(title, { lastTrackedPlay: daysAgo(days), trackedSeconds: 3600, sessionCount: 2, ...over }, [inst({ platform })]);

const LIB: Game[] = [
  played('Alpha', 1, { genres: ['RPG'], favorite: true }),
  played('Beta', 3, { genres: ['RPG', 'Action'], collections: ['c1'] }, 'epic'),
  played('Gamma', 40, { genres: ['Racing'] }, 'gog'),
  game('Delta', { genres: ['Action'], added: daysAgo(2) }),
  game('Epsilon', { genres: ['Action', 'RPG'], added: daysAgo(1) }, [inst({ state: 'notinstalled' })]),
  game('Zeta', { genres: ['Puzzle'], collections: ['c1'] }, [inst({ platform: 'xbox' })]),
];
const COLLECTIONS: CollectionInfo[] = [
  { id: 'c1', name: 'Couch co-op', icon: null, sortOrder: 0, rule: null, count: 2 },
  { id: 'c2', name: 'Empty', icon: null, sortOrder: 1, rule: null, count: 0 },
];
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('Immersive rows', () => {
  it('maps hours to parts of the day and greets accordingly', () => {
    expect([5, 11, 12, 16, 17, 22, 23, 0, 4].map(dayPart)).toEqual(['morning', 'morning', 'afternoon', 'afternoon', 'evening', 'evening', 'night', 'night', 'night']);
    expect(greeting(20)).toBe('Good evening');
    expect(dayPart(-1)).toBe('night');
  });

  it('always leads with Continue, then orders by time of day; browse rows come last', () => {
    for (const order of Object.values(ROW_ORDER)) {
      expect(order[0]).toBe('continue');
      expect(order.slice(-2).sort()).toEqual(['genres', 'stores']);
    }
    const morning = ids(homeRows(LIB, COLLECTIONS, NOW, 8));
    const evening = ids(homeRows(LIB, COLLECTIONS, NOW, 20));
    expect(morning[0]).toBe('continue');
    expect(evening[0]).toBe('continue');
    // Mornings lean to discovery, evenings to favourites.
    expect(morning.indexOf('picked')).toBeLessThan(morning.indexOf('favorites'));
    expect(evening.indexOf('favorites')).toBeLessThan(evening.indexOf('picked'));
    expect(morning.slice(-2).sort()).toEqual(['genres', 'stores']);
  });

  it('pins the most recently played installed game as the first Continue tile', () => {
    const rows = homeRows(LIB, COLLECTIONS, NOW, 12);
    const cont = rows.find((r) => r.id === 'continue')!;
    expect(cont.wide).toBe(true);
    expect(cont.tiles[0]).toMatchObject({ kind: 'game', pinned: true });
    expect(tileGame(cont.tiles[0])?.title).toBe('Alpha');
    expect(cont.tiles.slice(1).every((t) => t.kind === 'game' && !t.pinned)).toBe(true);
  });

  it('skips empty rows, adds non-empty collections and never-played games', () => {
    const rows = homeRows(LIB, COLLECTIONS, NOW, 12);
    expect(ids(rows)).toContain('collection:c1');
    expect(ids(rows)).not.toContain('collection:c2');
    const unplayed = rows.find((r) => r.id === 'unplayed')!;
    // Installed ones first.
    expect(unplayed.tiles.map((t) => tileGame(t)!.title)).toEqual(['Delta', 'Zeta', 'Epsilon']);
    const nothingPlayed = homeRows([game('Solo')], [], NOW, 12);
    expect(ids(nothingPlayed)).not.toContain('continue');
  });

  it('builds store and genre browse tiles, most games first', () => {
    const stores = storeTiles(LIB);
    expect(stores[0]).toMatchObject({ kind: 'store', platform: 'steam', count: 3 });
    expect(stores.map((t) => (t.kind === 'store' ? t.platform : ''))).toEqual(['steam', 'epic', 'gog', 'xbox']);
    const genres = genreTiles(LIB);
    expect(genres.map((t) => (t.kind === 'genre' ? t.genre : ''))).toEqual(['Action', 'RPG']); // 3 each, then A–Z; Racing/Puzzle have one game
    expect(tileLabel(stores[0])).toBe('Steam, 3 games');
    expect(tileGame(stores[0])?.title).toBe('Alpha'); // the most recently played represents the store
  });

  it('filters the A–Z grid and labels the first row with the filter', () => {
    const rows = libraryRows(LIB, { kind: 'store', platform: 'steam' }, 2);
    expect(rows[0].title).toBe('Steam');
    expect(rows[0].meta).toBe('3 games');
    expect(rows.flatMap((r) => r.tiles).map((t) => tileGame(t)!.title)).toEqual(['Alpha', 'Delta', 'Epsilon']);
    expect(filterGames(LIB, { kind: 'genre', genre: 'Racing' }).map((g) => g.title)).toEqual(['Gamma']);
    expect(filterGames(LIB, { kind: 'installed' })).toHaveLength(5);
    expect(libraryRows(LIB, null, 4).map((r) => r.title)).toEqual(['All games', 'G – Z']);
  });

  it('orderRows is stable for rows of the same kind', () => {
    const r = (id: string, kind: Row['kind']): Row => ({ id, kind, title: id, tiles: [] });
    const out = orderRows([r('c2', 'collection'), r('fav', 'favorites'), r('c1', 'collection'), r('cont', 'continue')], 20);
    expect(ids(out)).toEqual(['cont', 'fav', 'c2', 'c1']);
  });
});

describe('Immersive navigation', () => {
  const rows = homeRows(LIB, COLLECTIONS, NOW, 12);

  it('moves along a row, between rows, and reports edges', () => {
    let s = INITIAL_NAV;
    let r = moveNav(s, rows, 0, -1);
    expect(r.effect).toBe('edge');
    r = moveNav(s, rows, 0, 1);
    expect(r.effect).toBe('col');
    s = r.state;
    expect(colOf(s, rows)).toBe(1);
    r = moveNav(s, rows, 1, 0);
    expect(r.effect).toBe('row');
    s = r.state;
    expect(clampRow(s, rows)).toBe(1);
    expect(colOf(s, rows)).toBe(0); // shelves remember their own column
    r = moveNav(s, rows, -1, 0);
    expect(colOf(r.state, rows)).toBe(1); // …and the first row still remembers 1
    expect(moveNav(INITIAL_NAV, rows, -1, 0).effect).toBe('edge');
  });

  it('keeps focus on the same row when rows appear or disappear above it', () => {
    const s = moveNav(moveNav(INITIAL_NAV, rows, 1, 0).state, rows, 1, 0).state;
    const focusedId = rows[clampRow(s, rows)].id;
    const fewer = rows.filter((r) => r.id !== 'continue');
    expect(fewer[clampRow(s, fewer)].id).toBe(focusedId);
    // If the row itself goes away, focus clamps instead of disappearing.
    const gone = rows.filter((r) => r.id !== focusedId);
    expect(clampRow(s, gone)).toBeLessThan(gone.length);
  });

  it('clamps the column when a row shrinks, so a card is always focused', () => {
    const s = pick(INITIAL_NAV, rows, 0, 3);
    const shrunk = rows.map((r, i) => (i === 0 ? { ...r, tiles: r.tiles.slice(0, 2) } : r));
    expect(colOf(s, shrunk)).toBe(1);
  });

  it('the A–Z grid keeps the column when moving between rows', () => {
    const grid = libraryRows(LIB, null, 3);
    const s = switchTab(INITIAL_NAV);
    expect(s.tab).toBe('library');
    const right = moveNav(moveNav(s, grid, 0, 1).state, grid, 0, 1).state;
    expect(colOf(moveNav(right, grid, 1, 0).state, grid)).toBe(2);
  });

  it('browse tiles open a filtered grid; locate and focusGame find games', () => {
    const f = applyFilter(INITIAL_NAV, { kind: 'genre', genre: 'RPG' });
    expect(f).toMatchObject({ tab: 'library', row: 0, filter: { kind: 'genre', genre: 'RPG' } });
    expect(applyFilter(f, { kind: 'genre', genre: 'RPG' })).toBe(f);
    expect(locate(rows, 'Zeta')).not.toBeNull();
    expect(locate(rows, 'nope')).toBeNull();
    const focused = focusGame(INITIAL_NAV, rows, 'Gamma');
    const at = locate(rows, 'Gamma')!;
    expect([clampRow(focused, rows), colOf(focused, rows)]).toEqual([at.row, at.col]);
    expect(focusGame(INITIAL_NAV, rows, 'nope')).toBe(INITIAL_NAV);
  });
});

describe('quick menu geometry', () => {
  it('direction picks the nearest petal; the same direction again walks to its neighbour', () => {
    // Six petals: 0 top, 1 upper right, 2 lower right, 3 bottom, 4 lower left, 5 upper left.
    expect(radialStep(0, 6, 'right')).toBe(1);
    expect(radialStep(1, 6, 'right')).toBe(2);
    expect(radialStep(2, 6, 'down')).toBe(3);
    expect(radialStep(3, 6, 'left')).toBe(4);
    expect(radialStep(4, 6, 'left')).toBe(5);
    expect(radialStep(5, 6, 'up')).toBe(0);
    expect(radialStep(0, 6, 'up')).toBe(0);
    expect(radialStep(0, 6, 'down')).toBe(3);
    expect(radialStep(-1, 6, 'left')).toBe(4);
    expect(radialStep(0, 1, 'left')).toBe(0);
  });

  it('places petals clockwise from the top and hit-tests a pointer', () => {
    expect(radialOffset(0, 4)).toEqual({ x: 0, y: -1 });
    expect(radialOffset(1, 4)).toEqual({ x: 1, y: 0 });
    expect(radialHit(0, -50, 6, 20)).toBe(0);
    expect(radialHit(50, 30, 6, 20)).toBe(2);
    expect(radialHit(2, 2, 6, 20)).toBe(-1);
  });
});

describe('system bar', () => {
  it('describes battery, network and controllers in words', () => {
    expect(batteryLevel(80, false)).toBe('full');
    expect(batteryLevel(50, false)).toBe('medium');
    expect(batteryLevel(20, false)).toBe('low');
    expect(batteryLevel(5, false)).toBe('critical');
    expect(batteryLevel(5, true)).toBe('charging');
    expect(batteryLabel({ percent: 76.4, charging: true, saver: true })).toBe('Battery 76%, charging, battery saver on');
    expect([null, 0, 1, 2, 3, 4, 5].map(wifiArcs)).toEqual([3, 0, 1, 1, 2, 3, 3]);
    expect(networkLabel({ kind: 'wifi', bars: 3, internet: true })).toBe('Wi-Fi, signal 3 of 5');
    expect(networkLabel({ kind: 'ethernet', bars: null, internet: false })).toBe('Ethernet, no internet');
    expect(networkLabel({ kind: 'none', bars: null, internet: false })).toBe('Not connected');
    expect(controllerLabel({ battery: 0.62, charging: false, wired: false }, 0, 1)).toBe('Controller, battery 62%');
    expect(controllerLabel({ battery: null, charging: false, wired: true }, 1, 2)).toBe('Controller 2, wired');
  });

  it('formats elapsed play time', () => {
    const start = new Date(NOW - 65 * 60_000).toISOString();
    expect(elapsed(start, NOW)).toBe('1 h 05 min');
    expect(elapsed(new Date(NOW - 12 * 60_000).toISOString(), NOW)).toBe('12 min');
    expect(elapsed(null, NOW)).toBeNull();
  });
});

describe('tour, attract highlights, play burst', () => {
  it('the tour walks its steps in order and ends when all are done', () => {
    expect(nextTourStep(new Set())).toBe('move');
    expect(nextTourStep(new Set(['move', 'quick']))).toBe('sections');
    expect(nextTourStep(new Set(TOUR_STEPS))).toBeNull();
  });

  it('attract mode highlights only rare unlocks, newest first', () => {
    const item = (name: string, pct: number | null, at: string) => ({ appId: '1', gameId: null, gameTitle: 'G', apiName: name, name, description: null, unlockedAt: at, globalPercent: pct, icon: null });
    const out = highlightAchievements([item('common', 40, daysAgo(1)), item('rare', 4, daysAgo(5)), item('ultra', 0.5, daysAgo(2)), item('unknown', null, daysAgo(0))]);
    expect(out.map((i) => i.name)).toEqual(['ultra', 'rare']);
  });

  it('play burst sparks spread all the way round', () => {
    const v = sparkVectors(16);
    expect(v).toHaveLength(16);
    const angles = new Set(v.map((s) => Math.round((Math.atan2(s.y, s.x) * 4) / Math.PI)));
    expect(angles.size).toBeGreaterThanOrEqual(8);
  });
});
