// Track C4: visually helpful game pages. Mirror of src/Vystral.Windows/GamePage/*.cs and AppBackend.GamePage.cs.

export type ReviewTrend = 'up' | 'down' | 'steady';

export interface ReviewScore {
  /** Steam's 0–9 score bucket (0 = none or too few reviews). */
  score: number;
  /** Steam's own words, e.g. "Very Positive" or "4 user reviews". */
  label: string;
  positive: number;
  total: number;
  /** Positive share 0–100, or null with no reviews. */
  percent: number | null;
}

export type GamePageStatus = 'ok' | 'none' | 'off' | 'notSteam' | 'offline' | 'gameRunning' | 'unavailable' | 'rateLimited';

export interface ReviewsSnapshot {
  status: GamePageStatus;
  message: string | null;
  appId: string | null;
  allTime: ReviewScore | null;
  /** The last 30 days. */
  recent: ReviewScore | null;
  /** Null when either window has too few reviews to compare honestly. */
  trend: ReviewTrend | null;
  /** Recent minus all-time positive share, in percentage points. */
  trendPoints: number | null;
  fetchedAt: string | null;
  stale: boolean;
}

export interface PricePoint {
  /** UTC day, yyyy-MM-dd. */
  day: string;
  cents: number;
}

export interface StoreFacts {
  status: GamePageStatus | 'notFound';
  message: string | null;
  /** The price country from Settings › Data sources. */
  country: string;
  appId: string | null;
  sold: boolean;
  priceCents: number | null;
  regularCents: number | null;
  discount: number;
  currency: string | null;
  priceText: string | null;
  metacritic: number | null;
  /** As the Steam store shows it ("18 Apr, 2011", "Q3 2026"). */
  releaseText: string | null;
  comingSoon: boolean;
  /** Steam prices VYSTRAL has seen in this country, oldest first (one point per day). */
  history: PricePoint[];
  fetchedAt: string | null;
  stale: boolean;
}

export interface CommunityTag {
  id: number;
  name: string;
  /** Steam's relative weight on this game (how strongly players applied it). */
  weight: number;
}

export interface GameTags {
  status: GamePageStatus;
  message: string | null;
  tags: CommunityTag[];
  fetchedAt: string | null;
  stale: boolean;
}

export interface LibraryTag {
  id: number;
  name: string;
  /** Games in your library with this tag. */
  count: number;
}

export interface LibraryTags {
  status: 'ok' | 'off' | 'offline' | 'none';
  message: string | null;
  tags: LibraryTag[];
  /** Game id → its tag ids, strongest first. */
  games: Record<string, number[]>;
  covered: number;
  steamGames: number;
  refreshing: boolean;
  fetchedAt: string | null;
}

export type FranchiseEntryType = 'main' | 'expansion' | 'remake' | 'remaster' | 'expanded';

export interface FranchiseEntry {
  igdbId: string;
  name: string;
  date: string | null;
  year: number | null;
  type: FranchiseEntryType;
  /** The library game it matched, or null when you don't own it. */
  gameId: string | null;
  /** The Discover page for it. */
  discoverKey: string;
  /** The game whose page this is. */
  current: boolean;
  hasCover: boolean;
}

export interface Franchise {
  status: 'ok' | 'none' | 'noKey' | 'off' | 'offline' | 'notMatched' | 'gameRunning' | 'unavailable' | 'rateLimited' | 'invalidKey';
  message: string | null;
  name: string | null;
  /** An IGDB series (collection) or franchise. */
  kind: 'series' | 'franchise' | null;
  entries: FranchiseEntry[];
  owned: number;
  fetchedAt: string | null;
  stale: boolean;
}

export interface AchievementProgress {
  unlocked: number;
  total: number;
  fetchedAt: string | null;
  rarestName: string | null;
  rarestPercent: number | null;
}
