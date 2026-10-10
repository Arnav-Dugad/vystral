import { afterEach, describe, expect, it } from 'vitest';
import type { Game, Installation, Settings } from '../bridge/types';
import { buildHomeModel, gamesFor, homeModelIds } from './homeModel';
import { buildFirstPaint, firstPaintKey, liteGame, MAX_GAMES, parseFirstPaint, PREVIEW_KEY, readFirstPaint } from './firstPaint';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
let seq = 0;
const hexId = () => (++seq).toString(16).padStart(32, '0');

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: hexId(), platform: 'steam', platformGameId: '10', title: 't', state: 'installed', installPath: 'C:\\Games\\T',
    drive: 'C:', sizeBytes: 1_000, clientRequired: false, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: 0,
    userLaunchArgs: '-secret', manualLink: false, lastSeen: daysAgo(0), ...over,
  };
}

function game(title: string, over: Partial<Game> = {}, installs: Installation[] = [inst()]): Game {
  return {
    id: hexId(), title, sortTitle: title.toLowerCase(), description: `About ${title}`, developer: 'Dev', publisher: 'Pub', releaseDate: '2024-01-01', genres: ['Action'],
    favorite: false, hidden: false, userRating: null, notes: 'my private note', preferredInstallationId: null, metadataSource: 'steam', palette: null,
    art: { cover: `https://art.vystral.example/${title}/cover.jpg`, hero: null, logo: null, header: null, icon: null }, installations: installs, collections: ['c1'],
    trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null, added: daysAgo(100), status: null, statusChangedAt: null, ...over,
  };
}

const SETTINGS = { 'onboarding.completed': true, 'appearance.theme': 'light', 'motion.reduce': 'on', 'appearance.quality': 'high' } as Settings;

function library(): Game[] {
  return [
    game('Played Yesterday', { lastTrackedPlay: daysAgo(1), trackedSeconds: 7200, sessionCount: 3 }),
    game('Played Last Week', { lastTrackedPlay: daysAgo(7), trackedSeconds: 3600, sessionCount: 2, favorite: true }),
    game('Fresh', { added: daysAgo(2) }),
    game('Waiting', { favorite: true }),
    game('Missing', {}, [inst({ state: 'missing' })]),
    game('Client', {}, [inst({ clientRequired: true, platform: 'epic' })]),
  ];
}

describe('home model', () => {
  it('picks the hero, shelves and radar numbers from the library', () => {
    const lib = library();
    const m = buildHomeModel(lib, NOW);
    expect(m.featuredId).toBe(lib[0].id);
    expect(m.continueIds).toEqual([lib[0].id, lib[1].id]); // Track C1: the hero's game leads Continue playing too
    expect(m.favoriteIds).toHaveLength(2);
    expect(m.recentIds).toEqual([lib[2].id]);
    expect(m.pulse).toEqual({ installed: 5, needsClient: 1, missing: 1, platforms: [['steam', 4], ['epic', 1]] });
    expect(m.visibleCount).toBe(6);
    expect(m.never.count).toBeGreaterThan(0);
    expect(new Set(homeModelIds(m)).size).toBe(homeModelIds(m).length);
  });

  it('looks games up without leaving holes', () => {
    const lib = library();
    const byId = new Map(lib.map((g) => [g.id, g]));
    expect(gamesFor([lib[0].id, 'f'.repeat(32), lib[1].id], byId).map((g) => g.title)).toEqual(['Played Yesterday', 'Played Last Week']);
  });
});

describe('first-paint snapshot', () => {
  it('round-trips through JSON and renders the same model', () => {
    const lib = library();
    const fp = buildFirstPaint(lib, SETTINGS, NOW)!;
    const parsed = parseFirstPaint(JSON.parse(JSON.stringify(fp)))!;
    expect(parsed).not.toBeNull();
    expect(parsed.model).toEqual(fp.model);
    expect(parsed.appearance).toEqual({ theme: 'light', reduceMotion: 'on', quality: 'high' });
    expect(parsed.games.map((g) => g.id).sort()).toEqual(homeModelIds(fp.model).sort());
    expect(firstPaintKey(parsed)).toBe(firstPaintKey(fp));
  });

  it('keeps private and bulky fields out', () => {
    const fp = buildFirstPaint(library(), SETTINGS, NOW)!;
    for (const g of fp.games) {
      expect(g.notes).toBeNull();
      expect(g.collections).toEqual([]);
      for (const i of g.installations) {
        expect(i.installPath).toBeNull();
        expect(i.userLaunchArgs).toBeNull();
      }
      // Only the hero keeps its description.
      expect(g.description !== null).toBe(g.id === fp.model.featuredId);
    }
  });

  it('only keeps artwork from VYSTRAL’s own art cache', () => {
    const g = liteGame(game('x', { art: { cover: 'https://evil.example/a.jpg', hero: 'https://art.vystral.example/../x', logo: 'javascript:alert(1)', header: './assets/h.png', icon: 'https://art.vystral.example/ok/icon.png' } }), false);
    expect(g.art).toEqual({ cover: null, hero: null, logo: null, header: './assets/h.png', icon: 'https://art.vystral.example/ok/icon.png' });
  });

  it('is not built for an empty library or before onboarding', () => {
    expect(buildFirstPaint([], SETTINGS, NOW)).toBeNull();
    expect(buildFirstPaint(library(), { ...SETTINGS, 'onboarding.completed': false }, NOW)).toBeNull();
    expect(buildFirstPaint(library(), null, NOW)).toBeNull();
  });

  it('caps the number of games', () => {
    const many = Array.from({ length: 400 }, (_, i) => game(`Fav ${i}`, { favorite: true, lastTrackedPlay: daysAgo(i % 50 + 1), added: daysAgo(i % 20) }));
    const fp = buildFirstPaint(many, SETTINGS, NOW)!;
    expect(fp.games.length).toBeLessThanOrEqual(MAX_GAMES);
    expect(fp.model.favoriteIds.length).toBeLessThanOrEqual(24);
    expect(fp.model.favoriteCount).toBe(400);
    expect(parseFirstPaint(JSON.parse(JSON.stringify(fp)))).not.toBeNull();
  });

  it('rejects anything unexpected, so the live path takes over', () => {
    const good = JSON.parse(JSON.stringify(buildFirstPaint(library(), SETTINGS, NOW)));
    const mutate = (f: (x: any) => void) => {
      const copy = structuredClone(good);
      f(copy);
      return parseFirstPaint(copy);
    };
    expect(parseFirstPaint(null)).toBeNull();
    expect(parseFirstPaint('{"v":1}')).toBeNull();
    expect(mutate((x) => (x.v = 2))).toBeNull();
    expect(mutate((x) => (x.games[0].id = 'not-an-id'))).toBeNull();
    expect(mutate((x) => (x.games[0].title = 42))).toBeNull();
    expect(mutate((x) => (x.games[0].art.cover = 'https://evil.example/x.png'))).toBeNull();
    expect(mutate((x) => (x.games[0].installations[0].platform = 'origin'))).toBeNull();
    expect(mutate((x) => (x.model.pulse.installed = -1))).toBeNull();
    expect(mutate((x) => (x.model.continueIds = 'abc'))).toBeNull();
    expect(mutate((x) => x.games.push(x.games[0]))).toBeNull(); // duplicate ids
    expect(mutate((x) => (x.model.visibleCount = 0))).toBeNull();
    // Unknown theme values fall back rather than fail.
    expect(mutate((x) => (x.appearance.theme = 'neon'))!.appearance.theme).toBe('obsidian');
    // Ids the games list doesn't have are dropped, not shown as holes.
    const dangling = mutate((x) => x.model.recentIds.push('e'.repeat(32)))!;
    expect(dangling.model.recentIds).not.toContain('e'.repeat(32));
  });
});

describe('reading the snapshot', () => {
  afterEach(() => {
    localStorage.clear();
    history.replaceState(null, '', '/');
    delete (window as { chrome?: unknown }).chrome;
    globalThis.__vystralFirstPaint = undefined;
  });

  it('in the browser preview, only with ?firstpaint', () => {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(buildFirstPaint(library(), SETTINGS, NOW)));
    expect(readFirstPaint()).toBeNull();
    history.replaceState(null, '', '/?firstpaint');
    expect(readFirstPaint()?.v).toBe(1);
    localStorage.setItem(PREVIEW_KEY, '{ corrupt');
    expect(readFirstPaint()).toBeNull();
  });

  it('in the app, from the host’s global, once', () => {
    (window as { chrome?: unknown }).chrome = { webview: { postMessage() {}, addEventListener() {} } };
    globalThis.__vystralFirstPaint = JSON.parse(JSON.stringify(buildFirstPaint(library(), SETTINGS, NOW)));
    expect(readFirstPaint()?.v).toBe(1);
    expect(readFirstPaint()).toBeNull();
  });
});
