import type { DriveInfo, Game, Installation, PlatformKey } from '../bridge/types';
import { lastPlayed } from './format';

export const GB = 1024 ** 3;
export const BIG_GAME_BYTES = 10 * GB;
export const UNPLAYED_DAYS = 180;

export interface DriveGame {
  game: Game;
  installation: Installation;
  sizeBytes: number;
  platform: PlatformKey;
}

/** Normalizes "C:", "c:\\", "C:\\" to "C:". */
export const driveKey = (name: string | null | undefined) => (name ?? '').replace(/[\\/]+$/, '').toUpperCase();

/** Installed installations with a known size on one drive, largest first. */
export function gamesOnDrive(games: readonly Game[], drive: string): DriveGame[] {
  const key = driveKey(drive);
  const out: DriveGame[] = [];
  for (const game of games) {
    for (const inst of game.installations) {
      if (inst.state !== 'installed' || !inst.sizeBytes || inst.sizeBytes <= 0 || driveKey(inst.drive) !== key) continue;
      out.push({ game, installation: inst, sizeBytes: inst.sizeBytes, platform: inst.platform });
    }
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes || a.game.sortTitle.localeCompare(b.game.sortTitle));
}

export interface DriveUsage {
  total: number;
  free: number;
  games: number;
  other: number;
}

/** Splits a drive into space used by games VYSTRAL knows about, everything else, and free space. */
export function driveUsage(drive: DriveInfo, onDrive: readonly DriveGame[]): DriveUsage {
  const total = Math.max(0, drive.totalBytes);
  const free = Math.min(total, Math.max(0, drive.freeBytes));
  const used = total - free;
  const games = Math.min(used, onDrive.reduce((s, g) => s + g.sizeBytes, 0));
  return { total, free, games, other: Math.max(0, used - games) };
}

export interface Suggestion extends DriveGame {
  lastPlayedAt: string | null;
  daysSincePlayed: number | null;
}

/**
 * "Big and unplayed": installed copies of at least 10 GB, last played more than 180 days ago or
 * never (by VYSTRAL's own sessions or the store's records), largest first.
 */
export function bigAndUnplayed(games: readonly Game[], now = Date.now()): { items: Suggestion[]; reclaimable: number } {
  const items: Suggestion[] = [];
  for (const game of games) {
    if (game.hidden) continue;
    const lp = lastPlayed(game).at;
    const t = lp ? Date.parse(lp) : NaN;
    const days = Number.isNaN(t) ? null : Math.floor((now - t) / 86_400_000);
    if (days != null && days <= UNPLAYED_DAYS) continue;
    for (const inst of game.installations) {
      if (inst.state !== 'installed' || !inst.sizeBytes || inst.sizeBytes < BIG_GAME_BYTES) continue;
      items.push({ game, installation: inst, sizeBytes: inst.sizeBytes, platform: inst.platform, lastPlayedAt: lp, daysSincePlayed: days });
    }
  }
  items.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { items, reclaimable: items.reduce((s, i) => s + i.sizeBytes, 0) };
}

/** Plain-language "last played" for suggestions. */
export function unplayedLabel(s: Pick<Suggestion, 'daysSincePlayed'>): string {
  if (s.daysSincePlayed == null) return 'Never played';
  const months = Math.floor(s.daysSincePlayed / 30);
  if (months >= 24) return `Last played ${Math.floor(months / 12)} years ago`;
  if (months >= 12) return 'Last played over a year ago';
  return `Last played ${months} months ago`;
}
