import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { formatClock, formatDuration, importedPlaytime, isMissing, playSeconds } from './format';
import { hasNeverBeenPlayed, isNeverPlayed } from './neverPlayed';
import { matchesFilters, parseQuery } from './search';
import { suggestGames } from './recommend';

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: null,
    drive: null, sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null,
    userLaunchArgs: null, manualLink: false, lastSeen: '2026-10-01T00:00:00Z', ...over,
  };
}

function game(title: string, over: Partial<Game> = {}, installs: Installation[] = [inst()]): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: installs, collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: '2026-09-01T00:00:00Z', ...over,
  } as Game;
}

describe('formatDuration / formatClock', () => {
  it('uses one "1h 5m" style, with seconds only when asked', () => {
    expect(formatDuration(3900)).toBe('1h 5m');
    expect(formatDuration(45 * 60)).toBe('45m');
    expect(formatDuration(30)).toBe('<1m');
    expect(formatDuration(252, { seconds: true })).toBe('4m 12s');
    expect(formatDuration(45, { seconds: true })).toBe('45s');
    expect(formatDuration(0, { seconds: true })).toBe('0s');
    expect(formatDuration(3780, { seconds: true })).toBe('1h 3m');
  });

  it('formats running timers as a clock', () => {
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(59 * 60 + 59)).toBe('59:59');
    expect(formatClock(3600 + 12 * 60 + 5)).toBe('1:12:05');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('playtime', () => {
  it('never adds store and tracked time (store playtime already includes it): the larger wins', () => {
    expect(playSeconds(game('a', { trackedSeconds: 2 * 3600 }, [inst({ importedPlaytimeMinutes: 300 })]))).toBe(300 * 60);
    expect(playSeconds(game('b', { trackedSeconds: 2 * 3600 }, [inst({ importedPlaytimeMinutes: 30 })]))).toBe(2 * 3600);
    expect(playSeconds(game('c', { trackedSeconds: 90 }, [inst()]))).toBe(90);
  });

  it('names the store whose playtime is shown', () => {
    const g = game('d', {}, [inst({ platform: 'epic', importedPlaytimeMinutes: 10 }), inst({ platform: 'steam', importedPlaytimeMinutes: 400 })]);
    expect(importedPlaytime(g)).toEqual({ minutes: 400, platform: 'steam' });
    expect(importedPlaytime(game('e'))).toBeNull();
  });
});

describe('one definition of "never played"', () => {
  const cases: [Game, boolean][] = [
    [game('fresh'), true],
    [game('store minutes only', {}, [inst({ importedPlaytimeMinutes: 25 })]), false],
    [game('tracked session only', { sessionCount: 1 }), false],
    [game('tracked time only', { trackedSeconds: 40 }), false],
    [game('store date only', {}, [inst({ importedLastPlayed: '2026-08-01T00:00:00Z' })]), false],
  ];

  it('agrees between the helper, search and suggestions', () => {
    const neverFilter = parseQuery('never played', { genres: [], drives: [] }).filters;
    for (const [g, expected] of cases) {
      expect(hasNeverBeenPlayed(g)).toBe(expected);
      expect(isNeverPlayed(g)).toBe(expected);
      expect(matchesFilters(g, neverFilter)).toBe(expected);
    }
    const reasons = suggestGames(cases.map(([g]) => g), Date.parse('2026-10-05T12:00:00Z'), 10);
    for (const s of reasons) {
      const unplayed = /never played|Unplayed/i.test(s.reason);
      expect(unplayed).toBe(hasNeverBeenPlayed(s.game));
    }
  });

  it('hidden games are never offered as never played', () => {
    expect(isNeverPlayed(game('hidden', { hidden: true }))).toBe(false);
    expect(hasNeverBeenPlayed(game('hidden', { hidden: true }))).toBe(true);
  });
});

describe('search words', () => {
  const ctx = { genres: [], drives: [] };
  it('maps "backlog" to the Backlog status, not to never played', () => {
    const q = parseQuery('backlog', ctx);
    expect(q.filters.status).toBe('backlog');
    expect(q.filters.neverPlayed).toBeUndefined();
    expect(q.chips).toContain('Backlog');
    expect(matchesFilters(game('b', { status: 'backlog', trackedSeconds: 600 }), q.filters)).toBe(true);
    expect(matchesFilters(game('n'), q.filters)).toBe(false);
  });

  it('"missing" means files gone from disk; "not installed" is broader', () => {
    const missing = game('m', {}, [inst({ state: 'missing' })]);
    const notInstalled = game('n', {}, [inst({ state: 'notinstalled' })]);
    expect(isMissing(missing)).toBe(true);
    expect(isMissing(notInstalled)).toBe(false);
    const m = parseQuery('missing', ctx).filters;
    expect(matchesFilters(missing, m)).toBe(true);
    expect(matchesFilters(notInstalled, m)).toBe(false);
    const ni = parseQuery('not installed', ctx).filters;
    expect(matchesFilters(missing, ni)).toBe(true);
    expect(matchesFilters(notInstalled, ni)).toBe(true);
  });
});
