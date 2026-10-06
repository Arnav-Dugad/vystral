import type { DiskForecast, DriveForecast, Game, PendingUpdate } from '../bridge/types';
import { formatBytes } from './format';

/** Track P: the pending update for one game, with the drive it's on (null when nothing is pending). */
export function updateForGame(f: DiskForecast | null, gameId: string): { update: PendingUpdate; drive: DriveForecast } | null {
  for (const drive of f?.drives ?? []) {
    const update = drive.updates.find((u) => u.gameId === gameId);
    if (update) return { update, drive };
  }
  return null;
}

/** "Next update needs 23.4 GB · 9.1 GB free on D:" (or the install / unknown-size variants). */
export function chipText(u: PendingUpdate, d: DriveForecast): string {
  const what = u.kind === 'install' ? 'Install' : 'Next update';
  const free = `${formatBytes(d.freeBytes)} free on ${d.drive}`;
  if (u.needBytes == null) return `${what} pending · ${free}`;
  if (u.needBytes === 0) return `${what} is finishing · ${free}`;
  return `${what} needs ${formatBytes(u.needBytes)} · ${free}`;
}

/** Plain-language fit, for screen readers and tooltips. */
export function fitSentence(u: PendingUpdate, d: DriveForecast): string {
  switch (u.fit) {
    case 'short':
      return `It won’t fit: ${d.drive} needs about ${formatBytes((u.needBytes ?? 0) - d.freeBytes)} more free space.`;
    case 'tight':
      return `It fits, but leaves ${d.drive} with only ${formatBytes(d.freeBytes - (u.needBytes ?? 0))} free.`;
    case 'unknown':
      return 'Steam hasn’t worked out how big it is yet.';
    default:
      return `It fits, leaving ${formatBytes(d.freeBytes - (u.needBytes ?? 0))} free.`;
  }
}

/** Drives that need attention, worst first. */
export function warningDrives(f: DiskForecast | null): DriveForecast[] {
  const rank = (s: DriveForecast['status']) => (s === 'short' ? 2 : s === 'tight' ? 1 : 0);
  return (f?.drives ?? []).filter((d) => d.status !== 'ok').sort((a, b) => rank(b.status) - rank(a.status));
}

const titleOf = (u: PendingUpdate, gamesById: Map<string, Game>) => (u.gameId ? gamesById.get(u.gameId)?.title : undefined) ?? u.name;

/** Headline and body for the Home warning about one drive. */
export function warningCopy(d: DriveForecast, gamesById: Map<string, Game>): { title: string; body: string } {
  const known = d.updates.filter((u) => u.needBytes != null && u.needBytes > 0);
  const lead = known[0] ?? d.updates[0];
  const name = lead ? titleOf(lead, gamesById) : 'A game';
  if (d.status === 'short') {
    const missing = formatBytes(-d.afterBytes);
    return known.length <= 1
      ? { title: `${name}’s next update won’t fit on ${d.drive}`, body: `It needs ${formatBytes(d.needBytes)} and ${d.drive} has ${formatBytes(d.freeBytes)} free. Free up about ${missing} before Steam starts it.` }
      : { title: `${known.length} updates won’t fit on ${d.drive}`, body: `Together they need ${formatBytes(d.needBytes)} and ${d.drive} has ${formatBytes(d.freeBytes)} free. Free up about ${missing} before Steam starts them.` };
  }
  const pct = d.totalBytes > 0 ? Math.max(0, d.afterBytes / d.totalBytes) : 0;
  return {
    title: `${d.drive} will be nearly full after ${known.length <= 1 ? `${name}’s update` : `${known.length} updates`}`,
    body: `${known.length <= 1 ? 'It needs' : 'They need'} ${formatBytes(d.needBytes)}, leaving ${formatBytes(Math.max(0, d.afterBytes))} free (${pct < 0.01 ? 'under 1' : Math.round(pct * 100)}% of the drive).`,
  };
}

/** A stable key for "dismissed this warning": the same drives with the same updates in the same state. */
export function warningKey(drives: DriveForecast[]): string {
  return drives.map((d) => `${d.drive}:${d.status}:${d.updates.map((u) => u.appId).sort().join(',')}`).join('|');
}

export interface BarSegment {
  key: string;
  kind: 'update' | 'over' | 'free';
  /** Share of the bar, 0–1. */
  fraction: number;
  label: string;
  update?: PendingUpdate;
}

/**
 * The stacked bar for one drive, zoomed to the space that matters: today's free space (or, when the
 * updates need more than that, everything they need). Each pending update's room in turn (known sizes
 * only, in the order shown), the part that doesn't fit as `over`, then what stays free. `tightAt` is
 * where the "nearly full" zone starts (0–1, null when it's off the bar).
 */
export function barSegments(d: DriveForecast, gamesById: Map<string, Game> = new Map()): { segments: BarSegment[]; tightAt: number | null; domain: number } {
  const known = d.updates.filter((u) => (u.needBytes ?? 0) > 0);
  const need = known.reduce((s, u) => s + (u.needBytes ?? 0), 0);
  const free = Math.max(0, d.freeBytes);
  const domain = Math.max(1, free, need);
  const segments: BarSegment[] = [];
  let room = free;
  for (const u of known) {
    const n = u.needBytes ?? 0;
    const fits = Math.max(0, Math.min(n, room));
    room -= fits;
    if (fits > 0) segments.push({ key: `u-${u.appId}`, kind: 'update', fraction: fits / domain, label: `${titleOf(u, gamesById)} ${formatBytes(n)}`, update: u });
    if (n - fits > 0) segments.push({ key: `o-${u.appId}`, kind: 'over', fraction: (n - fits) / domain, label: `${titleOf(u, gamesById)}: ${formatBytes(n - fits)} more than fits`, update: u });
  }
  if (room > 0) segments.push({ key: 'free', kind: 'free', fraction: room / domain, label: `Still free afterwards ${formatBytes(room)}` });
  const tight = free - d.tightBelowBytes;
  return { segments, tightAt: tight > 0 && tight < domain ? tight / domain : null, domain };
}
