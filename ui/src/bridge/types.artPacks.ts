// Track N: art packs. Mirror of the DTOs in src/Vystral.Windows/DataSources/ArtPackService.cs.

export type ArtPackKind = 'cover' | 'hero' | 'logo';

export type ArtPackPresetId = 'official' | 'alternate' | 'minimal' | 'blurred' | 'material' | 'white';

export interface ArtPackPreset {
  id: ArtPackPresetId;
  label: string;
  description: string;
  /** SteamGridDB styles asked for per slot ([] = any style, best rated first). A missing slot isn't offered by this preset. */
  styles: Partial<Record<ArtPackKind, string[]>>;
}

/** 'all' | 'installed' | `collection:${id}` | `platform:${key}` */
export type ArtPackScope = string;

/** Why a job is waiting (it resumes by itself). */
export type ArtPackWaitReason = 'offline' | 'dataSaver' | 'gameRunning' | 'rateLimited' | 'unavailable' | 'safeMode';

export interface ArtPackJob {
  id: string;
  presetId: ArtPackPresetId;
  presetLabel: string;
  kinds: ArtPackKind[];
  scope: ArtPackScope;
  replaceHandPicked: boolean;
  state: 'running' | 'paused' | 'waiting' | 'done' | 'cancelled' | 'failed';
  /** While waiting: an {@link ArtPackWaitReason}. When failed: a message. */
  reason: string | null;
  /** Slots planned. */
  total: number;
  done: number;
  applied: number;
  /** Slots left alone because the user picked art for them while the pack ran. */
  kept: number;
  noMatch: number;
  noArt: number;
  failed: number;
  started: string;
  finished: string | null;
  etaSeconds: number | null;
  /** Title of the game being worked on. */
  current: string | null;
  /** When SteamGridDB asked VYSTRAL to slow down: when the job continues. */
  resumeAt: string | null;
}

export interface ArtPackRun {
  id: string;
  presetId: ArtPackPresetId;
  presetLabel: string;
  scope: ArtPackScope;
  kinds: ArtPackKind[];
  /** Slots this run changed (what "Restore previous art" puts back). */
  replaced: number;
  started: string;
  finished: string | null;
  state: 'running' | 'done' | 'cancelled' | 'failed' | 'interrupted';
  restoredAt: string | null;
  canRestore: boolean;
}

export interface ArtPacksStatus {
  /** The user's SteamGridDB key is stored. */
  configured: boolean;
  localOnly: boolean;
  dataSaver: boolean;
  gameActive: boolean;
  safeMode: boolean;
  presets: ArtPackPreset[];
  job: ArtPackJob | null;
  /** Newest first, up to ten. */
  runs: ArtPackRun[];
}

export interface ArtPackPlan {
  /** Games in the chosen selection (hidden games are never included). */
  inScope: number;
  /** Games with at least one slot to change. */
  games: number;
  slots: number;
  /** Slots skipped because they hold art the user chose by hand. */
  keptHandPicked: number;
  estimatedSeconds: number;
  /** Up to eight games to preview, in the order the job visits them. */
  sample: { gameId: string; title: string }[];
}

export interface ArtPackSample {
  gameId: string;
  kind: ArtPackKind;
  /** Art-host URL of a cached preview. */
  thumb: string | null;
  matchedBy: 'steam' | 'title' | null;
  author: string | null;
  /** noMatch: no confident SteamGridDB match; noArt: nothing in this style; noPreview: the preview couldn't be loaded. */
  reason: 'noMatch' | 'noArt' | 'noPreview' | null;
}

export interface ArtPackRequest {
  preset: ArtPackPresetId;
  kinds: ArtPackKind[];
  scope: ArtPackScope;
  replaceMine: boolean;
}

export interface ArtPackRestore {
  restored: number;
  /** Slots changed since the pack (by hand or by a newer pack), left alone. */
  skipped: number;
}
