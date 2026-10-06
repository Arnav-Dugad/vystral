// Track O: cloud play (Xbox Cloud Gaming, GeForce NOW). Mirror of the DTOs in src/Vystral.Windows/Cloud/CloudPlayService.cs.

export type CloudService = 'gfn' | 'xbox';

/** Where a cloud game opens: the vendor's desktop app, a separate Edge window, or the default browser. */
export type CloudSurface = 'gfnApp' | 'xboxApp' | 'edge' | 'browser';

/** 'store' = matched by a verified store ID; 'title' = a likely match by title (labelled as such). */
export type CloudMatch = 'store' | 'title';

/** GeForce NOW membership the user picked in Settings. */
export type GfnPlanId = 'none' | 'free' | 'performance' | 'ultimate' | 'daypass';

/** call('cloud.map'): gameId → the services that list it. Empty while cloud play is off. */
export type CloudMap = Record<string, CloudBadge[]>;

export interface CloudBadge {
  service: CloudService;
  /** 'ready' | 'install' (GeForce NOW Install-to-Play) | null */
  playType: string | null;
  /** The vendor lists a paid membership as the minimum. */
  premium: boolean;
  match: CloudMatch;
}

export interface CloudOption {
  service: CloudService;
  serviceName: string;
  /** The title as the vendor lists it. */
  entryTitle: string;
  playType: string | null;
  premium: boolean;
  match: CloudMatch;
  /** The store copy that matched ('steam', 'xbox', 'epic', …). */
  matchStore: string;
  surface: CloudSurface;
  surfaceLabel: string;
  /** e.g. "Cloud playable · may be included with Game Pass", "GeForce NOW · Install-to-Play (Performance/Ultimate)". */
  headline: string;
  requirement: string;
  note: string | null;
}

export interface CloudSession {
  gameId: string;
  title: string;
  service: CloudService;
  surface: CloudSurface;
  /** 'waiting' = opened, the stream hasn't started yet (e.g. a GeForce NOW queue); 'running' = counting. */
  state: 'waiting' | 'running';
  start: string | null;
  seconds: number;
  /** VYSTRAL can't see when it ends (a browser tab): the user presses "I'm done". */
  manual: boolean;
  sessionLimitSeconds: number | null;
  sessionLeftSeconds: number | null;
  sessionLevel: 'none' | 'ok' | 'near' | 'reached';
}

/** The hours meter: estimated from sessions VYSTRAL saw (other devices aren't counted). */
export interface CloudMeter {
  plan: GfnPlanId;
  planLabel: string;
  cycleStart: string;
  nextReset: string;
  usedSeconds: number;
  /** null = the plan has no published monthly limit. */
  limitSeconds: number | null;
  leftSeconds: number | null;
  fraction: number | null;
  level: 'none' | 'ok' | 'near' | 'reached';
  rolloverHours: number;
  sessionLimitSeconds: number | null;
  sessionLeftSeconds: number | null;
  sessionLevel: 'none' | 'ok' | 'near' | 'reached';
  sessions: number;
  /** Xbox Cloud Gaming time this cycle (no meter: no hour limit is applied by VYSTRAL). */
  xboxSeconds: number;
  xboxSessions: number;
  resetDay: number;
  planNote: string;
  /** When the plan limits were last checked against NVIDIA's pages. */
  asOf: string;
}

export interface CloudServiceState {
  service: CloudService;
  name: string;
  enabled: boolean;
  /** Entries in the cached catalogue for the current market. */
  count: number;
  /** Library games it lists. */
  matched: number;
  refreshedAt: string | null;
  /** The earliest next refresh (daily limit, or back-off after an error); null = now. */
  nextRefreshAt: string | null;
  state: 'off' | 'never' | 'ok' | 'stale' | 'error' | 'offline' | 'refreshing';
  error: string | null;
}

export interface CloudStatus {
  enabled: boolean;
  localOnly: boolean;
  dataSaver: boolean;
  /** Two-letter market/country used for both catalogues. */
  market: string;
  marketSource: 'windows' | 'setting' | 'default';
  browser: 'edge' | 'default';
  services: CloudServiceState[];
  apps: { gfnApp: boolean; xboxApp: boolean; edge: boolean };
  active: CloudSession | null;
  meter: CloudMeter;
  refreshing: boolean;
}

export interface CloudGame {
  gameId: string;
  enabled: boolean;
  /** 'off' = cloud play is off; 'noData' = no catalogue yet; 'none' = not listed; null = has options. */
  reason: 'off' | 'noData' | 'none' | null;
  options: CloudOption[];
  active: CloudSession | null;
  meter: CloudMeter | null;
}

export interface CloudLaunchResult {
  service: CloudService;
  surface: CloudSurface;
  surfaceLabel: string;
  message: string;
}

/** call('cloud.serviceStatus'): GeForce NOW's public status page. */
export interface CloudServiceHealth {
  service: CloudService;
  indicator: 'none' | 'minor' | 'major' | 'critical' | 'maintenance' | 'unknown';
  description: string;
  components: number;
  degraded: number;
  incidents: string[];
  checkedAt: string;
  error: string | null;
}

export type CloudLink = 'gfnMemberships' | 'gfnFaq' | 'gfnStatus' | 'gfnSystem' | 'xboxCloud' | 'xboxStatus';
