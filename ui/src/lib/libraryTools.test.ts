import { describe, expect, it } from 'vitest';
import type { ControllerCompare, Game, HealthIssue, ModItem, ModSource, SavesLookup, UninstallAdvice } from '../bridge/types';
import {
  advise, basisLine, diffCounts, diffMap, diffSummary, modName, modsTotal, newsCopy, oneTapFix, savesSummary, sortMods, sourceSummary,
} from './libraryTools';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

const issue = (p: Partial<HealthIssue>): HealthIssue => ({
  id: 'x:1', kind: 'brokenShortcut', group: 'launch', severity: 'problem', title: 'Lumen Garden can’t start', detail: 'Moved.', gameId: null, gameIds: [],
  installationId: null, platform: null, platforms: [], path: null, drive: null, sessionId: null, artKind: null, otherGameId: null, fixes: [], ...p,
});

describe('Home: new health issues', () => {
  it('offers a safe one-tap fix, never a pointless rescan for a missing drive', () => {
    expect(oneTapFix(issue({ fixes: [{ action: 'locate', label: 'Locate the program…', safe: false }, { action: 'hide', label: 'Hide it', safe: false }] }))?.action).toBe('locate');
    expect(oneTapFix(issue({ fixes: [{ action: 'hide', label: 'Hide it', safe: false }, { action: 'rescan', label: 'Rescan', safe: true }] }))?.action).toBe('rescan');
    expect(oneTapFix(issue({ kind: 'missingDrive', fixes: [{ action: 'rescan', label: 'Rescan', safe: true }] }))).toBeNull();
    expect(oneTapFix(issue({ fixes: [{ action: 'merge', label: 'Merge', safe: false }] }))).toBeNull();
  });

  it('words the card from the top issue and counts the rest', () => {
    const copy = newsCopy({ issues: [issue({ kind: 'missingDrive', title: 'Drive E: isn’t connected' }), issue({ id: 'b' }), issue({ id: 'c' })], checkedAt: null, reason: 'drive', score: 80 });
    expect(copy).toEqual({ eyebrow: 'A drive was disconnected', title: 'Drive E: isn’t connected', body: 'Moved.', more: '2 more things to look at' });
    expect(newsCopy({ issues: [], checkedAt: null, reason: null, score: 100 })).toBeNull();
    expect(newsCopy({ issues: [issue({ kind: 'longSession', severity: 'warning' })], checkedAt: null, reason: null, score: 90 })?.eyebrow).toBe('Something new to look at');
  });
});

describe('Steam Input compare', () => {
  const cmp: ControllerCompare = {
    status: 'ok', yours: null, default: null, basis: 'progenitor', defaultName: 'Gamepad', unchanged: 9, onlyInYours: [], onlyInDefault: [], note: null,
    differences: [
      { setId: 'InGame', setName: 'On foot', control: 'b', change: 'changed', before: ['Dodge'], after: ['Dodge', 'Hold: Crouch'], modeBefore: null, modeAfter: null },
      { setId: 'InGame', setName: 'On foot', control: 'p1', change: 'added', before: [], after: ['Jump'], modeBefore: null, modeAfter: null },
      { setId: 'InGame', setName: 'On foot', control: 'dpadDown', change: 'removed', before: ['Emote wheel'], after: [], modeBefore: null, modeAfter: null },
      { setId: 'Menu', setName: 'Menus', control: 'a', change: 'changed', before: ['Select'], after: ['Confirm'], modeBefore: null, modeAfter: null },
    ],
  };

  it('maps changes per set, case-insensitively', () => {
    const m = diffMap(cmp, 'ingame');
    expect([...m.entries()]).toEqual([['b', 'changed'], ['p1', 'added'], ['dpadDown', 'removed']]);
    expect(diffMap(cmp, null).get('a')).toBe('changed');
    expect(diffCounts(cmp)).toEqual({ added: 1, removed: 1, changed: 2 });
  });

  it('summarises in plain words', () => {
    expect(diffSummary(cmp, 'InGame')).toBe('3 differences: 1 changed, 1 added, 1 removed.');
    expect(diffSummary(cmp, 'Nowhere')).toBe('No differences in this set.');
    expect(basisLine(cmp)).toContain('started from “Gamepad”');
    expect(basisLine({ ...cmp, basis: 'self' })).toBe('You use Steam’s “Gamepad” template as it is.');
  });
});

describe('Uninstall advisor', () => {
  const game = (p: Partial<Game>): Game => ({
    id: 'g', title: 'Nebula Drift', sortTitle: 'nebula drift', description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false,
    hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [], collections: [], trackedSeconds: 0, sessionCount: 0,
    lastTrackedPlay: null, added: daysAgo(400), ...p,
  });
  const advice = (p: Partial<UninstallAdvice>): UninstallAdvice => ({
    gameId: 'g', installationId: 'i', platform: 'steam', sizeBytes: 20 * 1024 ** 3, sizeSource: 'manifest', drive: 'D:',
    saves: { state: 'steamCloud', files: 3, bytes: 1000, lastSync: null }, services: [], action: 'steamUninstall', actionLabel: 'Open Steam’s uninstall', ...p,
  });

  it('suggests keeping a game you are playing', () => {
    const a = advise(game({ lastTrackedPlay: daysAgo(3), trackedSeconds: 7200 }), advice({}), NOW);
    expect(a.tone).toBe('keep');
    expect(a.reasons[0]).toMatch(/You played it/);
  });

  it('is relaxed about old games with cloud saves, careful with local-only saves and big downloads', () => {
    expect(advise(game({ lastTrackedPlay: daysAgo(400), trackedSeconds: 36000 }), advice({}), NOW).tone).toBe('safe');
    const local = advise(game({ lastTrackedPlay: daysAgo(400) }), advice({ saves: { state: 'localOnly', files: 0, bytes: 0, lastSync: null } }), NOW);
    expect(local.tone).toBe('think');
    expect(local.reasons.join(' ')).toContain('Files tab');
    const big = advise(game({ lastTrackedPlay: daysAgo(90) }), advice({ sizeBytes: 120 * 1024 ** 3 }), NOW);
    expect(big.tone).toBe('think');
    expect(big.reasons.join(' ')).toContain('can take a while');
  });

  it('mentions a subscription that lists it, and never-played games', () => {
    const a = advise(game({}), advice({ services: [{ service: 'gfn', name: 'GeForce NOW', note: 'Stream it instead.' }] }), NOW);
    expect(a.reasons).toContain('You haven’t played it yet.');
    expect(a.reasons).toContain('Stream it instead.');
  });
});

describe('Files tab', () => {
  it('summarises save locations honestly', () => {
    const base: SavesLookup = { gameId: 'g', status: 'ok', message: null, article: 'X', locations: [], fetched: null, stale: false };
    const loc = (p: Partial<SavesLookup['locations'][number]>) => ({
      id: 's0', platform: 'windows' as const, raw: 'r', display: 'd', path: 'p', exists: false, isFile: false, bytes: null, files: 0, modified: null, partial: false, problem: null, ...p,
    });
    expect(savesSummary(base)).toMatch(/doesn’t list/);
    expect(savesSummary({ ...base, locations: [loc({}), loc({ problem: 'unsupported' })] })).toMatch(/None of the listed places/);
    expect(savesSummary({ ...base, locations: [loc({ exists: true, bytes: 2048 }), loc({}), loc({ problem: 'unsupported' })] })).toBe('Found in 1 of 2 places · 2.0 KB');
  });

  it('sorts mods and prefers Workshop titles', () => {
    const items: ModItem[] = [
      { id: '1', name: '1', title: 'Zebra Roads', bytes: 10, updated: daysAgo(1), enabled: null, present: true },
      { id: '2', name: 'alpha', title: null, bytes: 30, updated: daysAgo(9), enabled: true, present: true },
      { id: '3', name: 'Mod 10', title: null, bytes: null, updated: null, enabled: false, present: false },
      { id: '4', name: 'Mod 9', title: null, bytes: 20, updated: daysAgo(3), enabled: true, present: true },
    ];
    expect(sortMods(items, 'name').map(modName)).toEqual(['alpha', 'Mod 9', 'Mod 10', 'Zebra Roads']);
    expect(sortMods(items, 'size').map((i) => i.id)).toEqual(['2', '4', '1', '3']);
    expect(sortMods(items, 'updated').map((i) => i.id)).toEqual(['1', '4', '2', '3']);
    const src: ModSource = { id: 'mo2-0', kind: 'mo2', label: 'Mod Organizer 2', detail: null, folder: 'f', bytes: 3 * 1024 ** 2, count: 4, partial: true, items };
    expect(sourceSummary(src)).toBe('4 mods · at least 3.0 MB · 2 on');
    expect(modsTotal([src, { ...src, count: 1, bytes: 1024 ** 2 }])).toEqual({ count: 5, bytes: 4 * 1024 ** 2 });
  });
});
