// Track M (v0.5): mirror of the DTOs in src/Vystral.Windows/Recap/*.cs and AppBackend.Recap.cs.
import type { SessionSource } from './types';

/** The few numbers a recap shows from a session's perf summary (null when not recorded). */
export interface RecapPerf {
  fpsAvg: number | null;
  fps1Low: number | null;
  peakTempC: number | null;
  gpuAvg: number | null;
  cpuAvg: number | null;
  hasMetrics: boolean;
}

export interface RecapSession {
  id: string;
  gameId: string;
  title: string;
  source: SessionSource;
  start: string;
  end: string;
  durationSeconds: number;
  perf: RecapPerf;
}

export interface RecapAchievement {
  gameId: string;
  sessionId: string;
  apiName: string;
  name: string;
  description: string | null;
  unlockedAt: string;
  globalPercent: number | null;
  /** Cached art-host icon, or null. */
  icon: string | null;
}

export interface AwayGame {
  gameId: string;
  title: string;
  sessions: number;
  seconds: number;
  lastEnd: string;
}

/** call('away.summary'): sessions noticed (not launched) by VYSTRAL since Home was last opened. */
export interface AwaySummary {
  since: string;
  until: string;
  totalSeconds: number;
  games: AwayGame[];
  sessions: RecapSession[];
  best: RecapSession | null;
  bestFps: RecapSession | null;
  achievements: RecapAchievement[];
  /** Steam games among them whose achievements were never fetched. */
  gamesWithoutAchievementData: number;
}

export interface AwayResult {
  summary: AwaySummary | null;
  /** First call ever: the marker was just set, so nothing is shown. */
  firstVisit: boolean;
}

/** IGDB time-to-beat estimate in seconds (player averages): main story, main + extras, completionist. */
export interface TimeToBeat {
  main: number | null;
  extras: number | null;
  completionist: number | null;
  count: number;
  fetched: string;
  source: 'igdb';
}

export interface TimeToBeatMap {
  games: Record<string, TimeToBeat>;
  reason: 'disabled' | 'noKey' | 'noData' | null;
}

export interface SaleInfo {
  id: string;
  name: string;
  /** Inclusive dates (yyyy-mm-dd) exactly as Valve published them. */
  start: string;
  end: string;
}

/** call('forecast.sales'). */
export interface SaleForecast {
  current: SaleInfo | null;
  next: SaleInfo | null;
  daysUntilNext: number | null;
  daysLeftInCurrent: number | null;
  source: string;
  sourceUrl: string;
  retrieved: string;
  version: number;
  /** Every listed sale is over: nothing newer has been announced (or shipped) yet. */
  outdated: boolean;
}

export interface SavingsGame {
  gameId: string;
  title: string;
  provider: 'itad' | 'cheapshark';
  currency: string;
  current: number;
  shop: string | null;
  low: number;
  lowAt: string | null;
  saving: number;
  pricedAt: string;
  stale: boolean;
}

/** call('forecast.backlogSavings'). */
export interface BacklogSavings {
  candidates: number;
  games: SavingsGame[];
  totals: { currency: string; total: number; games: number }[];
  withoutData: number;
  withoutSteamId: number;
  country: string;
  reason: 'disabled' | 'noBacklog' | 'noPrices' | null;
}

/** call('compat.antiCheatNote', { gameId }): null when the game has no kernel-level anti-cheat listed (or notes are off). */
export interface AntiCheatNote {
  kernel: string[];
  other: string[];
  headline: string;
  notes: string[];
  source: string;
  updated: string | null;
}

/** call('replay.get', { sessionId }). */
export interface ReplayData {
  session: RecapSession;
  achievements: RecapAchievement[];
  steamGame: boolean;
  achievementsKnown: boolean;
}
