// ---------- Track D1: Library bulk actions with undo, observed game versions (mirror of AppBackend.TrackD1.cs) ----------
import type { GameStatus } from './types';

export type BulkActionKind = 'status' | 'favorite' | 'hidden' | 'collection' | 'played';

/** call('library.bulkEdit', …). At most 5,000 games; `value` is required for every action except status. */
export interface BulkEditParams {
  gameIds: string[];
  action: BulkActionKind;
  status?: GameStatus | null;
  value?: boolean;
  collectionId?: string | null;
}

export interface BulkEditResult {
  /** Opaque, single-use, valid for 15 minutes; null when nothing changed (nothing to undo). */
  token: string | null;
  requested: number;
  found: number;
  changed: number;
}

/** call('library.bulkUndo', { token }). Fails with code 'expired' when the token is unknown, used or too old. */
export interface BulkUndoResult {
  restored: number;
}

/**
 * call('versions.history', { gameId }): versions VYSTRAL saw for the game's copies, oldest first, recorded after scans.
 * `baseline` = the first version seen for that copy (VYSTRAL doesn't know when it arrived, so it isn't an update).
 * `storeUpdated` = when the store says it was installed (Steam's LastUpdated, the package's install date), if known.
 */
export interface VersionHistoryEntry {
  installationId: string;
  platform: string;
  kind: 'steamBuild' | 'xboxPackage';
  value: string;
  seen: string;
  storeUpdated: string | null;
  baseline: boolean;
}

/** The most games one bulk call may change (the backend's MaxBulkGames). */
export const MAX_BULK_GAMES = 5000;
