// ---------- Track C2: Performance page rig summary, startup timing history ----------

/** call('performance.rig'): this PC, read-only. Null when Windows didn't say. */
export interface Rig {
  gpuName: string | null;
  /** As the vendor writes it (NVIDIA "572.16"), else the Windows driver version. */
  driver: string | null;
  cpuName: string | null;
  /** Logical processors. */
  threads: number;
  memoryGb: number | null;
}

/**
 * One start of VYSTRAL as four milestones in ms since the process started, each at or after the one before:
 * backend ready for the window → WebView2 ready → first paint of Home → interface ready.
 */
export interface StartupRun {
  at: string;
  backendMs: number;
  webViewMs: number;
  firstPaintMs: number;
  readyMs: number;
  /** Home was painted from the saved snapshot. */
  cachedFirstPaint: boolean;
}

/** call('diagnostics.startupHistory', { limit }): the newest starts from the local log, oldest first. */
export interface StartupHistory {
  runs: StartupRun[];
  filesRead: number;
}
