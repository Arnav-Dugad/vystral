import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { ageLabel, ageSpan, isNeverPlayed, neverPlayedGames, ownedSince, tonightPicks } from './neverPlayed';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'notinstalled', installPath: null,
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

describe('never played selection', () => {
  it('needs zero store playtime, no store last-played date and no tracked sessions', () => {
    expect(isNeverPlayed(game('fresh'))).toBe(true);
    expect(isNeverPlayed(game('no data', {}, [inst({ importedPlaytimeMinutes: null })]))).toBe(true);
    expect(isNeverPlayed(game('store minutes', {}, [inst({ importedPlaytimeMinutes: 12 })]))).toBe(false);
    expect(isNeverPlayed(game('store date', {}, [inst({ importedLastPlayed: daysAgo(3) })]))).toBe(false);
    expect(isNeverPlayed(game('tracked', { trackedSeconds: 60 }))).toBe(false);
    expect(isNeverPlayed(game('session', { sessionCount: 1 }))).toBe(false);
    expect(isNeverPlayed(game('hidden', { hidden: true }))).toBe(false);
    // Two stores: one never played, the other played — it has been played.
    expect(isNeverPlayed(game('two', {}, [inst(), inst({ platform: 'epic', importedPlaytimeMinutes: 40 })]))).toBe(false);
  });

  it('lists the longest-waiting first and leaves out games you finished or gave up on', () => {
    const list = neverPlayedGames([
      game('b', { added: daysAgo(10) }),
      game('a', { added: daysAgo(900) }),
      game('done', { added: daysAgo(2000), status: 'beaten' }),
      game('nope', { added: daysAgo(2000), status: 'abandoned' }),
      game('later', { added: daysAgo(500), status: 'backlog' }),
    ]);
    expect(list.map((g) => g.id)).toEqual(['a', 'later', 'b']);
  });
});

describe('age labels', () => {
  it('says how long VYSTRAL has known the game, honestly labelled', () => {
    expect(ownedSince(game('x', { added: daysAgo(3) }))).toEqual({ at: daysAgo(3), source: 'firstSeen' });
    expect(ownedSince(game('x', { added: 'garbage' }))).toBeNull();
    expect(ageLabel(game('x', { added: daysAgo(0.2) }), NOW)).toBe('New to VYSTRAL today');
    expect(ageLabel(game('x', { added: daysAgo(1) }), NOW)).toBe('In VYSTRAL for 1 day');
    expect(ageLabel(game('x', { added: daysAgo(3 * 365.25 + 10) }), NOW)).toBe('In VYSTRAL for 3 years');
  });

  it('rounds spans down to the natural unit', () => {
    expect(ageSpan(daysAgo(13), NOW)).toBe('13 days');
    expect(ageSpan(daysAgo(14), NOW)).toBe('2 weeks');
    expect(ageSpan(daysAgo(59), NOW)).toBe('8 weeks');
    expect(ageSpan(daysAgo(61), NOW)).toBe('2 months');
    expect(ageSpan(daysAgo(364), NOW)).toBe('11 months');
    expect(ageSpan(daysAgo(366), NOW)).toBe('1 year');
    expect(ageSpan(daysAgo(-5), NOW)).toBe('today'); // clock skew never goes negative
  });
});

describe('try it tonight', () => {
  const library = [
    game('cloud a', { added: daysAgo(800) }),
    game('ready', { added: daysAgo(40) }, [inst({ state: 'installed', drive: 'D:' })]),
    game('backlogged', { added: daysAgo(20), status: 'backlog' }),
    game('cloud b', { added: daysAgo(30) }),
    game('played', { trackedSeconds: 600 }),
  ];

  it('prefers installed games, then your backlog, and explains why', () => {
    const picks = tonightPicks(library, NOW, 3);
    expect(picks).toHaveLength(3);
    expect(picks[0].game.id).toBe('ready');
    expect(picks[0].reason).toBe('Installed and waiting 5 weeks');
    expect(picks.map((p) => p.game.id)).not.toContain('played');
    const backlog = picks.find((p) => p.game.id === 'backlogged');
    if (backlog) expect(backlog.reason).toBe('On your backlog');
  });

  it('is stable within a day and nothing when everything has been played', () => {
    expect(tonightPicks(library, NOW)).toEqual(tonightPicks(library, NOW + 3600_000));
    expect(tonightPicks([game('p', { trackedSeconds: 1 })], NOW)).toEqual([]);
  });
});
