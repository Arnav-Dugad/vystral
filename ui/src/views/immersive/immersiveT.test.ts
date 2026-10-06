import { describe, expect, it } from 'vitest';
import type { Game, InstallProgress, Installation, PlatformKey } from '../../bridge/types';
import { homeRows, jumpAt, libraryView, nextJump, sectionOf, sortGames, toolsRow, withLiveRows, type Tile } from './rows';
import { applyFilter, clampRow, colOf, INITIAL_NAV, moveNav, switchTab } from './nav';
import { focusSpeech, tileSpeech } from './speech';

// Track T: sorted grid with sections and quick jump, the toolbar, live rows, and voice-over wording.

const NOW = Date.parse('2026-10-05T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: null, drive: null,
    sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: 0, userLaunchArgs: null, manualLink: false,
    lastSeen: daysAgo(0), ...over,
  };
}
function game(title: string, over: Partial<Game> = {}, platform: PlatformKey = 'steam', state: Installation['state'] = 'installed'): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false,
    hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [inst({ platform, state })], collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: daysAgo(100), ...over,
  } as Game;
}

const LIB: Game[] = [
  game('Alpha', { lastTrackedPlay: daysAgo(0.2), trackedSeconds: 3 * 3600, favorite: true }),
  game('Apex', { lastTrackedPlay: daysAgo(3), trackedSeconds: 60 * 3600 }, 'epic'),
  game('Beta', { added: daysAgo(0.5) }, 'gog', 'notinstalled'),
  game('Bravo', { lastTrackedPlay: daysAgo(400), trackedSeconds: 600 }),
  game('Delta'),
  game('Zeta', { added: daysAgo(10) }, 'xbox'),
  game('1942'),
];

describe('All games: sort, sections and quick jump', () => {
  it('sorts by title, recency, playtime and date added', () => {
    expect(sortGames(LIB, 'az').map((g) => g.title)).toEqual(['1942', 'Alpha', 'Apex', 'Beta', 'Bravo', 'Delta', 'Zeta']);
    expect(sortGames(LIB, 'recent').map((g) => g.title).slice(0, 3)).toEqual(['Alpha', 'Apex', 'Bravo']);
    expect(sortGames(LIB, 'played')[0].title).toBe('Apex');
    expect(sortGames(LIB, 'added')[0].title).toBe('Beta');
  });

  it('names sections: letters, time bands, playtime bands', () => {
    expect(sectionOf(LIB[0], 'az', NOW)).toBe('A');
    expect(sectionOf(LIB[6], 'az', NOW)).toBe('#');
    expect(sectionOf(LIB[0], 'recent', NOW)).toBe('Played today');
    expect(sectionOf(LIB[1], 'recent', NOW)).toBe('This week');
    expect(sectionOf(LIB[4], 'recent', NOW)).toBe('Never played');
    expect(sectionOf(LIB[1], 'played', NOW)).toBe('50–100 hours');
    expect(sectionOf(LIB[3], 'played', NOW)).toBe('Under an hour');
    expect(sectionOf(LIB[2], 'added', NOW)).toBe('Added today');
  });

  it('puts a toolbar over the grid and lists a jump target per section', () => {
    const { rows, jumps } = libraryView(LIB, null, 'az', NOW, 3);
    expect(rows[0]).toMatchObject({ id: 'tools', kind: 'tools', compact: true });
    expect(rows.slice(1).map((r) => r.title)).toEqual(['# – A', 'B – D', 'Z']);
    expect(jumps.map((j) => [j.label, j.row, j.col])).toEqual([['#', 1, 0], ['A', 1, 1], ['B', 2, 0], ['D', 2, 2], ['Z', 3, 0]]);
    expect(nextJump(jumps, 1, 1, 1)).toMatchObject({ label: 'B' });
    expect(nextJump(jumps, 2, 1, -1)).toMatchObject({ label: 'B' }); // back to the start of this letter first
    expect(nextJump(jumps, 2, 0, -1)).toMatchObject({ label: 'A' });
    expect(nextJump(jumps, 3, 0, 1)).toBeNull();
    expect(nextJump(jumps, 1, 0, -1)).toBeNull();
    expect(jumpAt(jumps, 2, 1)).toMatchObject({ label: 'B' });
  });

  it('toolbar: sort first, then All, quick filters with games, then each store; the active one is marked', () => {
    const row = toolsRow(LIB, { kind: 'store', platform: 'epic' }, 'recent');
    const labels = row.tiles.map((t) => (t.kind === 'tool' ? (t.tool.type === 'sort' ? `sort:${t.tool.sort}` : `${t.tool.label}${t.tool.active ? '*' : ''}`) : '?'));
    expect(labels[0]).toBe('sort:recent');
    expect(labels).toContain('All');
    expect(labels).toContain('Installed');
    expect(labels).toContain('Epic Games*');
    expect(labels).toContain('Favorites');
    expect(row.meta).toBe('Epic Games · 1 game');
  });

  it('the grid opens on its first row of games, under the toolbar; the toolbar remembers its chip', () => {
    const { rows } = libraryView(LIB, null, 'az', NOW, 3);
    const s = switchTab(INITIAL_NAV);
    expect(clampRow(s, rows)).toBe(1);
    const filtered = applyFilter(INITIAL_NAV, { kind: 'installed' });
    expect(clampRow(filtered, rows)).toBe(1);
    // Up to the toolbar, right to the third chip, down and up again: the chip is remembered.
    let n = moveNav(s, rows, -1, 0).state;
    n = moveNav(n, rows, 0, 1).state;
    n = moveNav(n, rows, 0, 1).state;
    n = moveNav(n, rows, 1, 0).state;
    expect(colOf(n, rows)).toBe(0); // the grid row keeps its own column
    n = moveNav(n, rows, -1, 0).state;
    expect(colOf(n, rows)).toBe(2);
  });
});

describe('live rows', () => {
  const progress = (gameId: string, kind: InstallProgress['kind'] = 'install'): InstallProgress => ({ gameId, appId: '1', kind, phase: 'downloading', bytesDone: 42, bytesTotal: 100, rate: 10, watching: true });

  it('Now playing leads; Downloads follows Continue', () => {
    const rows = homeRows(LIB, [], NOW, 20, { playing: { game: LIB[0], phase: 'running', startedAt: daysAgo(0.01) }, downloads: [{ game: LIB[2], progress: progress('Beta') }] });
    expect(rows[0]).toMatchObject({ id: 'playing', wide: true });
    expect(rows[1].id).toBe('continue');
    expect(rows[2]).toMatchObject({ id: 'downloads', meta: 'Installing in Steam' });
    expect(withLiveRows([], { downloads: [{ game: LIB[2], progress: progress('Beta', 'update') }] })[0].meta).toBe('Installs and updates in Steam');
    expect(homeRows(LIB, [], NOW, 20).some((r) => r.id === 'playing' || r.id === 'downloads')).toBe(false);
  });
});

describe('voice-over wording', () => {
  it('says a name and a short state, the row name only when the row changes', () => {
    const tile: Tile = { kind: 'game', key: 'k', game: LIB[1] };
    const row = { id: 'favorites', kind: 'favorites' as const, title: 'Favorites', tiles: [tile] };
    expect(tileSpeech(tile)).toBe('Apex. Installed, 60 hours played.');
    expect(focusSpeech(row, tile, { rowChanged: true })).toBe('Favorites. Apex. Installed, 60 hours played.');
    expect(focusSpeech(row, tile, { rowChanged: false })).toBe('Apex. Installed, 60 hours played.');
  });

  it('describes live tiles, browse tiles and toolbar chips', () => {
    expect(tileSpeech({ kind: 'playing', key: 'p', game: LIB[0], phase: 'running', startedAt: new Date(NOW - 42 * 60_000).toISOString() }, NOW)).toBe(
      'Now playing: Alpha, 42 minutes so far. Press A to return to the game.',
    );
    expect(tileSpeech({ kind: 'download', key: 'd', game: LIB[2], progress: { gameId: 'Beta', appId: '1', kind: 'install', phase: 'downloading', bytesDone: 42, bytesTotal: 100, rate: 1, watching: true } })).toBe('Beta. Installing, 42 percent.');
    expect(tileSpeech({ kind: 'store', key: 's', platform: 'steam', count: 31, sample: null })).toBe('Steam. 31 games. Press A to browse.');
    expect(tileSpeech({ kind: 'tool', key: 't', tool: { type: 'sort', sort: 'played' } })).toBe('Sort: Most played. Press A to change.');
    expect(tileSpeech({ kind: 'tool', key: 't', tool: { type: 'filter', filter: { kind: 'installed' }, label: 'Installed', count: 5, active: true } })).toBe('Show Installed. 5 games, selected.');
  });
});
