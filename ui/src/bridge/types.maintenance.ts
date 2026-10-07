// Track AA: the after-update self-check and database compaction (mirror of AppBackend.Maintenance.cs).

export type SelfCheckOutcome = 'passed' | 'failed' | 'skipped';

export interface SelfCheckItem {
  id: 'database' | 'integrity' | 'bridge' | 'uiReady' | 'artCache' | 'settings' | string;
  label: string;
  outcome: SelfCheckOutcome;
  detail: string;
}

export interface SelfCheckReport {
  version: string;
  at: string;
  /** Run from Settings ("Check again"); manual runs never count toward a rollback. */
  manual: boolean;
  passed: number;
  total: number;
  checks: SelfCheckItem[];
}

export interface SelfCheckStatus {
  running: boolean;
  currentVersion: string;
  /** The newest report for the running version (else the newest overall), or null before the first check. */
  latest: SelfCheckReport | null;
}

export interface CompactionStatus {
  /** The database and its write-ahead journal, in bytes. */
  sizeBytes: number;
  running: boolean;
  autoEnabled: boolean;
  lastRun: { at: string; beforeBytes: number; afterBytes: number; durationMs: number } | null;
  lastAttempt: { at: string; outcome: 'compacted' | 'busy' | 'failed' | string } | null;
  /** When the next automatic compaction is due (null: as soon as the PC is idle and plugged in). */
  nextDueAt: string | null;
}

export interface CompactionResult {
  outcome: 'compacted' | 'busy' | 'failed' | 'skipped';
  reason: string | null;
  beforeBytes: number;
  afterBytes: number;
  durationMs: number;
}
