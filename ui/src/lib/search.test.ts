import { describe, expect, it } from 'vitest';
import type { DriveInfo, Game, Installation } from '../bridge/types';
import { matchesFilters, parseQuery, searchGames, titleScore } from './search';

const GB = 1024 ** 3;
const NOW = Date.parse('2026-10-04T12:00:00Z');

function inst(p: Partial<Installation> = {}): Installation {
  return {
    id: 'i', platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: 'D:\\Games\\x', drive: 'D:',
    sizeBytes: 10 * GB, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null,
    userLaunchArgs: null, manualLink: false, lastSeen: '2026-10-01', ...p,
  };
}

function game(title: string, p: Partial<Game> = {}, i: Partial<Installation> = {}): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null,
    genres: [], favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null,
    palette: null, art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [inst(i)], collections: [],
    trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01', ...p,
  };
}

const drives: DriveInfo[] = [
  { name: 'C:', label: 'Windows', totalBytes: 1, freeBytes: 1, isSystem: true, removable: false },
  { name: 'E:', label: 'Games 2', totalBytes: 1, freeBytes: 1, isSystem: false, removable: false },
  { name: 'D:', label: 'Games', totalBytes: 1, freeBytes: 1, isSystem: false, removable: false },
];
const ctx = { genres: ['Racing', 'Horror', 'RPG', 'Space'], drives, now: NOW };

describe('parseQuery', () => {
  it('understands installed racing games under a size', () => {
    const q = parseQuery('Show my installed racing games under 20 GB', ctx);
    expect(q.filters.installed).toBe(true);
    expect(q.filters.genres).toEqual(['Racing']);
    expect(q.filters.maxSizeBytes).toBe(20 * GB);
    expect(q.text).toBe('');
    expect(q.structured).toBe(true);
    expect(q.chips).toContain('Installed');
  });

  it('recognises launch intent and keeps the title intact', () => {
    const q = parseQuery('Launch Forza', ctx);
    expect(q.intent).toBe('launch');
    expect(q.text).toBe('forza');
  });

  it('understands recency phrasing', () => {
    expect(parseQuery("Find games I haven't played recently", ctx).filters.notPlayedDays).toBe(30);
    expect(parseQuery('not played in 3 months', ctx).filters.notPlayedDays).toBe(90);
    expect(parseQuery('never played', ctx).filters.neverPlayed).toBe(true);
    expect(parseQuery('recently played', ctx).filters.playedWithinDays).toBe(14);
  });

  it('maps "second SSD" to the first non-system drive', () => {
    const q = parseQuery('Show everything installed on my second SSD', ctx);
    expect(q.filters.drives).toEqual(['D:']);
    expect(q.filters.installed).toBe(true);
  });

  it('understands explicit drive letters and platforms', () => {
    const q = parseQuery('steam horror on d:', ctx);
    expect(q.filters.platforms).toEqual(['steam']);
    expect(q.filters.genres).toEqual(['Horror']);
    expect(q.filters.drives).toEqual(['D:']);
  });

  it('maps synonyms like "role-playing" and "game pass"', () => {
    const q = parseQuery('game pass role-playing', ctx);
    expect(q.filters.platforms).toEqual(['xbox']);
    expect(q.filters.genres).toEqual(['RPG']);
  });

  it('leaves plain titles as free text', () => {
    const q = parseQuery('witcher 3', ctx);
    expect(q.text).toBe('witcher 3');
    expect(q.chips).toEqual([]);
  });
});

describe('titleScore', () => {
  it('ranks exact, prefix, word and acronym matches', () => {
    expect(titleScore('Forza Horizon 5', 'forza horizon 5')).toBe(100);
    expect(titleScore('Forza Horizon 5', 'forza')).toBeGreaterThan(titleScore('Need for Speed', 'forza'));
    expect(titleScore('Red Dead Redemption 2', 'rdr2')).toBeGreaterThan(0);
    expect(titleScore('The Witcher III: Wild Hunt', 'witcher 3')).toBeGreaterThan(0);
    expect(titleScore('Pokémon Legends', 'pokemon')).toBeGreaterThan(0);
    expect(titleScore('Celeste', 'zzz')).toBe(0);
  });
});

describe('matchesFilters / searchGames', () => {
  const library = [
    game('Redline Rivals', { genres: ['Racing'] }, { sizeBytes: 15 * GB }),
    game('Circuit Apex', { genres: ['Racing'] }, { sizeBytes: 60 * GB, platform: 'xbox' }),
    game('Hollow Lantern', { genres: ['Horror'] }, { state: 'missing' }),
    game('Old Favorite', { favorite: true, lastTrackedPlay: '2026-05-01T00:00:00Z', trackedSeconds: 3600 }),
    game('Secret', { hidden: true }),
  ];

  it('filters by genre, size and installation', () => {
    const q = parseQuery('installed racing under 20 gb', ctx);
    expect(searchGames(library, q, NOW).map((g) => g.title)).toEqual(['Redline Rivals']);
  });

  it('excludes hidden games unless asked', () => {
    expect(searchGames(library, parseQuery('', ctx), NOW).some((g) => g.hidden)).toBe(false);
    expect(searchGames(library, parseQuery('hidden', ctx), NOW).map((g) => g.title)).toEqual(['Secret']);
  });

  it('handles "not played in 30 days" using the most recent play from any source', () => {
    expect(matchesFilters(library[3], { notPlayedDays: 30 }, NOW)).toBe(true);
    expect(matchesFilters(library[3], { playedWithinDays: 30 }, NOW)).toBe(false);
  });

  it('stays fast on a large library', () => {
    const big = Array.from({ length: 10000 }, (_, i) => game(`Game ${i} ${i % 7 ? 'Quest' : 'Racer'}`, { genres: [i % 3 ? 'RPG' : 'Racing'] }));
    const q = parseQuery('installed racing racer', ctx);
    const t0 = performance.now();
    const out = searchGames(big, q, NOW);
    expect(out.length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(250);
  });
});
