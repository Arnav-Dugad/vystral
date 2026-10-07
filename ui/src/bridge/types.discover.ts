// Track U: universal game search and pages for games you don't own.
// Mirror of the DTOs in src/Vystral.Windows/Discover/DiscoverModels.cs.
import type { PlatformKey } from './types';
import type { AntiCheatInfo, DeckCategory, DeckTestResult } from './types.dataSources';

export type DiscoverSourceId = 'steam' | 'igdb' | 'rawg' | 'wikidata';

/** 'bar' = the command bar, 'page' = the Discover page. A new search cancels the same channel's previous one. */
export type DiscoverChannel = 'bar' | 'page';

/** A Steam store price in cents of `currency` (ISO 4217), for the price country. */
export interface StorePrice {
  finalCents: number;
  initialCents: number;
  currency: string;
}

export interface DiscoverResult {
  /** steam-<appid> | igdb-<id> | rawg-<slug> | wd-<QID> */
  key: string;
  title: string;
  year: number | null;
  /** Stores it's sold on, as the sources report. */
  stores: PlatformKey[];
  /** Plain platform names ("PC", "PlayStation 5"). */
  platforms: string[];
  genres: string[];
  sources: DiscoverSourceId[];
  steamAppId: string | null;
  /** Set when VYSTRAL is sure it's a game in your library (Steam app ID, or an exact title and year). */
  libraryGameId: string | null;
  price: StorePrice | null;
  hasCover: boolean;
  /** The cover's art URL when already cached; otherwise ask with discover.image. */
  cover: string | null;
  score: number;
  /** 'extra' = DLC, soundtracks and the like. */
  kind: 'game' | 'extra';
}

export interface DiscoverSourceState {
  id: DiscoverSourceId;
  name: string;
  state: 'pending' | 'done' | 'failed' | 'skipped';
  /** skipped: off | noKey | offline. failed: rateLimited | unavailable | invalidKey | noKey | offline. */
  reason: string | null;
  count: number;
  hasMore: boolean;
}

export interface DiscoverSearch {
  searchId: string;
  channel: DiscoverChannel;
  query: string;
  page: number;
  sources: DiscoverSourceState[];
  results: DiscoverResult[];
  done: boolean;
  hasMore: boolean;
  /** offline | off | null */
  reason: string | null;
}

export interface DiscoverSourceStatus {
  id: DiscoverSourceId;
  name: string;
  state: 'ready' | 'unavailable';
  reason: string | null;
}

export interface DiscoverStatus {
  searchOnline: boolean;
  localOnly: boolean;
  dataSaver: boolean;
  /** offline | off | null */
  reason: string | null;
  sources: DiscoverSourceStatus[];
  /** Only the browser preview sets this: every result is fictional. */
  preview?: boolean;
}

export interface DiscoverPrice {
  formatted: string | null;
  initial: string | null;
  discountPercent: number;
  currency: string | null;
  free: boolean;
  comingSoon: boolean;
  country: string;
}

export interface DiscoverLink {
  id: 'steam' | 'gog' | 'epic' | 'microsoft' | 'igdb' | 'rawg' | 'wikidata';
  label: string;
  platform: PlatformKey | null;
  /** 'store' = where to get it; 'info' = a reference page. */
  kind: 'store' | 'info';
}

export interface DiscoverCloud {
  service: 'gfn' | 'xbox';
  serviceName: string;
  playType: string | null;
  premium: boolean;
  /** 'store' = matched by a verified store ID; 'title' = a likely match by title. */
  match: 'store' | 'title';
  note: string;
}

export interface DiscoverCredit {
  id: DiscoverSourceId;
  name: string;
  note: string;
}

export interface DiscoverDetails {
  key: string;
  title: string;
  year: number | null;
  releaseDate: string | null;
  description: string | null;
  descriptionSource: DiscoverSourceId | null;
  genres: string[];
  developers: string[];
  publishers: string[];
  platforms: string[];
  stores: PlatformKey[];
  steamAppId: string | null;
  libraryGameId: string | null;
  price: DiscoverPrice | null;
  timeToBeat: { hastilySeconds: number | null; normallySeconds: number | null; completelySeconds: number | null; count: number } | null;
  metacritic: number | null;
  rating: number | null;
  ratingCount: number;
  deck: { category: DeckCategory; tests: DeckTestResult[]; fetched: string } | null;
  antiCheat: AntiCheatInfo | null;
  links: DiscoverLink[];
  cloud: DiscoverCloud[];
  /** off | noData | none | null */
  cloudReason: string | null;
  /** A stand-in ID trailer.get accepts for this game's Steam trailer. */
  trailerId: string | null;
  watching: boolean;
  credits: DiscoverCredit[];
  /** Codes like 'igdb:noKey', 'steam:off', 'rawg:unavailable'. */
  notes: string[];
  fetched: string;
  /** 'offline' when shown from memory in Offline mode. */
  reason: string | null;
  hasHero: boolean;
  hasLogo: boolean;
  hasCover: boolean;
}

export interface DiscoverImage {
  url: string | null;
  /** offline | dataSaver | none */
  reason: string | null;
}

export interface DiscoverWatch {
  key: string;
  title: string;
  year: number | null;
  steamAppId: string | null;
  addedAt: string;
  priceWhenAdded: string | null;
  cover: string | null;
}
