/**
 * Track N: pure helpers for art packs (labels, scope choices, the picker's "Apply this style to…"
 * shortcut, progress and time). Deterministic and unit-tested; nothing here touches the bridge.
 */
import type {
  ArtPackJob, ArtPackKind, ArtPackPreset, ArtPackPresetId, ArtPackScope, CollectionInfo as Collection, Game, PlatformKey,
} from '../bridge/types';
import { PLATFORM_NAMES } from './format';

export const ART_PACK_KINDS: ArtPackKind[] = ['cover', 'hero', 'logo'];

export const KIND_LABEL: Record<ArtPackKind, string> = { cover: 'Covers', hero: 'Backgrounds', logo: 'Logos' };

/** True when a preset offers art for a slot. */
export const presetSupports = (preset: ArtPackPreset | undefined, kind: ArtPackKind) => !!preset?.styles[kind];

/** The slots that will actually be applied: chosen and offered by the preset, in a stable order. */
export function effectiveKinds(preset: ArtPackPreset | undefined, chosen: readonly ArtPackKind[]): ArtPackKind[] {
  return ART_PACK_KINDS.filter((k) => chosen.includes(k) && presetSupports(preset, k));
}

/** The slot shown in the 8-game preview: covers when chosen, else backgrounds, else logos. */
export function previewKind(kinds: readonly ArtPackKind[]): ArtPackKind | null {
  return ART_PACK_KINDS.find((k) => kinds.includes(k)) ?? null;
}

export interface ScopeOption {
  value: ArtPackScope;
  label: string;
  count: number;
}

const STORE_ORDER: PlatformKey[] = ['steam', 'xbox', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'manual'];

/**
 * The selections offered: everything, installed games, each collection and each store present —
 * with how many (visible) games each holds. Empty selections are left out, except "All games".
 */
export function scopeOptions(games: readonly Game[], collections: readonly Collection[]): ScopeOption[] {
  const visible = games.filter((g) => !g.hidden);
  const installed = visible.filter((g) => g.installations.some((i) => i.state === 'installed')).length;
  const out: ScopeOption[] = [{ value: 'all', label: 'All games', count: visible.length }];
  if (installed) out.push({ value: 'installed', label: 'Installed games', count: installed });
  for (const c of collections) {
    const n = visible.filter((g) => g.collections.includes(c.id)).length;
    if (n) out.push({ value: `collection:${c.id}`, label: `Collection: ${c.name}`, count: n });
  }
  for (const p of STORE_ORDER) {
    const n = visible.filter((g) => g.installations.some((i) => i.platform === p)).length;
    if (n) out.push({ value: `platform:${p}`, label: `${PLATFORM_NAMES[p]} games`, count: n });
  }
  return out;
}

/** A short description of a stored scope, for history rows. */
export function scopeLabel(scope: ArtPackScope, collections: readonly Collection[]): string {
  if (scope === 'all') return 'All games';
  if (scope === 'installed') return 'Installed games';
  if (scope.startsWith('collection:')) return collections.find((c) => c.id === scope.slice(11))?.name ?? 'A collection';
  if (scope.startsWith('platform:')) return `${PLATFORM_NAMES[scope.slice(9) as PlatformKey] ?? 'A store'} games`;
  return scope;
}

/**
 * The art pack matching a style picked in the art picker, so "Apply this style to…" can open Art packs
 * with it chosen. Null when no preset uses that style for that slot (e.g. black logos).
 */
export function presetForStyle(kind: string, style: string | null): ArtPackPresetId | null {
  if (kind === 'cover') return ({ alternate: 'alternate', no_logo: 'minimal', blurred: 'blurred', material: 'material', white_logo: 'white' } as const)[style ?? ''] ?? (style ? null : 'official');
  if (kind === 'hero') return ({ alternate: 'alternate', blurred: 'blurred', material: 'material' } as const)[style ?? ''] ?? (style ? null : 'official');
  if (kind === 'logo') return ({ official: 'official', custom: 'alternate', white: 'white' } as const)[style ?? ''] ?? null;
  return null;
}

/** 0..1, for the progress bar. */
export function jobFraction(job: Pick<ArtPackJob, 'done' | 'total'>): number {
  return job.total > 0 ? Math.min(1, Math.max(0, job.done / job.total)) : 0;
}

export const isActive = (job: ArtPackJob | null | undefined): job is ArtPackJob =>
  !!job && (job.state === 'running' || job.state === 'paused' || job.state === 'waiting');

/** "about 3 min", "about 1 h 20 min", "under a minute". */
export function formatEta(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return 'under a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `about ${h} h ${rest} min` : `about ${h} h`;
}

export const WAIT_LABEL: Record<string, string> = {
  offline: 'Waiting: Offline mode is on',
  dataSaver: 'Waiting: Data saver is on',
  gameRunning: 'Waiting until your game closes',
  rateLimited: 'SteamGridDB asked VYSTRAL to slow down — continuing shortly',
  unavailable: 'SteamGridDB isn’t answering — trying again',
  safeMode: 'Waiting: safe mode',
};

/** One line describing where a job is. */
export function jobStatusLine(job: ArtPackJob): string {
  switch (job.state) {
    case 'running': {
      const eta = formatEta(job.etaSeconds);
      return `${job.done.toLocaleString()} of ${job.total.toLocaleString()}${eta ? ` · ${eta} left` : ''}`;
    }
    case 'paused':
      return `Paused at ${job.done.toLocaleString()} of ${job.total.toLocaleString()}`;
    case 'waiting':
      return WAIT_LABEL[job.reason ?? ''] ?? 'Waiting';
    case 'done':
      return jobSummary(job);
    case 'cancelled':
      return `Cancelled · ${jobSummary(job)}`;
    case 'failed':
      return job.reason ?? 'Stopped';
  }
}

/** "Updated 42 · 3 kept as you chose · 5 not on SteamGridDB · 2 without this style". */
export function jobSummary(job: ArtPackJob): string {
  const parts = [`Updated ${job.applied.toLocaleString()}`];
  if (job.kept) parts.push(`${job.kept.toLocaleString()} kept as you chose`);
  if (job.noMatch) parts.push(`${job.noMatch.toLocaleString()} without a confident match`);
  if (job.noArt) parts.push(`${job.noArt.toLocaleString()} without this style`);
  if (job.failed) parts.push(`${job.failed.toLocaleString()} couldn’t be downloaded`);
  return parts.join(' · ');
}
