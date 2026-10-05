// Track I: data sources. Mirror of the DTOs in src/Vystral.Windows/DataSources/DataSourcesService.cs.
import type { PlatformKey, SettingKey } from './types';

export type DataSourceId = 'steamgriddb' | 'igdb' | 'rawg' | 'itad' | 'cheapshark' | 'wikidata' | 'steamdeck' | 'awacy';

export type DataSourceOutcome = 'ok' | 'invalidKey' | 'notConfigured' | 'rateLimited' | 'unavailable' | 'malformed' | 'offline' | 'disabled';

export interface ProviderTest {
  outcome: DataSourceOutcome;
  message: string;
  at: string;
}

export interface ProviderStatus {
  id: DataSourceId;
  name: string;
  /** 'key' = the user's own API key; 'twitch' = the user's own Twitch app (client ID + secret); 'keyless'. */
  access: 'key' | 'twitch' | 'keyless';
  configured: boolean;
  /** Last four characters only; the key itself never reaches the page. */
  keyMasked: string | null;
  enabled: boolean;
  settingKey: SettingKey | null;
  lastTest: ProviderTest | null;
  /** The provider asked VYSTRAL to pause until then (429). */
  pausedUntil: string | null;
  licence: string;
  attribution: string;
  host: string;
  sends: string;
  uses: string;
}

export interface DataSourcesStatus {
  providers: ProviderStatus[];
  localOnly: boolean;
  dataSaver: boolean;
  fetchMetadata: boolean;
  priceCountry: string;
}

export interface ProviderAction {
  result: ProviderTest;
  status: DataSourcesStatus;
}

export type PickerKind = 'cover' | 'hero' | 'logo' | 'icon';

export interface ArtOption {
  id: string;
  /** Art-host URL of a cached preview, or null until requested with art.thumb. */
  thumb: string | null;
  width: number;
  height: number;
  style: string | null;
  author: string | null;
  score: number;
  animated: boolean;
}

export interface SgdbGame {
  id: string;
  name: string;
  year: number | null;
}

export interface ArtOptions {
  kind: PickerKind;
  game: SgdbGame | null;
  /** 'steam' (by Steam app ID), 'title' (exact title), 'chosen' (picked by the user), or null. */
  matchedBy: 'steam' | 'title' | 'chosen' | null;
  items: ArtOption[];
  /** When no exact match was found: SteamGridDB entries the user can choose from. */
  candidates: SgdbGame[];
  styles: string[];
  previewsPaused: boolean;
  hasMore: boolean;
}

export interface UserArt {
  kind: string;
  /** 'file' (chosen from disk) or a source such as 'steamgriddb'. */
  source: string;
  author: string | null;
}

export interface DealOffer {
  id: string;
  shop: string;
  price: number;
  regular: number | null;
  cut: number;
}

export interface DealQuote {
  provider: 'cheapshark' | 'itad';
  name: string;
  currency: string | null;
  offers: DealOffer[];
  historicalLow: number | null;
  historicalLowAt: string | null;
  fetched: string | null;
  stale: boolean;
  error: string | null;
}

export interface Deals {
  steamAppId: string | null;
  reason: 'noSteamId' | 'offline' | 'disabled' | null;
  country: string;
  quotes: DealQuote[];
}

export interface IdentityEntry {
  name: string;
  label: string;
  value: string;
  /** A store VYSTRAL knows (for PlatformBadge), or null for reference sites. */
  platform: PlatformKey | null;
  link: boolean;
}

export interface Identity {
  keyKind: 'steam' | 'gog' | null;
  keyValue: string | null;
  wikidataId: string | null;
  label: string | null;
  ids: IdentityEntry[];
  fetched: string | null;
  reason: 'noStoreId' | 'offline' | 'disabled' | 'notChecked' | 'notFound' | 'rateLimited' | 'unavailable' | null;
}

export interface DeckTestResult {
  text: string;
  kind: 'pass' | 'note' | 'fail' | 'info';
}

export type DeckCategory = 'verified' | 'playable' | 'unsupported' | 'unknown';

export interface AntiCheatInfo {
  names: string[];
  kernel: boolean;
  status: 'Supported' | 'Running' | 'Broken' | 'Denied' | 'Planned';
  statusLabel: string;
  reference: string | null;
  updated: string | null;
  slug: string | null;
}

export interface Compat {
  deck: { category: DeckCategory; tests: DeckTestResult[]; fetched: string } | null;
  deckReason: 'noSteamId' | 'disabled' | 'offline' | 'unavailable' | null;
  antiCheat: AntiCheatInfo | null;
  antiCheatReason: 'disabled' | 'offline' | 'notLoaded' | 'notListed' | 'unavailable' | null;
}

export interface EnrichmentFacts {
  name?: string;
  genres?: string[];
  themes?: string[];
  gameModes?: string[];
  perspectives?: string[];
  releaseDate?: string | null;
  developers?: string[];
  publishers?: string[];
  franchises?: string[];
  series?: string[];
  similar?: string[];
  /** IGDB: critic (aggregated) and combined ratings, 0–100. */
  criticRating?: number | null;
  criticRatingCount?: number;
  totalRating?: number | null;
  totalRatingCount?: number;
  /** IGDB time to beat, in seconds. */
  timeToBeat?: { hastily: number | null; normally: number | null; completely: number | null; count: number } | null;
  /** RAWG: user rating out of 5. */
  userRating?: number | null;
  userRatingCount?: number;
  averagePlaytimeHours?: number | null;
  esrb?: string | null;
}

export interface EnrichmentSource {
  source: 'igdb' | 'rawg';
  name: string;
  matched: boolean;
  matchMethod: 'steam-appid' | 'wikidata' | 'exact-title' | null;
  confidence: number | null;
  url: string | null;
  fetched: string;
  facts: EnrichmentFacts | null;
}

export interface Enrichment {
  sources: EnrichmentSource[];
  /** Field → source that filled it (e.g. developer → igdb). */
  fieldSources: Record<string, string>;
  canFetch: boolean;
  reason: 'offline' | 'disabled' | 'noKeys' | 'gameRunning' | null;
}

export type ValueSince = 'firstSeen' | 'firstSession' | 'firstAchievement' | 'storeLastPlayed';

export interface ValueGame {
  gameId: string;
  title: string;
  platforms: PlatformKey[];
  since: string;
  sinceSource: ValueSince;
  priceCents: number | null;
  regularCents: number | null;
  currency: string | null;
  formatted: string | null;
  notSold: boolean;
  pricedAt: string | null;
}

export interface ValueTimeline {
  games: ValueGame[];
  currency: string | null;
  totalCents: number;
  priced: number;
  unpriced: number;
  lastPriced: string | null;
  country: string;
  pricesEnabled: boolean;
  reason: 'disabled' | 'offline' | null;
}
