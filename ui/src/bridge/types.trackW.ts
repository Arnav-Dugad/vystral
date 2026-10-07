// ---------- Track W: Steam data extras (mirror of WishlistService, FriendsHistoryService, AchievementGuideService, SteamNewsService) ----------

export interface WishlistPoint {
  /** UTC day, yyyy-MM-dd. */
  day: string;
  cents: number;
}

/** One wishlisted game. Money is in the currency's minor units, exactly as Steam reports it. */
export interface WishlistItem {
  appId: string;
  name: string;
  /** Your wishlist order on Steam (0 = unranked). */
  priority: number;
  added: string | null;
  /** Null when Steam only gives a month, quarter or year (see `releaseText`). */
  releaseDate: string | null;
  comingSoon: boolean;
  releaseText: string | null;
  isFree: boolean;
  priceCents: number | null;
  regularCents: number | null;
  discount: number;
  currency: string | null;
  /** Steam's own formatted price. */
  priceText: string | null;
  /** Not sold on its own (yet). */
  notSold: boolean;
  /** Lowest price ever, from `lowestSource`. */
  lowestCents: number | null;
  lowestCurrency: string | null;
  lowestSource: 'itad' | 'cheapshark' | null;
  lowestAt: string | null;
  /** Steam prices VYSTRAL has seen, oldest first (one point per day, flat runs compacted). */
  history: WishlistPoint[];
  /** Header image through the art host, or null. */
  header: string | null;
  /** The VYSTRAL game when it's already in the library. */
  gameId: string | null;
  pricedAt: string | null;
}

export type WishlistStatus =
  | 'ok' | 'empty' | 'off' | 'notConnected' | 'noAccount' | 'offline' | 'invalidKey' | 'unavailable' | 'rateLimited' | 'notLoaded';

export interface Wishlist {
  status: WishlistStatus;
  message: string | null;
  fetchedAt: string | null;
  /** The latest refresh didn't finish; these are the last results. */
  stale: boolean;
  refreshing: boolean;
  count: number;
  items: WishlistItem[];
  retryAt: string | null;
  country: string;
  /** Where "lowest ever" comes from, as a name ("IsThereAnyDeal", "CheapShark"), or null when no source is on. */
  lowestSource: string | null;
}

export interface WishlistRefreshResult {
  started: boolean;
  reason: 'off' | 'notConnected' | 'noAccount' | 'offline' | 'gameRunning' | 'dataSaver' | 'recent' | 'running' | null;
  wishlist: Wishlist;
}

/** A friend who played the game in the last two weeks. `key` is opaque; `avatar` is an art-host URL or null. */
export interface FriendPlayed {
  key: string;
  name: string;
  avatar: string | null;
  minutesTwoWeeks: number;
}

export type FriendsHistoryStatus =
  | 'ok' | 'off' | 'notConnected' | 'noAccount' | 'offline' | 'private' | 'invalidKey' | 'unavailable' | 'rateLimited' | 'notLoaded' | 'notSteam';

export interface FriendsHistory {
  status: FriendsHistoryStatus;
  message: string | null;
  fetchedAt: string | null;
  refreshing: boolean;
  friends: FriendPlayed[];
  totalMinutes: number;
  /** Public profiles read in the last round, of `publicFriends`. */
  checked: number;
  publicFriends: number;
  friendCount: number;
}

export interface GuideAchievement {
  apiName: string;
  name: string;
  /** Null for hidden achievements until revealed. */
  description: string | null;
  hidden: boolean;
  globalPercent: number | null;
  icon: string | null;
  achieved: boolean;
  unlockedAt: string | null;
}

export interface AchievementGuide {
  status: import('./types').AchievementsStatus;
  message: string | null;
  total: number;
  unlocked: number;
  hiddenLocked: number;
  /** Locked achievements, easiest (most common) first. */
  next: GuideAchievement[];
  goal: GuideAchievement | null;
  fetchedAt: string | null;
}

export interface NewsSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export interface NewsBlock {
  kind: 'p' | 'h' | 'li' | 'quote' | 'code' | 'img' | 'hr';
  spans: NewsSpan[];
  /** For images: an art-host URL once loaded, else null. */
  image: string | null;
  imageId: string | null;
}

export interface NewsPost {
  gid: string;
  title: string;
  author: string | null;
  date: string;
  /** Tagged as patch notes, or titled like an update. */
  patch: boolean;
  excerpt: string;
  blocks: NewsBlock[];
  images: number;
  imagesLoaded: number;
}

export type NewsStatus = 'ok' | 'none' | 'off' | 'notSteam' | 'offline' | 'unavailable' | 'rateLimited';

export interface NewsFeed {
  status: NewsStatus;
  message: string | null;
  fetchedAt: string | null;
  stale: boolean;
  posts: NewsPost[];
}
