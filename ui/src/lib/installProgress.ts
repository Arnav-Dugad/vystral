import type { Achievement, InstallProgress } from '../bridge/types';
import { formatBytes } from './format';

/** 0–1 progress, or null when Steam hasn't reported a size yet. */
export function progressFraction(p: Pick<InstallProgress, 'phase' | 'bytesDone' | 'bytesTotal'>): number | null {
  if (p.phase === 'installed') return 1;
  if (!(p.bytesTotal > 0)) return null;
  return Math.max(0, Math.min(1, p.bytesDone / p.bytesTotal));
}

/** Seconds remaining at the current rate, or null when it can't be estimated honestly. */
export function etaSeconds(p: Pick<InstallProgress, 'phase' | 'bytesDone' | 'bytesTotal' | 'rate'>): number | null {
  if (p.phase !== 'downloading' && p.phase !== 'staging') return null;
  if (!p.rate || p.rate <= 0 || !(p.bytesTotal > 0) || p.bytesDone >= p.bytesTotal) return null;
  return (p.bytesTotal - p.bytesDone) / p.rate;
}

export function formatEta(seconds: number | null): string | null {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes}m left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h >= 48) return `about ${Math.round(h / 24)} days left`;
  return m >= 5 ? `about ${h}h ${m}m left` : `about ${h}h left`;
}

export function formatRate(bytesPerSecond: number | null): string | null {
  if (!bytesPerSecond || bytesPerSecond <= 0) return null;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** What to call the current step, without claiming more than Steam's files show. */
export function phaseLabel(p: Pick<InstallProgress, 'kind' | 'phase'>): string {
  if (p.kind === 'uninstall') return p.phase === 'removed' ? 'Uninstalled by Steam' : 'Waiting for Steam to uninstall…';
  if (p.kind === 'update') {
    switch (p.phase) {
      case 'downloading': return 'Steam is updating';
      case 'staging': return 'Steam is applying the update';
      case 'paused': return 'Update paused in Steam';
      case 'installed': return 'Update finished';
      case 'queued': return 'Update queued in Steam';
      default: return 'Steam is working on an update';
    }
  }
  switch (p.phase) {
    case 'queued': return 'Waiting for Steam…';
    case 'downloading': return 'Downloading';
    case 'staging': return 'Installing';
    case 'paused': return 'Paused in Steam';
    case 'installed': return 'Ready to play';
    case 'removed': return 'Install cancelled in Steam';
    default: return 'Steam is working…';
  }
}

/** One-line detail: "4.2 GB of 31 GB · 38 MB/s · about 12 min left". */
export function progressDetail(p: InstallProgress): string {
  const parts: string[] = [];
  if (p.bytesTotal > 0 && p.phase !== 'installed') parts.push(`${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}`);
  const rate = p.phase === 'downloading' ? formatRate(p.rate) : null;
  if (rate) parts.push(rate);
  const eta = formatEta(etaSeconds(p));
  if (eta) parts.push(eta);
  return parts.join(' · ');
}

// ---------- Achievements ----------

export type RarityTier = 'ultra' | 'rare' | null;

/** "Ultra rare" under 2% of players, "Rare" under 10%. */
export function rarityTier(percent: number | null | undefined): RarityTier {
  if (percent == null || !Number.isFinite(percent)) return null;
  if (percent < 2) return 'ultra';
  if (percent < 10) return 'rare';
  return null;
}

export type AchievementFilter = 'all' | 'unlocked' | 'locked' | 'rarest';

/**
 * Filters and orders achievements. "All" lists unlocked ones (newest first) before locked ones
 * (most commonly unlocked first, i.e. the likeliest next); "Rarest" sorts by global percentage.
 */
export function filterAchievements(list: readonly Achievement[], filter: AchievementFilter, query = ''): Achievement[] {
  const q = query.trim().toLowerCase();
  let out = list.filter((a) =>
    (filter === 'unlocked' ? a.achieved : filter === 'locked' ? !a.achieved : true) &&
    (!q || a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q)),
  );
  const pct = (a: Achievement) => a.globalPercent ?? Number.POSITIVE_INFINITY;
  if (filter === 'rarest') {
    out = out.sort((a, b) => pct(a) - pct(b) || a.name.localeCompare(b.name));
  } else {
    out = out.sort((a, b) => {
      if (a.achieved !== b.achieved) return a.achieved ? -1 : 1;
      if (a.achieved) return (b.unlockedAt ?? '').localeCompare(a.unlockedAt ?? '');
      return (b.globalPercent ?? -1) - (a.globalPercent ?? -1) || a.name.localeCompare(b.name);
    });
  }
  return out;
}
