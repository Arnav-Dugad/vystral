// Track V: your gaming subscriptions. Mirror of the DTOs in src/Vystral.Windows/Subscriptions/SubscriptionService.cs
// and the queue signal in src/Vystral.Windows/Cloud/GfnQueueWatcher.cs.

/** A plan the user can say they have (stored in settings 'subs.owned' as a comma list). */
export type SubsPlanId =
  | 'gp-pc' | 'gp-essential' | 'gp-premium' | 'gp-ultimate'
  | 'ea-play' | 'ea-play-pro'
  | 'ubi-classics' | 'ubi-premium'
  | 'humble-choice' | 'prime-gaming';

export type SubsFamily = 'gamepass' | 'eaplay' | 'ubisoft' | 'humble' | 'prime';

/** call('subs.map'): gameId → the plans that include it. Empty while the public lists are off. */
export type SubsMap = Record<string, SubsBadge[]>;

export interface SubsBadge {
  plan: SubsPlanId;
  planName: string;
  family: SubsFamily;
  /** 'store' = the Xbox copy's package matches the plan's product; 'title' = a likely match by name. */
  match: 'store' | 'title';
  /** In Game Pass's public "Leaving soon" list. */
  leaving: boolean;
  /** The Store listing's Game Pass end date, when it has one (shown as "around"). */
  leavingEnd: string | null;
}

export interface SubsPlanCount {
  plan: SubsPlanId;
  name: string;
  /** Microsoft publishes a list for this plan (Humble Choice and Prime Gaming have none). */
  hasList: boolean;
  count: number;
  inLibrary: number;
}

export interface SubsStatus {
  plans: SubsPlanId[];
  /** The user answered (or dismissed) the question. */
  asked: boolean;
  /** Opt-in: download Microsoft's public Game Pass lists. */
  catalog: boolean;
  localOnly: boolean;
  dataSaver: boolean;
  market: string;
  state: 'off' | 'noPlans' | 'never' | 'ok' | 'stale' | 'error' | 'offline' | 'refreshing';
  refreshedAt: string | null;
  nextRefreshAt: string | null;
  error: string | null;
  counts: SubsPlanCount[];
  /** "Leaving soon" games in your plans, and how many of them are in your library. */
  leaving: number;
  leavingInLibrary: number;
  /** Products still being looked up (names arrive over the next refreshes). */
  pending: number;
  refreshing: boolean;
}

/** call('subs.included'): a game your plans include that isn't in your library. Opening it shows the official page. */
export interface SubsPick {
  productId: string;
  title: string;
  plan: SubsPlanId;
  planName: string;
  reason: 'leaving' | 'new' | 'popular';
  /** A cached poster on the art host, or null (a generated tile is drawn). */
  poster: string | null;
  leavingEnd: string | null;
}

export interface SubsValue {
  monthStart: string;
  plans: SubsPlanId[];
  /** The public lists are on and downloaded, so plan games can be recognised. */
  hasLists: boolean;
  seconds: number;
  games: number;
  sessions: number;
  rows: { plan: SubsPlanId | 'geforce-now'; name: string; seconds: number; games: number }[];
  top: { gameId: string; title: string; seconds: number }[];
  /** What the user typed (0 = nothing entered). */
  price: number;
  currency: string;
  /** Only with a price and at least an hour this month. */
  costPerHour: number | null;
  costNote: 'none' | 'underHour' | null;
}

/** 'cloud.queue' event and call('cloud.queueState'): what the GeForce NOW window title said while waiting. */
export interface CloudQueueSignal {
  gameId: string;
  title: string;
  phase: 'queue' | 'starting' | 'none';
  position: number | null;
  etaMinutes: number | null;
  notify: 'near' | 'starting' | null;
  key: string;
}
