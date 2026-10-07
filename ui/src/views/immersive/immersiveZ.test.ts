import { describe, expect, it } from 'vitest';
import type { CollectionInfo, Game, Installation, PlatformKey } from '../../bridge/types';
import { homeRows, type Row } from './rows';
import { applyRowOrder, isAutomatic, isMovableRow, mergeRowOrder, movableIds, parseRowOrder, serializeRowOrder, stepRow } from './rowOrder';
import { clockDrift, clockParts, showcaseKicker, showcasePool, STALE_DAYS, trailerMode } from './screensaver';

// Track Z: your own Home row order, the screensaver's showcase and trailer rules, the big clock.

const NOW = Date.parse('2026-10-07T12:00:00Z');
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
const row = (id: string, kind: Row['kind'] = 'collection'): Row => ({ id, kind, title: id, tiles: [] });
const ids = (rows: Row[]) => rows.map((r) => r.id);

describe('row order: saved setting', () => {
  it('parses the setting into clean ids and drops junk, duplicates and overlong lists', () => {
    expect(parseRowOrder('favorites|continue|collection:abc123')).toEqual(['favorites', 'continue', 'collection:abc123']);
    expect(parseRowOrder('')).toEqual([]);
    expect(parseRowOrder(undefined)).toEqual([]);
    expect(parseRowOrder(42)).toEqual([]);
    expect(parseRowOrder('a||b|a|<script>|c d|e')).toEqual(['a', 'b', 'e']);
    expect(parseRowOrder(Array.from({ length: 80 }, (_, i) => `r${i}`).join('|'))).toHaveLength(40);
    expect(serializeRowOrder(['b', 'a', 'b', 'bad id'])).toBe('b|a');
  });

  it('only Home shelves move: live rows, the toolbar and the grid stay put', () => {
    expect(isMovableRow(row('continue', 'continue'))).toBe(true);
    expect(isMovableRow(row('collection:x'))).toBe(true);
    expect(isMovableRow(row('playing', 'playing'))).toBe(false);
    expect(isMovableRow(row('downloads', 'downloads'))).toBe(false);
    expect(isMovableRow(row('tools', 'tools'))).toBe(false);
    expect(isMovableRow(row('lib-0', 'library'))).toBe(false);
    expect(isMovableRow(null)).toBe(false);
  });
});

describe('row order: applying it', () => {
  const auto = [row('continue', 'continue'), row('picked', 'picked'), row('favorites', 'favorites'), row('installed', 'installed'), row('genres', 'genres')];

  it('without a saved order, the automatic (time-of-day) order stands', () => {
    expect(ids(applyRowOrder(auto, []))).toEqual(['continue', 'picked', 'favorites', 'installed', 'genres']);
  });

  it('puts saved rows in their saved places', () => {
    expect(ids(applyRowOrder(auto, ['genres', 'favorites', 'continue', 'picked', 'installed']))).toEqual(['genres', 'favorites', 'continue', 'picked', 'installed']);
  });

  it('rows the order does not know follow the row they follow automatically', () => {
    // "picked" and "installed" are new: they stay right after "continue" and "favorites".
    expect(ids(applyRowOrder(auto, ['favorites', 'continue', 'genres']))).toEqual(['favorites', 'installed', 'continue', 'picked', 'genres']);
    // A new row before any known row leads.
    expect(ids(applyRowOrder([row('new', 'new'), ...auto], ['genres', 'continue']))).toEqual(['new', 'genres', 'continue', 'picked', 'favorites', 'installed']);
  });

  it('saved ids for rows that are not shown (empty right now) change nothing', () => {
    expect(ids(applyRowOrder(auto, ['unplayed', 'continue', 'collection:gone', 'picked', 'favorites', 'installed', 'genres']))).toEqual(ids(auto));
    // Unknown rows keep following their automatic predecessor ("picked" here).
    expect(ids(applyRowOrder(auto, ['unplayed', 'picked', 'continue', 'collection:gone']))).toEqual(['picked', 'favorites', 'installed', 'genres', 'continue']);
  });

  it('Now playing still leads and Downloads still follows Continue in your order', () => {
    const lib = [
      game('Alpha', { lastTrackedPlay: daysAgo(1), favorite: true }),
      game('Beta', { lastTrackedPlay: daysAgo(2), favorite: true }),
      game('Gamma'),
    ];
    const live = {
      playing: { game: lib[0], phase: 'running' as const, startedAt: daysAgo(0) },
      downloads: [{ game: lib[2], progress: { gameId: 'Gamma', kind: 'install', phase: 'downloading', watching: true } as never }],
    };
    const rows = ids(homeRows(lib, [], NOW, 20, live, ['favorites', 'installed', 'continue']));
    expect(rows[0]).toBe('playing');
    expect(rows.indexOf('favorites')).toBeLessThan(rows.indexOf('installed'));
    expect(rows.indexOf('installed')).toBeLessThan(rows.indexOf('continue'));
    expect(rows[rows.indexOf('continue') + 1]).toBe('downloads');
  });

  it('collection rows can be ordered by their ids', () => {
    const cols: CollectionInfo[] = [{ id: 'c1', name: 'Co-op', icon: null, sortOrder: 0, rule: null, count: 1 }];
    const lib = [game('Alpha', { collections: ['c1'], lastTrackedPlay: daysAgo(1) })];
    expect(ids(homeRows(lib, cols, NOW, 20, {}, ['collection:c1', 'continue']))[0]).toBe('collection:c1');
  });
});

describe('row order: moving and saving', () => {
  it('steps a row up or down and stops at the ends', () => {
    expect(stepRow(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(stepRow(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(stepRow(['a', 'b', 'c'], 'a', -1)).toBeNull();
    expect(stepRow(['a', 'b', 'c'], 'c', 1)).toBeNull();
    expect(stepRow(['a', 'b'], 'zzz', 1)).toBeNull();
  });

  it('keeps the places of rows that were not on screen when saving', () => {
    // "unplayed" was saved after "picked" but is empty now: it keeps following "picked".
    expect(mergeRowOrder(['continue', 'picked', 'unplayed', 'genres'], ['genres', 'picked', 'continue'])).toEqual(['genres', 'picked', 'unplayed', 'continue']);
    // One saved first stays first.
    expect(mergeRowOrder(['unplayed', 'continue'], ['picked', 'continue'])).toEqual(['unplayed', 'picked', 'continue']);
    expect(mergeRowOrder([], ['b', 'a'])).toEqual(['b', 'a']);
  });

  it('knows when the result is just the automatic order', () => {
    expect(isAutomatic(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isAutomatic(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(isAutomatic(['a', 'b'], ['a'])).toBe(false);
  });

  it('lists the movable rows in screen order', () => {
    expect(movableIds([row('playing', 'playing'), row('continue', 'continue'), row('downloads', 'downloads'), row('genres', 'genres')])).toEqual(['continue', 'genres']);
  });
});

describe('screensaver: what it showcases', () => {
  const lib = [
    game('Recent', { lastTrackedPlay: daysAgo(2), trackedSeconds: 90 * 3600 }),
    game('Loved long ago', { lastTrackedPlay: daysAgo(240), trackedSeconds: 120 * 3600 }),
    game('Played a bit', { lastTrackedPlay: daysAgo(60), trackedSeconds: 3 * 3600 }),
    game('Just past', { lastTrackedPlay: daysAgo(STALE_DAYS + 1), trackedSeconds: 10 * 3600 }),
    game('Never started', { added: daysAgo(5) }),
    game('Never started old', { added: daysAgo(300) }),
    game('Not installed', { lastTrackedPlay: daysAgo(400), trackedSeconds: 500 * 3600 }, 'steam', 'notinstalled'),
    game('Hidden', { lastTrackedPlay: daysAgo(400), hidden: true }),
    game('Fav not installed', { lastTrackedPlay: daysAgo(100), favorite: true }, 'epic', 'notinstalled'),
  ];

  it('rediscoveries first (most played), two to one with installed games never started', () => {
    const pool = showcasePool(lib, NOW);
    expect(pool.map((p) => p.game.title)).toEqual(['Loved long ago', 'Just past', 'Never started', 'Played a bit', 'Fav not installed', 'Never started old']);
    expect(pool[0].reason).toBe('stale');
    expect(pool[2].reason).toBe('waiting');
  });

  it('never shows hidden games, or games you cannot play unless they are favourites', () => {
    const titles = showcasePool(lib, NOW).map((p) => p.game.title);
    expect(titles).not.toContain('Hidden');
    expect(titles).not.toContain('Not installed');
    expect(titles).not.toContain('Recent');
  });

  it('tops up with recent games when there are too few rediscoveries', () => {
    const small = [game('A', { lastTrackedPlay: daysAgo(1) }), game('B', { lastTrackedPlay: daysAgo(3) }), game('Old', { lastTrackedPlay: daysAgo(90) })];
    const pool = showcasePool(small, NOW);
    expect(pool.map((p) => [p.game.title, p.reason])).toEqual([['Old', 'stale'], ['A', 'recent'], ['B', 'recent']]);
    expect(showcasePool([], NOW)).toEqual([]);
  });

  it('caps the pool', () => {
    const many = Array.from({ length: 60 }, (_, i) => game(`G${i}`, { lastTrackedPlay: daysAgo(40 + i), trackedSeconds: i * 60 }));
    expect(showcasePool(many, NOW)).toHaveLength(24);
    expect(showcasePool(many, NOW, 5)).toHaveLength(5);
  });

  it('says why a game is shown', () => {
    expect(showcaseKicker('stale')).toBe('It’s been a while');
    expect(showcaseKicker('waiting')).toBe('Still waiting for you');
    expect(showcaseKicker('recent')).toBeNull();
  });
});

describe('screensaver: trailers', () => {
  it('play only when every live-tile rule allows and its own switch is on', () => {
    expect(trailerMode({ enabled: true, liveBlock: null, batterySaver: false })).toBe('play');
    expect(trailerMode({ enabled: false, liveBlock: null, batterySaver: false })).toBe('off');
    for (const b of ['dataSaver', 'lowQuality', 'offline', 'reducedMotion', 'gameActive', 'hidden', 'safeMode', 'off'] as const) {
      expect(trailerMode({ enabled: true, liveBlock: b, batterySaver: false })).toBe('off');
      expect(trailerMode({ enabled: true, liveBlock: b, batterySaver: true })).toBe('off');
    }
  });

  it('pause on battery saver', () => {
    expect(trailerMode({ enabled: true, liveBlock: null, batterySaver: true })).toBe('pause');
  });
});

describe('the big clock', () => {
  const at = new Date(2026, 9, 7, 21, 5); // local time: 21:05

  it('follows a 24-hour Windows format, with a leading zero', () => {
    const c = clockParts(new Date(2026, 9, 7, 9, 5), false, 'en-US');
    expect(c.time).toBe('09:05');
    expect(c.period).toBeNull();
    expect(clockParts(at, false, 'en-GB').label).toBe('21:05');
  });

  it('follows a 12-hour Windows format, with the period apart', () => {
    const c = clockParts(at, true, 'en-US');
    expect(c.time).toBe('9:05');
    expect(c.period).toBe('PM');
    expect(c.label).toBe('9:05 PM');
    // A 12-hour format in a language that usually writes 24-hour time.
    expect(clockParts(at, true, 'en-GB').period?.toLowerCase()).toBe('pm');
  });

  it('uses the language default when the Windows format is unknown', () => {
    expect(clockParts(at, null, 'en-GB').period).toBeNull();
    expect(clockParts(at, undefined, 'en-US').period).toBe('PM');
  });

  it('writes the date out in full', () => {
    expect(clockParts(at, false, 'en-US').date).toBe('Wednesday, October 7');
  });

  it('drifts to a new spot every minute, within bounds, and never sits still', () => {
    let prev = clockDrift(0);
    let moved = 0;
    for (let m = 1; m <= 2000; m++) {
      const d = clockDrift(m);
      expect(Math.abs(d.x)).toBeLessThanOrEqual(6);
      expect(Math.abs(d.y)).toBeLessThanOrEqual(8);
      const step = Math.hypot(d.x - prev.x, d.y - prev.y);
      expect(step).toBeGreaterThan(3);
      moved += step;
      prev = d;
    }
    expect(moved / 2000).toBeGreaterThan(3); // a real move each minute, not a jiggle
    expect(clockDrift(123)).toEqual(clockDrift(123)); // deterministic
  });
});
