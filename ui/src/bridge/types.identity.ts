// Track D4: every data source for every game. Mirror of the DTOs in
// src/Vystral.Windows/DataSources/Identity/IdentityResolverService.cs, FreebiesService.cs and AppBackend.TrackD4.cs.

export type IdKind = 'steam' | 'igdb' | 'rawg' | 'gog' | 'wikidata';

/** Where a piece of evidence came from. */
export type IdSource = 'store' | 'pin' | 'wikidata' | 'igdb' | 'rawg' | 'steam' | 'gog';

/** How it was found: the store's own ID, your choice, a store-ID link, or a title (with the year, or another edition). */
export type IdMethod = 'native' | 'chosen' | 'storeId' | 'exactTitleYear' | 'exactTitle' | 'editionTitle' | 'crossCheck' | 'earlierMatch';

export type IdLevel = 'certain' | 'high' | 'good' | 'medium' | 'low';

export interface IdEvidence {
  source: IdSource;
  method: IdMethod;
  confidence: number;
}

export interface ResolvedId {
  kind: IdKind;
  label: string;
  value: string;
  /** 0–1. */
  confidence: number;
  level: IdLevel;
  status: 'native' | 'pinned' | 'matched' | 'suggested' | 'conflict';
  /** True when VYSTRAL uses this ID for features (the store's own, your choice, or a high-confidence match). */
  used: boolean;
  evidence: IdEvidence[];
  name: string | null;
  link: boolean;
}

export interface IdCandidate {
  kind: IdKind;
  value: string;
  name: string | null;
  year: number | null;
  confidence: number;
  sources: IdSource[];
}

export type IdentityStatus = 'native' | 'matched' | 'pinned' | 'notOnSteam' | 'suggested' | 'conflict' | 'none' | 'notChecked';

/** call('identity.resolved', { gameId, refresh? }). */
export interface ResolvedIdentity {
  gameId: string;
  status: IdentityStatus;
  steam: ResolvedId | null;
  ids: ResolvedId[];
  /** Steam apps you can choose from when fixing a match (best first). */
  steamCandidates: IdCandidate[];
  /** Sources asked the last time this game was looked up. */
  asked: IdSource[];
  checkedAt: string | null;
  canCheck: boolean;
  reason: 'off' | 'offline' | 'gameRunning' | null;
}

/** call('identity.searchSteam', { gameId, query }). */
export interface SteamSearchHit {
  appId: string;
  name: string;
}

// ---------- Free games (GamerPower, Epic) — consumed by Track D5's "Free this week" shelf ----------

export interface Freebie {
  /** Opaque: open it with call('freebies.open', { id }); its image with call('freebies.image', { id }). */
  id: string;
  source: 'gamerpower' | 'epic';
  title: string;
  store: 'steam' | 'epic' | 'gog' | 'itch' | 'xbox' | 'ubisoft' | 'ea' | 'battlenet' | 'other';
  platforms: string[];
  kind: 'game' | 'loot' | 'beta';
  /** 'upcoming' = Epic's next free game (claimable from startsAt). */
  status: 'now' | 'upcoming';
  /** The usual price as the source states it, e.g. "$19.99". */
  worth: string | null;
  startsAt: string | null;
  endsAt: string | null;
  description: string | null;
  /** Art-host URL once cached, else null (ask freebies.image when it scrolls into view). */
  image: string | null;
  hasImage: boolean;
}

export interface FreebieSource {
  id: 'gamerpower' | 'epicfree';
  name: string;
  enabled: boolean;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
  /** Credit to show next to the list (GamerPower requires an active link: call('dataSources.openLink', { provider: 'gamerpower', link: 'home' })). */
  attribution: string;
}

/** call('freebies.get', { refresh? }). */
export interface Freebies {
  items: Freebie[];
  sources: FreebieSource[];
  reason: 'off' | 'offline' | null;
}

// ---------- ProtonDB ----------

export type ProtonTier = 'platinum' | 'gold' | 'silver' | 'bronze' | 'borked' | 'pending';

/** call('protondb.get', { gameId } | { key, appId }). */
export interface ProtonSummary {
  status: 'ok' | 'none' | 'off' | 'notSteam' | 'offline' | 'gameRunning' | 'unavailable' | 'rateLimited';
  message: string | null;
  appId: string | null;
  via: 'matched' | 'pinned' | null;
  tier: ProtonTier | null;
  bestReported: ProtonTier | null;
  trending: ProtonTier | null;
  total: number;
  confidence: string | null;
  fetchedAt: string | null;
  stale: boolean;
}
