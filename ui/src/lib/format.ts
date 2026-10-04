import type { Game, Installation, PlatformKey } from '../bridge/types';

export const PLATFORM_NAMES: Record<PlatformKey, string> = {
  steam: 'Steam',
  xbox: 'Xbox',
  epic: 'Epic Games',
  gog: 'GOG',
  ea: 'EA app',
  ubisoft: 'Ubisoft Connect',
  battlenet: 'Battle.net',
  manual: 'Added by you',
};

export function formatDuration(seconds: number, opts: { short?: boolean } = {}): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h >= 100 || (opts.short && h >= 10)) return `${h.toLocaleString()}h`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = (t - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return 'Just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 35) return rtf.format(Math.round(diff / (86400 * 7)), 'week');
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
  return rtf.format(Math.round(diff / (86400 * 365)), 'year');
}

export function formatDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Intl.DateTimeFormat(undefined, opts).format(t);
}

/** Most recent play, from VYSTRAL's own sessions or a store's import, with its source. */
export function lastPlayed(game: Game): { at: string | null; source: 'tracked' | 'imported' | null } {
  let at = game.lastTrackedPlay;
  let source: 'tracked' | 'imported' | null = at ? 'tracked' : null;
  for (const i of game.installations) {
    if (i.importedLastPlayed && (!at || i.importedLastPlayed > at)) {
      at = i.importedLastPlayed;
      source = 'imported';
    }
  }
  return { at, source };
}

/** Store-reported minutes (largest across stores; stores never double-count each other). */
export function importedMinutes(game: Game): number | null {
  const values = game.installations.map((i) => i.importedPlaytimeMinutes).filter((v): v is number => v != null);
  return values.length ? Math.max(...values) : null;
}

export function installedOf(game: Game): Installation[] {
  return game.installations.filter((i) => i.state === 'installed');
}

export function isInstalled(game: Game): boolean {
  return game.installations.some((i) => i.state === 'installed');
}

export function primaryInstallation(game: Game): Installation | undefined {
  const installed = installedOf(game);
  return (
    installed.find((i) => i.id === game.preferredInstallationId) ??
    installed.sort((a, b) => (b.importedLastPlayed ?? '').localeCompare(a.importedLastPlayed ?? ''))[0] ??
    game.installations[0]
  );
}

export function sizeOf(game: Game): number | null {
  const sizes = installedOf(game).map((i) => i.sizeBytes).filter((s): s is number => s != null);
  return sizes.length ? Math.max(...sizes) : null;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
