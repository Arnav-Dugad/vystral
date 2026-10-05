import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { predictGames, predictWords } from './predict';

function game(title: string, p: Partial<Game> = {}, played: string | null = null): Game {
  const inst: Installation = {
    id: `i-${title}`, platform: 'steam', platformGameId: '1', title, state: 'installed', installPath: null, drive: null, sizeBytes: null,
    clientRequired: true, launchKind: 'Uri', importedLastPlayed: played, importedPlaytimeMinutes: null, userLaunchArgs: null, manualLink: false,
    lastSeen: '2026-10-01',
  };
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [inst], collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01', ...p,
  };
}

const LIB = [
  game('Kingsfall', {}, '2026-09-01T00:00:00Z'),
  game('Kingsfall Remastered', {}, '2026-10-01T00:00:00Z'),
  game('Ashen Crown'),
  game('Ashen Tide'),
  game('Paper Kingdoms'),
  game('Assassin’s Path'),
  game('Secret Kingsguard', { hidden: true }),
  game('Nebula Drift', {}, '2026-08-01T00:00:00Z'),
];

describe('predictGames', () => {
  it('shows recently played games when nothing is typed', () => {
    expect(predictGames(LIB, '').map((g) => g.title)).toEqual(['Kingsfall Remastered', 'Kingsfall', 'Nebula Drift']);
  });

  it('ranks title matches and never includes hidden games', () => {
    const titles = predictGames(LIB, 'kings').map((g) => g.title);
    expect(titles.slice(0, 2)).toEqual(['Kingsfall', 'Kingsfall Remastered']);
    expect(titles).not.toContain('Secret Kingsguard');
  });

  it('breaks score ties by recent play', () => {
    // Same length, so the same prefix score: the one played more recently leads.
    const lib = [game('Moss Alpha'), game('Moss Gamma', {}, '2026-09-20T00:00:00Z'), game('Moss Delta', {}, '2026-09-01T00:00:00Z')];
    expect(predictGames(lib, 'moss').map((g) => g.title)).toEqual(['Moss Gamma', 'Moss Delta', 'Moss Alpha']);
  });

  it('respects the limit and returns nothing for gibberish', () => {
    expect(predictGames(LIB, 'a', 2)).toHaveLength(2);
    expect(predictGames(LIB, 'zzqx')).toEqual([]);
  });
});

describe('predictWords', () => {
  it('completes the word being typed from library titles', () => {
    const p = predictWords(LIB, 'kin');
    expect(p.map((w) => w.word)).toEqual(['Kingsfall', 'Kingdoms']);
    expect(p[0].query).toBe('Kingsfall ');
  });

  it('suggests the next word after a space', () => {
    expect(predictWords(LIB, 'ashen ').map((w) => w.word).sort()).toEqual(['Crown', 'Tide']);
    expect(predictWords(LIB, 'ashen ')[0].query).toMatch(/^ashen (Crown|Tide) $/);
  });

  it('completes later words in the context of earlier ones', () => {
    expect(predictWords(LIB, 'kingsfall re').map((w) => w.query)).toEqual(['kingsfall Remastered ']);
    expect(predictWords(LIB, 'paper re')).toEqual([]);
  });

  it('keeps apostrophes inside words and ignores hidden titles', () => {
    expect(predictWords(LIB, 'ass').map((w) => w.word)).toEqual(['Assassin’s']);
    expect(predictWords(LIB, 'kingsg')).toEqual([]);
  });

  it('returns nothing for an empty query or an exact word', () => {
    expect(predictWords(LIB, '')).toEqual([]);
    expect(predictWords(LIB, '   ')).toEqual([]);
    expect(predictWords(LIB, 'tide').map((w) => w.word)).toEqual([]);
  });
});
