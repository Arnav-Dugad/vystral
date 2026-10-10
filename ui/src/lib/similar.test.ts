import { describe, expect, it } from 'vitest';
import type { Game, Installation, LibraryTags } from '../bridge/types';
import { awaySpan, normTitle, seriesKey, similarInLibrary } from './similar';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: null,
    drive: null, sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: 0,
    userLaunchArgs: null, manualLink: false, lastSeen: daysAgo(0), ...over,
  };
}
function game(id: string, over: Partial<Game> = {}): Game {
  return {
    id, title: id, sortTitle: id.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [inst()], collections: [], trackedSeconds: 3600,
    sessionCount: 1, lastTrackedPlay: daysAgo(3), added: daysAgo(400), ...over,
  } as Game;
}
const TAGS = { 1: 'Open World', 2: 'Racing', 3: 'Driving', 4: 'Multiplayer', 5: 'Horror', 6: 'Atmospheric' } as const;
function tags(games: Record<string, number[]>): LibraryTags {
  return { status: 'ok', message: null, tags: Object.entries(TAGS).map(([id, name]) => ({ id: Number(id), name, count: 1 })), games, covered: 0, steamGames: 0, refreshing: false, fetchedAt: null };
}

describe('similar in your library', () => {
  it('ranks by shared community tags and explains the pick with the strongest ones', () => {
    const me = game('Forza Horizon 5', { genres: ['Racing'] });
    const a = game('Dirt Rally', { genres: ['Racing'], lastTrackedPlay: daysAgo(5) });
    const b = game('Silent Halls', { genres: ['Horror'] });
    const picks = similarInLibrary(me, [me, a, b], { tags: tags({ [me.id]: [1, 2, 3, 4], [a.id]: [3, 2, 6], [b.id]: [5, 6] }), now: NOW });
    expect(picks.map((p) => p.game.id)).toEqual(['Dirt Rally']);
    expect(picks[0].why).toBe('Shares Racing · Driving');
  });

  it('lifts forgotten games (never played, or not for months) and says so', () => {
    const me = game('Me', { genres: ['Racing', 'Open World'] });
    const recent = game('Recent', { genres: ['Racing', 'Open World'], lastTrackedPlay: daysAgo(2) });
    const old = game('Old', { genres: ['Racing', 'Open World'], lastTrackedPlay: daysAgo(245) });
    const never = game('Never', { genres: ['Racing', 'Open World'], trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null });
    const picks = similarInLibrary(me, [recent, old, never], { now: NOW });
    expect(picks.map((p) => p.game.id)).toEqual(['Never', 'Old', 'Recent']);
    expect(picks[0].why).toBe('Shares Racing · Open World · never played');
    expect(picks[1].why).toBe('Shares Racing · Open World · not played in 8 months');
    expect(picks[1].forgotten).toBe('long');
    expect(picks[2].forgotten).toBeNull();
  });

  it('finds the same series from titles and IGDB facts', () => {
    expect(seriesKey('Forza Horizon 4: Ultimate Edition')).toBe('forza horizon');
    expect(seriesKey('Forza Horizon 5')).toBe('forza horizon');
    expect(seriesKey('Mass Effect II - Remastered')).toBe('mass effect');
    expect(seriesKey('Ys')).toBeNull();
    const me = game('Forza Horizon 5');
    const sibling = game('Forza Horizon 4: Ultimate Edition');
    const viaIgdb = game('The Witcher 3: Wild Hunt');
    const listed = game('Gran Turismo Sport');
    const picks = similarInLibrary(me, [sibling, viaIgdb, listed], { facts: { series: ['The Witcher series'], similar: ['Gran Turismo Sport'] }, now: NOW });
    expect(picks.map((p) => p.game.id)).toEqual([sibling.id, viaIgdb.id, listed.id]);
    expect(picks[0].why).toBe('Same series');
    expect(picks[2].why).toBe('IGDB calls it similar');
  });

  it('leaves out the game itself, other editions with the same title, hidden and refunded games, and weak matches', () => {
    const me = game('Nebula Drift', { genres: ['Racing', 'Sci-fi'] });
    const picks = similarInLibrary(me, [
      me,
      game('nebula drift', { id: 'other-edition', genres: ['Racing', 'Sci-fi'] }),
      game('Hidden', { genres: ['Racing', 'Sci-fi'], hidden: true }),
      game('Refunded', { genres: ['Racing', 'Sci-fi'], notOwned: true }),
      game('One genre', { genres: ['Racing'] }),
    ], { now: NOW });
    expect(picks).toEqual([]);
  });

  it('is fast on a big library', () => {
    const lib = Array.from({ length: 10_000 }, (_, i) => game(`G${i}`, { genres: [['Racing', 'RPG', 'Puzzle'][i % 3], 'Indie'] }));
    const t0 = performance.now();
    const picks = similarInLibrary(game('Me', { genres: ['Racing', 'Indie'] }), lib, { now: NOW, limit: 12 });
    expect(performance.now() - t0).toBeLessThan(250);
    expect(picks).toHaveLength(12);
  });

  it('says how long in plain words', () => {
    expect(normTitle('Café: Déjà-vu!')).toBe('cafe deja vu');
    expect(awaySpan(61)).toBe('2 months');
    expect(awaySpan(400)).toBe('a year');
    expect(awaySpan(800)).toBe('2 years');
  });
});
