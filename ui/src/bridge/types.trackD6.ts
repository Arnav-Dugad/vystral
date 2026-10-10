// Track D6: app currency (exchange rates), Data sources health, the cache viewer and the crash-free streak
// (mirror of AppBackend.TrackD6.cs).

export interface FxStatus {
  state: 'ok' | 'stale' | 'never' | 'offline' | 'error' | 'refreshing';
  /** Every rate is "1 base = rate quote" (null before the first download). */
  base: string | null;
  /** The rates' publication date (YYYY-MM-DD). */
  date: string | null;
  fetchedAt: string | null;
  rates: Record<string, number> | null;
  /** Windows' region currency: what '' in Settings means. */
  regionCurrency: string;
  source: string;
  error: string | null;
  nextAttemptAt: string | null;
}

export type ProviderState = 'ok' | 'error' | 'backoff' | 'idle' | 'off';

export interface ProviderHealthEntry {
  id: string;
  name: string;
  group: string;
  /** A ServiceLogo id, 'steam' for the Steam mark, or null for a plain icon. */
  logo: string | null;
  purpose: string;
  enabled: boolean;
  optIn: boolean;
  disabledReason: string | null;
  state: ProviderState;
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorText: string | null;
  backoffUntil: string | null;
  backoffReason: string | null;
  requestsToday: number;
  cacheUpdated: string | null;
}

export interface ProviderHealthSnapshot {
  at: string;
  offline: boolean;
  providers: ProviderHealthEntry[];
}

export type CacheId =
  | 'art' | 'thumbs' | 'trailers' | 'news' | 'prices' | 'ai' | 'discover' | 'tags' | 'friends' | 'wishlist' | 'catalogs' | 'gamePages'
  | 'lookups' | 'fx' | 'firstPaint';

export interface CacheInfo {
  id: CacheId | string;
  bytes: number;
  /** Files, or rows for database caches. */
  items: number;
  newest: string | null;
  oldest: string | null;
  clearable: boolean;
}

export interface CacheClearResult {
  id: string;
  freedBytes: number;
  items: number;
  failed: number;
}

export type StreakIncidentKind = 'failedStart' | 'unexpectedClose' | 'rollback' | 'selfCheck';

export interface StreakIncident {
  at: string;
  kind: StreakIncidentKind | string;
  version: string;
  text: string;
}

export interface StreakDay {
  day: string;
  starts: number;
  failed: number;
  unexpected: number;
}

export interface StreakSummary {
  /** Whole days since the last failed start (or since the history began). */
  days: number;
  since: string | null;
  /** No failed start is on record: the count runs from the first recorded start. */
  sinceHistoryBegan: boolean;
  startsCounted: number;
  failedStarts: number;
  unexpectedCloses: number;
  lastIncident: StreakIncident | null;
  incidents: StreakIncident[];
  /** The last 30 days, oldest first. */
  recent: StreakDay[];
}
