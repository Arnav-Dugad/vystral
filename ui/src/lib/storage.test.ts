import { describe, expect, it } from 'vitest';
import type { DriveInfo, Game, Installation } from '../bridge/types';
import { bigAndUnplayed, driveKey, driveUsage, gamesOnDrive, GB, unplayedLabel } from './storage';

const NOW = Date.parse('2026-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function inst(over: Partial<Installation>): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: 'D:\\G',
    drive: 'D:', sizeBytes: 20 * GB, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null,
    userLaunchArgs: null, manualLink: false, lastSeen: daysAgo(0), ...over,
  };
}

function game(title: string, installations: Installation[], over: Partial<Game> = {}): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations, collections: [], trackedSeconds: 0, sessionCount: 0,
    lastTrackedPlay: null, added: daysAgo(400), ...over,
  } as Game;
}

describe('storage helpers', () => {
  it('normalizes drive names', () => {
    expect(driveKey('c:\\')).toBe('C:');
    expect(driveKey('D:')).toBe('D:');
    expect(driveKey(null)).toBe('');
  });

  it('lists installed games with a size on one drive, largest first', () => {
    const games = [
      game('A', [inst({ sizeBytes: 5 * GB })]),
      game('B', [inst({ sizeBytes: 50 * GB })]),
      game('C', [inst({ drive: 'C:' })]),
      game('D', [inst({ state: 'missing' })]),
      game('E', [inst({ sizeBytes: null })]),
      game('F', [inst({ state: 'notinstalled', drive: null, installPath: null })]),
    ];
    expect(gamesOnDrive(games, 'd:\\').map((g) => g.game.title)).toEqual(['B', 'A']);
  });

  it('splits drive usage into games, other and free', () => {
    const drive: DriveInfo = { name: 'D:', label: 'Games', totalBytes: 1000, freeBytes: 300, isSystem: false, removable: false };
    const onDrive = gamesOnDrive([game('A', [inst({ sizeBytes: 400 })])], 'D:');
    expect(driveUsage(drive, onDrive)).toEqual({ total: 1000, free: 300, games: 400, other: 300 });
  });

  it('never reports more game bytes than the drive has used', () => {
    const drive: DriveInfo = { name: 'D:', label: '', totalBytes: 1000, freeBytes: 900, isSystem: false, removable: false };
    const onDrive = gamesOnDrive([game('A', [inst({ sizeBytes: 400 })])], 'D:');
    expect(driveUsage(drive, onDrive)).toEqual({ total: 1000, free: 900, games: 100, other: 0 });
  });

  it('suggests big games unplayed for six months or never, largest first', () => {
    const games = [
      game('Recent', [inst({ sizeBytes: 80 * GB, importedLastPlayed: daysAgo(10) })]),
      game('Stale', [inst({ sizeBytes: 30 * GB, importedLastPlayed: daysAgo(400) })]),
      game('Never', [inst({ sizeBytes: 60 * GB })]),
      game('Small', [inst({ sizeBytes: 9 * GB })]),
      game('Tracked', [inst({ sizeBytes: 40 * GB, importedLastPlayed: daysAgo(500) })], { lastTrackedPlay: daysAgo(20) }),
      game('Hidden', [inst({ sizeBytes: 90 * GB })], { hidden: true }),
      game('Gone', [inst({ sizeBytes: 90 * GB, state: 'missing' })]),
      game('Edge', [inst({ sizeBytes: 10 * GB, importedLastPlayed: daysAgo(181) })]),
    ];
    const { items, reclaimable } = bigAndUnplayed(games, NOW);
    expect(items.map((i) => i.game.title)).toEqual(['Never', 'Stale', 'Edge']);
    expect(reclaimable).toBe(100 * GB);
    expect(items[0].daysSincePlayed).toBeNull();
    expect(items[1].daysSincePlayed).toBe(400);
  });

  it('labels how long ago a game was played', () => {
    expect(unplayedLabel({ daysSincePlayed: null })).toBe('Never played');
    expect(unplayedLabel({ daysSincePlayed: 200 })).toBe('Last played 6 months ago');
    expect(unplayedLabel({ daysSincePlayed: 400 })).toBe('Last played over a year ago');
    expect(unplayedLabel({ daysSincePlayed: 800 })).toBe('Last played 2 years ago');
  });
});
