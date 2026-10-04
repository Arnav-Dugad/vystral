import { describe, expect, it } from 'vitest';
import type { Game } from '../bridge/types';
import { formatBytes, formatDuration, lastPlayed } from './format';
import { featuredGame, suggestGames } from './recommend';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const day = 86400000;

function game(title: string, p: Partial<Game> = {}, installed = true, imported?: { at?: string; minutes?: number }): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null,
    genres: [], favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null,
    palette: null, art: { cover: null, hero: null, logo: null, header: null, icon: null },
    installations: [{
      id: `${title}-i`, platform: 'steam', platformGameId: title, title, state: installed ? 'installed' : 'missing', installPath: null, drive: null,
      sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: imported?.at ?? null, importedPlaytimeMinutes: imported?.minutes ?? null,
      userLaunchArgs: null, manualLink: false, lastSeen: '',
    }],
    collections: [], trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01', ...p,
  };
}

describe('suggestGames', () => {
  const lib = [
    game('Racer A', { genres: ['Racing'], trackedSeconds: 40 * 3600, lastTrackedPlay: new Date(NOW - 1 * day).toISOString() }),
    game('Racer B', { genres: ['Racing'] }),
    game('Puzzle C', { genres: ['Puzzle'] }),
    game('Old Love', { genres: ['RPG'], trackedSeconds: 30 * 3600, lastTrackedPlay: new Date(NOW - 120 * day).toISOString() }),
    game('Not Installed', { genres: ['Racing'] }, false),
    game('Hidden', { genres: ['Racing'], hidden: true }),
  ];

  it('never suggests hidden, uninstalled or currently-played games', () => {
    const titles = suggestGames(lib, NOW).map((s) => s.game.title);
    expect(titles).not.toContain('Hidden');
    expect(titles).not.toContain('Not Installed');
    expect(titles).not.toContain('Racer A');
  });

  it('ranks an unplayed game in the most-played genre and a lapsed favourite at the top, with reasons', () => {
    const top = suggestGames(lib, NOW).slice(0, 2);
    expect(top.map((s) => s.game.title).sort()).toEqual(['Old Love', 'Racer B']);
    expect(top.find((s) => s.game.title === 'Racer B')!.reason).toMatch(/Racing/);
    // A game in a genre the user never plays ranks below both.
    expect(suggestGames(lib, NOW).map((s) => s.game.title).indexOf('Puzzle C')).toBeGreaterThan(1);
  });

  it('explains returning favourites with a real date', () => {
    const old = suggestGames(lib, NOW).find((s) => s.game.title === 'Old Love')!;
    expect(old.reason).toMatch(/Last played 4 months ago/);
  });
});

describe('featuredGame', () => {
  it('features the most recently played installed game, from any source', () => {
    const lib = [game('A', { lastTrackedPlay: '2026-09-01T00:00:00Z' }), game('B', {}, true, { at: '2026-10-01T00:00:00Z' })];
    expect(featuredGame(lib)?.title).toBe('B');
    expect(lastPlayed(lib[1]).source).toBe('imported');
  });
});

describe('format', () => {
  it('formats durations and sizes', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(59)).toBe('<1m');
    expect(formatDuration(3600 * 1.5)).toBe('1h 30m');
    expect(formatDuration(3600 * 250)).toBe('250h');
    expect(formatBytes(62952466589)).toBe('58.6 GB');
    expect(formatBytes(null)).toBe('—');
  });
});
