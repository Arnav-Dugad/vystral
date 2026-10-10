import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import {
  buildTasteProfile, diversify, engagementOf, explain, featuresOf, mergeCandidates, recommendDiscover, recommendLibrary, recommendV2,
  scoreLibraryGame, seriesKey, similarity, spanAdjective, spanWords, tasteMatch, timeWindow, TASTE_HALF_LIFE_DAYS,
  type DiscoverCandidate, type DismissedItem, type RecSignals, type SessionLite,
} from './recommendV2';

const DAY = 86_400_000;
// A Friday, 20:00 UTC; tests pin the time zone offset to UTC.
const NOW = Date.parse('2026-10-09T20:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
let seq = 0;

function inst(p: Partial<Installation> = {}): Installation {
  return {
    id: `i${seq++}`, platform: 'steam', platformGameId: String(seq), title: 't', state: 'installed', installPath: null, drive: 'D:', sizeBytes: null,
    clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null, userLaunchArgs: null, manualLink: false, lastSeen: '', ...p,
  };
}

function game(title: string, p: Partial<Game> = {}, installs: Installation[] = [inst()]): Game {
  const id = (title.toLowerCase().replace(/[^a-z0-9]/g, '') + '0'.repeat(32)).slice(0, 32).replace(/[^0-9a-f]/g, 'a');
  return {
    id, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false,
    hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: installs, collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: ago(400), ...p,
  };
}

const played = (hours: number, daysAgo: number): Partial<Game> => ({ trackedSeconds: hours * 3600, sessionCount: 3, lastTrackedPlay: ago(daysAgo) });
const sig = (extra: Partial<RecSignals> = {}): RecSignals => ({ now: NOW, tzOffsetMinutes: 0, ...extra });

describe('features', () => {
  it('finds a series across sequels, remasters and subtitles, but never on short or generic names', () => {
    expect(seriesKey('Kingsfall')).toBe('kingsfall');
    expect(seriesKey('Kingsfall Remastered')).toBe('kingsfall');
    expect(seriesKey('Kingsfall II: Ashes of the Crown')).toBe('kingsfall');
    expect(seriesKey('The Witcher 3: Wild Hunt')).toBe('witcher');
    expect(seriesKey('Forza Horizon 5 Premium Edition')).toBe('forza horizon');
    expect(seriesKey('F1 22')).toBeNull();
    expect(seriesKey('The')).toBeNull();
  });

  it('treats a genre and a tag with the same name as one feature, and weak tags lightly', () => {
    const f = featuresOf({ title: 'Nebula Drift', genres: ['Racing'], tags: ['Racing', 'Singleplayer', 'Open World'] });
    expect(f.w.get('k:racing')).toBe(1);
    expect(f.w.get('k:singleplayer')!).toBeLessThan(0.5);
    expect(f.w.get('k:open world')!).toBeGreaterThan(0.8);
    expect(f.labels.get('k:open world')).toBe('Open World');
    expect(f.w.has('s:nebula drift')).toBe(true);
  });

  it('similarity is high for shared features and total for the same series', () => {
    const a = [...featuresOf({ title: 'A Game', genres: ['Racing', 'Sports'] }).w.keys()];
    const b = [...featuresOf({ title: 'B Game', genres: ['Racing', 'Sports'] }).w.keys()];
    const c = [...featuresOf({ title: 'C Game', genres: ['Puzzle'] }).w.keys()];
    expect(similarity(a, b)).toBeGreaterThan(0.4);
    expect(similarity(a, c)).toBe(0);
    expect(similarity(['s:kingsfall', 'k:rpg'], ['s:kingsfall', 'k:puzzle'])).toBe(1);
  });
});

describe('taste profile', () => {
  it('weights hours with diminishing returns and decays with time since you last played', () => {
    const recent = engagementOf(game('A', played(20, 1)), NOW);
    const old = engagementOf(game('B', played(20, TASTE_HALF_LIFE_DAYS)), NOW);
    const huge = engagementOf(game('C', played(400, 1)), NOW);
    expect(old).toBeLessThan(recent * 0.75);
    expect(old).toBeGreaterThan(recent * 0.5); // the 30% floor: old loves still count
    expect(huge).toBeLessThan(recent * 2.2); // 20× the hours is not 20× the weight
    expect(engagementOf(game('Never'), NOW)).toBe(0);
  });

  it('favourites and high ratings add; abandoning or rating low push away', () => {
    const base = engagementOf(game('A', played(10, 10)), NOW);
    expect(engagementOf(game('A', { ...played(10, 10), favorite: true }), NOW)).toBeGreaterThan(base + 1);
    expect(engagementOf(game('A', { ...played(10, 10), userRating: 5 }), NOW)).toBeGreaterThan(base);
    expect(engagementOf(game('A', { ...played(10, 10), userRating: 1 }), NOW)).toBeLessThan(0);
    expect(engagementOf(game('A', { ...played(10, 10), status: 'abandoned' }), NOW)).toBeLessThan(0);
  });

  it('builds normalised affinities, learns from "Not interested", and reads your rhythm', () => {
    const lib = [
      game('Racer One', { genres: ['Racing'], ...played(50, 3) }),
      game('Puzzle One', { genres: ['Puzzle'], ...played(3, 30) }),
      game('Dropped', { genres: ['Horror'], ...played(2, 30), status: 'abandoned' }),
    ];
    const sessions: SessionLite[] = [
      { gameId: 'x', start: '2026-10-02T19:00:00Z', durationSeconds: 7200 },
      { gameId: 'x', start: '2026-09-25T20:00:00Z', durationSeconds: 5400 },
      { gameId: 'x', start: '2026-09-18T21:00:00Z', durationSeconds: 9000 },
      { gameId: 'x', start: '2026-10-06T12:00:00Z', durationSeconds: 120 }, // under five minutes: ignored
    ];
    const p = buildTasteProfile(lib, sig({ sessions }));
    expect(p.affinity.get('k:racing')).toBe(1);
    expect(p.affinity.get('k:puzzle')!).toBeGreaterThan(0);
    expect(p.affinity.get('k:horror')!).toBeLessThan(0);
    expect(p.typicalSessionSeconds).toBe(7200);
    expect(p.sessionSamples).toBe(3);
    expect(p.rhythm.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(p.rhythm[5 * 24 + 19]).toBeGreaterThan(0); // Friday 19:00 local (UTC here)

    const dismissed: DismissedItem[] = [{ key: 'discover:steam-1', title: 'Another Puzzle', features: ['k:puzzle'], at: ago(1) }];
    const after = buildTasteProfile(lib, sig({ dismissed }));
    expect(after.affinity.get('k:puzzle')!).toBeLessThan(p.affinity.get('k:puzzle')!);
  });
});

describe('time you usually have', () => {
  const friday = (week: number, hour: number, minutes: number): SessionLite => ({
    gameId: 'x', start: new Date(Date.parse('2026-10-02T00:00:00Z') - week * 7 * DAY + hour * 3600_000).toISOString(), durationSeconds: minutes * 60,
  });

  it('prefers the same weekday at about this hour, then the same kind of day, then any day', () => {
    const sessions = [friday(0, 20, 120), friday(1, 19, 150), friday(2, 21, 90), friday(0, 9, 30)];
    const w = timeWindow({ now: NOW, sessions, tzOffsetMinutes: 0 })!;
    expect(w.label).toBe('Friday evenings');
    expect(w.seconds).toBe(120 * 60);
    // Other weekdays only → "weekday evenings".
    const weekdays = [0, 1, 2].map((i) => ({ gameId: 'x', start: `2026-09-2${2 + i}T20:00:00Z`, durationSeconds: 3600 }));
    expect(timeWindow({ now: NOW, sessions: weekdays, tzOffsetMinutes: 0 })!.label).toBe('weekday evenings');
    expect(timeWindow({ now: NOW, sessions: weekdays.slice(0, 2), tzOffsetMinutes: 0 })).toBeNull();
  });

  it('says spans in plain words', () => {
    expect(spanWords(25 * 60)).toBe('25 minutes');
    expect(spanWords(3600)).toBe('about an hour');
    expect(spanWords(2 * 3600)).toBe('about 2 hours');
    expect(spanWords(2.5 * 3600)).toBe('about 2½ hours');
    expect(spanAdjective(90 * 60)).toBe('1½-hour');
    expect(spanAdjective(40 * 60)).toBe('40-minute');
  });
});

describe('library picks', () => {
  const lib = () => [
    game('Racer One', { genres: ['Racing'], ...played(60, 1) }),
    game('Racer Two', { genres: ['Racing'] }),
    game('Cozy Farm', { genres: ['Simulation'] }),
    game('Old Love', { genres: ['RPG'], ...played(30, 120) }),
    game('Mid Run', { genres: ['Racing', 'Open World'], ...played(6, 6), status: 'playing' }),
    game('Done', { genres: ['Racing'], ...played(20, 40), status: 'completed' }),
    game('Quit', { genres: ['Racing'], ...played(1, 40), status: 'abandoned' }),
    game('Hidden Racer', { genres: ['Racing'], hidden: true }),
    game('Streamable', { genres: ['Racing'] }, [inst({ state: 'notinstalled' })]),
  ];

  it('never suggests hidden, abandoned, finished (unless a favourite), dismissed, or what you played in the last two days', () => {
    const games = lib();
    const dismissed: DismissedItem[] = [{ key: `game:${games[2].id}`, title: 'Cozy Farm', features: [], at: ago(1) }];
    const s = sig({ dismissed });
    const ids = recommendLibrary(games, buildTasteProfile(games, s), s, { limit: 20 }).map((r) => r.title);
    for (const t of ['Racer One', 'Done', 'Quit', 'Hidden Racer', 'Cozy Farm']) expect(ids).not.toContain(t);
    expect(ids).toContain('Racer Two');
    const fav = [...games, game('Loved And Done', { genres: ['Racing'], ...played(20, 40), status: 'completed', favorite: true })];
    expect(recommendLibrary(fav, buildTasteProfile(fav, s), s, { limit: 20 }).map((r) => r.title)).toContain('Loved And Done');
  });

  it('ranks what fits your taste above what does not, and explains it', () => {
    const games = lib();
    const s = sig();
    const picks = recommendLibrary(games, buildTasteProfile(games, s), s, { limit: 20, diversify: false });
    const titles = picks.map((p) => p.title);
    expect(titles.indexOf('Racer Two')).toBeLessThan(titles.indexOf('Cozy Farm'));
    expect(picks.find((p) => p.title === 'Racer Two')!.reason).toMatch(/Never played.*Racing/);
    expect(picks.find((p) => p.title === 'Mid Run')!.reason).toMatch(/^Pick up where you left off 6 days ago/);
    expect(picks.find((p) => p.title === 'Old Love')!.reason).toMatch(/^Last played 4 months ago, after 30 hours/);
  });

  it('a game never recommends itself: its own series and hours are taken out of its match', () => {
    const games = [game('Solo Epic', { genres: ['RPG'], ...played(80, 60) }), game('Other', { genres: ['Puzzle'] })];
    const s = sig();
    const r = scoreLibraryGame(games[0], buildTasteProfile(games, s), s, null)!;
    expect(r.match).toBeCloseTo(0, 5);
    expect(r.reason).not.toMatch(/Solo Epic/);
  });

  it('mode "installed" and mode "cloud" pick the right games', () => {
    const games = lib();
    const cloud = { [games[8].id]: [{ service: 'gfn', match: 'store' }] };
    const s = sig({ cloud });
    const p = buildTasteProfile(games, s);
    expect(recommendLibrary(games, p, s, { mode: 'cloud' }).map((r) => r.title)).toEqual(['Streamable']);
    expect(recommendLibrary(games, p, s, { mode: 'cloud' })[0].reasons.map((r) => r.code)).toContain('cloud');
    expect(recommendLibrary(games, p, s, { mode: 'installed' }).map((r) => r.title)).not.toContain('Streamable');
    expect(recommendLibrary(games, p, sig(), { mode: 'cloud' })).toEqual([]);
  });

  it('time to beat against your usual evening: "finish it tonight" and "a few sessions"', () => {
    const short = game('Short Story', { genres: ['Adventure'] });
    const medium = game('Medium Quest', { genres: ['Adventure'] });
    const games = [short, medium, game('Seed', { genres: ['Adventure'], ...played(10, 30) })];
    const sessions = [0, 1, 2].map((w) => ({ gameId: 'x', start: new Date(NOW - w * 7 * DAY - 3600_000).toISOString(), durationSeconds: 2 * 3600 }));
    const s = sig({ sessions, ttb: { [short.id]: { main: 1.5 * 3600 }, [medium.id]: { main: 7 * 3600 } } });
    const p = buildTasteProfile(games, s);
    const r = recommendLibrary(games, p, s, { limit: 5, diversify: false });
    const shortPick = r.find((x) => x.title === 'Short Story')!;
    expect(shortPick.reasons.map((x) => x.code)).toContain('finishTonight');
    expect(shortPick.reason).toBe('Never played, waiting 1 year · short enough to finish in your usual 2 hours on Friday evenings');
    expect(r.find((x) => x.title === 'Medium Quest')!.reasons.find((x) => x.code === 'timeFit')!.text).toBe('About 4 of your usual 2-hour sessions to finish');
  });

  it('friends playing and missing disk space show up in the reason', () => {
    const big = game('Huge Game', { genres: ['Racing'] }, [inst({ state: 'notinstalled', sizeBytes: 150e9 })]);
    const pal = game('Pal Game', { genres: ['Racing'] });
    const games = [game('Seed', { genres: ['Racing'], ...played(20, 30) }), big, pal];
    const s = sig({ freeBytes: { 'C:': 40e9, 'D:': 90e9 }, friendsPlaying: { [pal.id]: 2 } });
    const p = buildTasteProfile(games, s);
    const r = recommendLibrary(games, p, s, { limit: 5, diversify: false });
    expect(r.find((x) => x.title === 'Pal Game')!.reason).toMatch(/2 friends are playing it right now/);
    expect(r.find((x) => x.title === 'Huge Game')!.reason).toMatch(/needs more free space than any drive has$/);
    expect(r.findIndex((x) => x.title === 'Huge Game')).toBeGreaterThan(r.findIndex((x) => x.title === 'Pal Game'));
  });

  it('is deterministic within a day, and fast on a big library', () => {
    const games = Array.from({ length: 5000 }, (_, i) => game(`Game ${i} ${['Alpha', 'Beta', 'Gamma'][i % 3]}`, {
      genres: [['Racing', 'RPG', 'Puzzle', 'Strategy'][i % 4]], ...(i % 7 === 0 ? played(i % 50, i % 200 + 3) : {}),
    }));
    const s = sig();
    const t0 = performance.now();
    const a = recommendLibrary(games, buildTasteProfile(games, s), s, { limit: 15 });
    const ms = performance.now() - t0;
    const b = recommendLibrary(games, buildTasteProfile(games, sig({ now: NOW + 3600_000 })), sig({ now: NOW + 3600_000 }), { limit: 15 });
    expect(a.map((r) => r.id)).toEqual(b.map((r) => r.id));
    expect(ms).toBeLessThan(1500);
  });
});

describe('discover picks', () => {
  const lib = [
    game('Ashen Crown', { genres: ['RPG', 'Fantasy'], ...played(40, 5) }),
    game('Nebula Drift', { genres: ['Racing'], ...played(2, 200) }),
  ];
  const s = sig();
  const profile = buildTasteProfile(lib, s);
  const byId = new Map(lib.map((g) => [g.id, g]));
  const c = (key: string, title: string, genres: string[], extra: Partial<DiscoverCandidate> = {}): DiscoverCandidate => ({ key, title, genres, via: ['store'], ...extra });

  it('ranks by taste and source signals, never owned or dismissed games, and explains each pick', () => {
    const candidates = [
      c('steam-1', 'Crown of Cinders', ['RPG', 'Fantasy'], { via: ['because'], seedGameId: lib[0].id }),
      c('steam-2', 'Kart Party', ['Racing']),
      c('steam-3', 'Tile Sorter', ['Puzzle']),
      c('steam-4', 'Owned Already', ['RPG'], { libraryGameId: lib[0].id }),
      c('steam-5', 'Dismissed RPG', ['RPG']),
      c('steam-6', 'Wishful', ['Puzzle'], { via: ['wishlist'] }),
      c('steam-7', 'In The Plan', ['Puzzle'], { planName: 'Game Pass Ultimate' }),
    ];
    const dismissed: DismissedItem[] = [{ key: 'discover:steam-5', title: 'Dismissed RPG', features: [], at: ago(1) }];
    const picks = recommendDiscover(candidates, profile, sig({ dismissed }), { games: byId, diversify: false });
    const titles = picks.map((p) => p.title);
    expect(titles[0]).toBe('Crown of Cinders');
    expect(titles).not.toContain('Owned Already');
    expect(titles).not.toContain('Dismissed RPG');
    expect(titles.indexOf('Wishful')).toBeLessThan(titles.indexOf('Tile Sorter'));
    expect(picks[0].reason.startsWith('Like Ashen Crown, which you played for 40 hours')).toBe(true);
    expect(picks.find((p) => p.title === 'Wishful')!.reason).toMatch(/^On your wishlist/);
    expect(picks.find((p) => p.title === 'In The Plan')!.reason).toMatch(/^Included with Game Pass Ultimate/);
    expect(picks[0].dismissKey).toBe('discover:steam-1');
  });

  it('merges the same game seen from several sources', () => {
    const merged = mergeCandidates([
      c('steam-9', 'Echo', [], { via: ['wishlist'] }),
      c('steam-9', 'Echo', ['Adventure'], { via: ['because'], seedGameId: 'x', discountPercent: 40 }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].via).toEqual(['wishlist', 'because']);
    expect(merged[0].genres).toEqual(['Adventure']);
    expect(merged[0].discountPercent).toBe(40);
  });

  it('coming-soon games sink; free giveaways say where and until when', () => {
    const picks = recommendDiscover([
      c('steam-10', 'Later', ['RPG'], { comingSoon: true }),
      c('steam-11', 'Now', ['RPG']),
      c('free:12', 'Gift', [], { via: ['free'], freeOn: 'Epic Games Store', freeUntil: '2026-10-15T15:00:00Z' }),
    ], profile, s, { diversify: false });
    expect(picks.map((p) => p.title).indexOf('Later')).toBeGreaterThan(picks.map((p) => p.title).indexOf('Now'));
    const gift = picks.find((p) => p.title === 'Gift')!;
    expect(gift.reason).toMatch(/^Free to keep on Epic Games Store until /);
    expect(gift.dismissKey).toBe('free:12');
  });
});

describe('diversity and explanations', () => {
  it('MMR keeps the best first but stops one series filling the row', () => {
    const item = (id: string, score: number, features: string[]) => ({ id, score, features });
    const sorted = [
      item('k1', 10, ['s:kingsfall', 'k:strategy']),
      item('k2', 9.9, ['s:kingsfall', 'k:strategy']),
      item('k3', 9.8, ['s:kingsfall', 'k:strategy']),
      item('r1', 9, ['k:racing']),
      item('p1', 8.5, ['k:puzzle']),
    ];
    const top3 = diversify(sorted, 3).map((x) => x.id);
    expect(top3[0]).toBe('k1');
    expect(top3).toContain('r1');
    expect(top3.filter((x) => x.startsWith('k')).length).toBeLessThan(3);
    expect(diversify(sorted, 1)).toEqual([sorted[0]]);
    expect(diversify([], 5)).toEqual([]);
  });

  it('builds one plain sentence, mentions a catch, and has honest fallbacks', () => {
    expect(explain([{ code: 'taste', text: 'You love Racing', weight: 1.4 }, { code: 'unplayed', text: 'Never played, waiting 2 years', weight: 0.5 }], { kind: 'library', never: true }))
      .toBe('Never played, waiting 2 years, and you love Racing');
    expect(explain([{ code: 'seed', text: 'Like Ashen Crown', weight: 0.5 }, { code: 'taste', text: 'You love RPG', weight: 1.6 }, { code: 'sale', text: '50% off right now', weight: 0.25 }], { kind: 'discover', never: false }))
      .toBe('Like Ashen Crown · 50% off right now');
    expect(explain([{ code: 'taste', text: 'You love Racing', weight: 1.4 }, { code: 'installed', text: 'Installed and ready', weight: 0.2 }, { code: 'noSpace', text: 'Needs more free space than any drive has', weight: -0.4 }], { kind: 'library', never: false }))
      .toBe('You love Racing · installed and ready · needs more free space than any drive has');
    expect(explain([], { kind: 'library', never: true })).toBe('Never played yet');
    expect(explain([], { kind: 'discover', never: false })).toBe('Something new to try');
  });

  it('exposes one module object for other features (the assistant)', () => {
    expect(recommendV2.version).toBe(2);
    expect(typeof recommendV2.recommendLibrary).toBe('function');
    expect(tasteMatch(featuresOf({ title: 'X', genres: [] }), buildTasteProfile([], sig())).match).toBe(0);
  });
});
