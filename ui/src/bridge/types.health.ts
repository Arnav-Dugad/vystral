// Track Q: the library health check. Mirror of src/Vystral.Core/Health/LibraryHealth.cs and AppBackend.Health.cs.
import type { PlatformKey } from './types';

export type HealthSeverity = 'problem' | 'warning' | 'info';
export type HealthGroup = 'launch' | 'drives' | 'sessions' | 'duplicates' | 'installs' | 'art' | 'metadata';
export type HealthKind =
  | 'brokenShortcut' | 'launchTargetMissing' | 'emptyEntry' | 'missingDrive' | 'duplicateInstall' | 'steamLibraryDuplicate'
  | 'duplicateSuggestion' | 'artMissing' | 'artPlaceholder' | 'artLowRes' | 'artFileMissing' | 'metadataMissing'
  | 'staleMissing' | 'openSession' | 'longSession' | 'platformOff';

/**
 * Native fixes (run with `health.fix`): rescan, refetchArt, lookupMetadata, closeSession; `locate` runs
 * `health.locateExecutable`. The page runs the rest with existing methods or navigation.
 */
export type HealthAction =
  | 'locate' | 'rescan' | 'refetchArt' | 'lookupMetadata' | 'closeSession'
  | 'pickArt' | 'hide' | 'merge' | 'keepSeparate' | 'openGame' | 'openVersions' | 'openSession' | 'openSettings' | 'enableStore';

export interface HealthFix {
  action: HealthAction;
  label: string;
  /** Idempotent: included in "Fix all safe issues". */
  safe: boolean;
}

export interface HealthIssue {
  /** Stable id ("kind:subject"); used to dismiss. */
  id: string;
  kind: HealthKind;
  group: HealthGroup;
  severity: HealthSeverity;
  title: string;
  detail: string;
  gameId: string | null;
  gameIds: string[];
  installationId: string | null;
  platform: PlatformKey | null;
  platforms: PlatformKey[];
  path: string | null;
  drive: string | null;
  sessionId: string | null;
  artKind: 'cover' | 'hero' | 'logo' | 'header' | null;
  otherGameId: string | null;
  fixes: HealthFix[];
}

export interface HealthReport {
  checkedAt: string;
  elapsedMs: number;
  /** 0–100; 100 only with nothing to fix. */
  score: number;
  gameCount: number;
  issues: HealthIssue[];
  dismissedCount: number;
  offline: boolean;
  scanning: boolean;
}

export interface HealthFixAllResult {
  fixed: number;
  skipped: number;
  notes: string[];
  report: HealthReport;
}

export interface HealthProgress {
  done: number;
  total: number;
  label: string;
}
