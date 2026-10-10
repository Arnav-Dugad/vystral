import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { describeSmartFilter, matchesSmartFilter, missingTtbCount, parseSmartFilter, smartFilterFromQuery } from './smartFilter';
import { parseQuery } from './search';

const NOW = Date.parse('2026-10-10T20:00:00Z');

function game(id: string, over: Partial<Game> = {}, inst: Partial<Installation> = {}): Game {
  return {
    id, title: id, sortTitle: id.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false,
    hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null },
    installations: [{
      id: `${id}-i`, platform: 'steam', platformGameId: '1', title: id, state: 'installed', installPath: null, drive: 'C:', sizeBytes: 10e9, clientRequired: false,
      launchKind: 'uri', importedLastPlayed: null, importedPlaytimeMinutes: null, userLaunchArgs: null, manualLink: false, lastSeen: '2026-01-01', ...inst,
    } as Installation],
    collections: [], trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null, added: '2025-01-01T00:00:00Z', status: null, ...over,
  };
}

describe('parseSmartFilter', () => {
  it('rebuilds a valid rule from JSON text and drops unknown keys', () => {
    expect(parseSmartFilter('{"genresAny":["Casual"],"statusNone":["beaten","completed"],"ttbMaxHours":20,"__proto__":{"x":1},"evil":"<script>"}'))
      .toEqual({ v: 1, genresAny: ['Casual'], statusNone: ['beaten', 'completed'], ttbMaxHours: 20 });
  });

  it.each([
    'not json',
    '[]',
    '{}',
    '{"v":2,"installed":true}',
    '{"installed":"yes"}',
    '{"ttbMaxHours":-1}',
    '{"ttbMaxHours":"20"}',
    '{"genresAny":"RPG"}',
    '{"genresAny":[1]}',
    '{"statusAny":["finished"]}',
    '{"platforms":["psn"]}',
    '{"releasedFrom":2020,"releasedTo":2010}',
    `{"titleIncludes":"${'a'.repeat(61)}"}`,
  ])('rejects %s', (raw) => expect(parseSmartFilter(raw)).toBeNull());

  it('rejects oversized strings and non-objects', () => {
    expect(parseSmartFilter('{'.repeat(5000))).toBeNull();
    expect(parseSmartFilter(null)).toBeNull();
    expect(parseSmartFilter(42)).toBeNull();
  });
});

describe('matchesSmartFilter', () => {
  const ttb = { a: { main: 15 * 3600, extras: null, completionist: null, count: 3, fetched: '', source: 'igdb' as const } };

  it('cosy games under 20 hours I haven’t finished', () => {
    const f = parseSmartFilter({ genresAny: ['Casual', 'Puzzle'], statusNone: ['beaten', 'completed'], ttbMaxHours: 20 })!;
    expect(matchesSmartFilter(game('a', { genres: ['Casual'] }), f, { ttb, now: NOW })).toBe(true);
    expect(matchesSmartFilter(game('a', { genres: ['Casual'], status: 'beaten' }), f, { ttb, now: NOW })).toBe(false);
    expect(matchesSmartFilter(game('b', { genres: ['Casual'] }), f, { ttb, now: NOW })).toBe(false); // no estimate
    expect(matchesSmartFilter(game('a', { genres: ['Shooter'] }), f, { ttb, now: NOW })).toBe(false);
    expect(matchesSmartFilter(game('a', { genres: ['Casual'], hidden: true }), f, { ttb, now: NOW })).toBe(false);
  });

  it('handles installed, never played, recency, size and release years', () => {
    const played = game('p', { lastTrackedPlay: '2026-10-01T00:00:00Z', trackedSeconds: 3600, sessionCount: 1, releaseDate: '2019-03-01' });
    expect(matchesSmartFilter(played, parseSmartFilter({ playedWithinDays: 30 })!, { now: NOW })).toBe(true);
    expect(matchesSmartFilter(played, parseSmartFilter({ notPlayedDays: 30 })!, { now: NOW })).toBe(false);
    expect(matchesSmartFilter(played, parseSmartFilter({ neverPlayed: true })!, { now: NOW })).toBe(false);
    expect(matchesSmartFilter(played, parseSmartFilter({ releasedFrom: 2018, releasedTo: 2020 })!, { now: NOW })).toBe(true);
    expect(matchesSmartFilter(played, parseSmartFilter({ sizeMaxGb: 5 })!, { now: NOW })).toBe(false);
    expect(matchesSmartFilter(game('n', {}, { state: 'notinstalled' }), parseSmartFilter({ installed: false })!, { now: NOW })).toBe(true);
    expect(matchesSmartFilter(game('s'), parseSmartFilter({ inSubscription: true })!, { subs: { s: [{}] }, now: NOW })).toBe(true);
    expect(matchesSmartFilter(game('s'), parseSmartFilter({ statusAny: ['none'] })!, { now: NOW })).toBe(true);
  });

  it('counts games left out only for lacking a time-to-beat estimate', () => {
    const f = parseSmartFilter({ genresAny: ['Casual'], ttbMaxHours: 20 })!;
    expect(missingTtbCount([game('a', { genres: ['Casual'] }), game('b', { genres: ['Casual'] }), game('c')], f, { ttb })).toBe(1);
  });
});

describe('describeSmartFilter', () => {
  it('reads like plain chips', () => {
    expect(describeSmartFilter({ v: 1, genresAny: ['Casual', 'Puzzle'], statusNone: ['beaten', 'completed'], ttbMaxHours: 20, installed: true }))
      .toEqual(['Casual or Puzzle', 'Not Beaten or Completed', 'Installed', 'Under 20 h to beat']);
  });
});

describe('smartFilterFromQuery (no AI)', () => {
  it('uses VYSTRAL’s own filter words and reports what it didn’t understand', () => {
    const s = 'installed racing games under 20 hours I haven’t finished with dragons';
    const { filter, leftover } = smartFilterFromQuery(parseQuery(s.replace('’', "'"), { genres: ['Racing'], drives: [] }), s.replace('’', "'"));
    expect(filter).toMatchObject({ installed: true, genresAny: ['Racing'], ttbMaxHours: 20, statusNone: ['beaten', 'completed'] });
    expect(leftover).toContain('dragons');
  });

  it('returns no filter when nothing was understood', () => {
    expect(smartFilterFromQuery(parseQuery('qwerty zxcv', { genres: [], drives: [] }), 'qwerty zxcv').filter).toBeNull();
  });
});
