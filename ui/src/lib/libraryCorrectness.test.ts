import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { byLastPlayed, lastPlayed, newestFirst } from './format';
import { buildHomeModel } from './homeModel';
import { homeRows } from '../views/immersive/rows';
import { featuredGame } from './recommend';
import { bigAndUnplayed, gamesOnDrive } from './storage';
import { ownershipToast } from '../state/ownership';
import { derivePlayState, familyLabels, installSource } from '../components/game/playState';

/** Track C1: last-played comparisons, Continue playing keeps the hero's game, refunds, Xbox estimates. */

const NOW = Date.parse('2026-10-10T12:00:00Z');

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

describe('last played compares instants, not strings', () => {
  // 23:30 at UTC-05:00 is 04:30Z the next day: newer, though its string sorts lower.
  const offset = '2026-10-09T23:30:00-05:00';
  const utc = '2026-10-10T01:00:00+00:00';

  it('picks the later instant across offsets', () => {
    const g = game('Forza', { lastTrackedPlay: utc }, [inst({ importedLastPlayed: offset })]);
    expect(lastPlayed(g)).toEqual({ at: offset, source: 'imported' });
  });

  it('sorts most recent first, never-played last, and ignores unreadable dates', () => {
    const a = game('A', { lastTrackedPlay: utc });
    const b = game('B', { lastTrackedPlay: offset });
    const never = game('Never');
    const junk = game('Junk', { lastTrackedPlay: 'not a date' });
    expect([never, a, junk, b].sort(byLastPlayed).map((g) => g.title).slice(0, 2)).toEqual(['B', 'A']);
    expect(lastPlayed(junk)).toEqual({ at: null, source: null });
    expect(newestFirst(NaN, NaN)).toBe(0);
    expect(newestFirst(NaN, 5)).toBe(1);
  });

  it('the Home hero is the latest instant too', () => {
    const lib = [game('UTC', { lastTrackedPlay: utc }), game('Offset', { lastTrackedPlay: offset })];
    expect(featuredGame(lib)?.title).toBe('Offset');
  });
});

describe('estimated last played (save data)', () => {
  const estimate = (at: string) => inst({ platform: 'xbox', launchKind: 'PackagedApp', clientRequired: false, importedLastPlayed: at, lastPlayedSource: 'saveData' });

  it('is labelled as an estimate', () => {
    const g = game('Coastline', {}, [estimate('2026-10-09T21:15:00Z')]);
    expect(lastPlayed(g)).toEqual({ at: '2026-10-09T21:15:00Z', source: 'estimated' });
  });

  it("doesn't replace a session VYSTRAL tracked the day before it", () => {
    const g = game('Forza', { lastTrackedPlay: '2026-10-09T19:00:00Z' }, [estimate('2026-10-09T21:15:00Z')]);
    expect(lastPlayed(g)).toEqual({ at: '2026-10-09T19:00:00Z', source: 'tracked' });
    const later = game('Forza', { lastTrackedPlay: '2026-10-01T19:00:00Z' }, [estimate('2026-10-09T21:15:00Z')]);
    expect(lastPlayed(later).source).toBe('estimated');
  });

  it('counts for Storage Studio suggestions like any other date', () => {
    const big = estimate('2026-10-09T21:15:00Z');
    big.sizeBytes = 80 * 1024 ** 3;
    big.drive = 'C:';
    const g = game('Coastline', {}, [big]);
    expect(gamesOnDrive([g], 'C:\\')).toHaveLength(1);
    expect(bigAndUnplayed([g], NOW).items).toHaveLength(0); // played yesterday (estimated): not "unplayed"
  });
});

describe('Continue playing keeps the game in the hero', () => {
  const lib = () => [
    game('Forza Horizon 4', { lastTrackedPlay: '2026-10-09T19:00:00Z' }, [inst({ platform: 'xbox', launchKind: 'PackagedApp' })]),
    game('Older', { lastTrackedPlay: '2026-10-02T19:00:00Z' }),
    game('Not installed', { lastTrackedPlay: '2026-10-08T19:00:00Z' }, [inst({ state: 'notinstalled' })]),
  ];

  it('on Home, as the first card', () => {
    const m = buildHomeModel(lib(), NOW);
    expect(m.featuredId).toBe('Forza Horizon 4');
    expect(m.continueIds).toEqual(['Forza Horizon 4', 'Older']);
  });

  it('in Immersive, as the first tile', () => {
    const rows = homeRows(lib(), [], NOW, 20);
    const cont = rows.find((r) => r.id === 'continue')!;
    expect(cont.tiles.map((t) => (t as { game: Game }).game.title)).toEqual(['Forza Horizon 4', 'Older']);
  });
});

describe('games no longer in the Steam library', () => {
  const gone = (over: Partial<Installation> = {}) => inst({ state: 'notinstalled', platformGameId: '400', noLongerOwned: '2026-10-10T10:00:00Z', ...over });

  it("aren't offered for install, and say why", () => {
    const g = game('Portal', { hidden: true, notOwned: true }, [gone()]);
    expect(installSource(g)).toBeNull();
    const s = derivePlayState({ game: g, launch: null, install: undefined, now: NOW });
    expect(s).toMatchObject({ kind: 'unavailable', label: 'Not owned', actionable: false });
    expect(familyLabels(g, 'notInstalled')[0].label).toBe('Not owned');
  });

  it('a game also on Epic installs from Epic instead', () => {
    const g = game('Copperline', {}, [gone(), inst({ platform: 'epic', platformGameId: 'Copper', state: 'notinstalled' })]);
    expect(installSource(g)).toMatchObject({ steam: false, inst: { platform: 'epic' } });
  });

  it('are told about once, in plain words', () => {
    const one = ownershipToast(1, () => {});
    expect(one.title).toBe('1 game is no longer in your Steam library');
    expect(one.action.label).toBe('Show it');
    const two = ownershipToast(2, () => {});
    expect(two.title).toBe('2 games are no longer in your Steam library');
    expect(two.body).toMatch(/refunded or removed/i);
    expect(two.body).toMatch(/kept/);
    expect(two.tone).toBe('info');
  });

  it('stay out of Home like hidden games', () => {
    const g = game('Portal', { hidden: true, notOwned: true, lastTrackedPlay: '2026-10-09T19:00:00Z' }, [gone()]);
    const visible = [g, game('Older', { lastTrackedPlay: '2026-10-02T19:00:00Z' })].filter((x) => !x.hidden);
    expect(buildHomeModel(visible, NOW).continueIds).toEqual(['Older']);
  });
});
