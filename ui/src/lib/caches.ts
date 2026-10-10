/** Track D6: what each cache is, in plain words, and how the viewer describes its size and age. */
import type { CacheInfo } from '../bridge/types';
import { formatBytes, formatRelative } from './format';

export interface CacheCopy {
  name: string;
  /** What's in it. */
  what: string;
  /** What clearing it means, beyond "downloaded again later". */
  after: string;
  /** Rows rather than files. */
  rows?: boolean;
}

export const CACHE_COPY: Record<string, CacheCopy> = {
  art: { name: 'Artwork', what: 'Covers, heroes and logos downloaded for your games.', after: 'Store art on this PC is imported again right away; the rest downloads as you browse. Art you picked yourself and art packs are kept.' },
  thumbs: { name: 'Thumbnails and avatars', what: 'Small pictures for news, the wishlist, Discover, art choices, friends’ avatars and subscription posters.', after: 'They download again the next time they’re shown.' },
  trailers: { name: 'Trailer loops', what: 'Short silent clips for live tiles and the screensaver. Full trailers are never stored.', after: 'Loops download again when live tiles play (not on Data saver or while a game runs).' },
  news: { name: 'News and patch notes', what: 'Steam news posts for your games.', after: 'Posts download again the next time you open a game’s news.' },
  prices: { name: 'Prices and deals', what: 'Steam prices, deals and lowest prices from IsThereAnyDeal and CheapShark.', after: 'Prices are looked up again when needed. The price history VYSTRAL recorded is kept.', rows: true },
  ai: { name: 'AI answers', what: 'Saved patch-note summaries and captions, so they aren’t asked for twice.', after: 'They’re asked for again only when you use those AI features.' },
  discover: { name: 'Discover', what: 'Store shelves, similar games and search answers.', after: 'Shelves and searches load fresh next time. Your Watching list is kept.', rows: true },
  tags: { name: 'Community tags', what: 'Steam’s community tags for your games.', after: 'Tags download again in the background.' },
  friends: { name: 'Friends’ recent games', what: 'What your Steam friends played recently.', after: 'It’s fetched again on the next refresh.' },
  wishlist: { name: 'Wishlist details', what: 'Store details, pictures and lowest prices for your wishlist.', after: 'Details download again on the next sync. Your wishlist, its price history and sent alerts are kept.' },
  catalogs: { name: 'Subscription and cloud catalogues', what: 'Game Pass and GeForce NOW lists, and Microsoft Store names.', after: 'Lists download again on the next daily refresh. Your plans and settings are kept.', rows: true },
  gamePages: { name: 'Game page details', what: 'Steam review summaries and IGDB series.', after: 'They load again when you open a game. Store facts and price history are kept.' },
  lookups: { name: 'Save and mod lookups', what: 'Where games keep saves (PCGamingWiki) and Workshop item names.', after: 'They’re looked up again when you open a game’s Files tab.' },
  fx: { name: 'Exchange rates', what: 'Today’s rates for showing prices in your currency.', after: 'Rates download again right away (unless Offline mode is on); until then prices stay in their own currency.' },
  firstPaint: { name: 'Start-up snapshot', what: 'A small copy of Home so VYSTRAL paints instantly when it starts.', after: 'The next start paints from live data (a little slower once), then a new snapshot is saved.' },
};

export function cacheCopy(id: string): CacheCopy {
  return CACHE_COPY[id] ?? { name: id, what: 'Downloaded data.', after: 'It’s downloaded again when needed.' };
}

/** "412 MB · 1,834 files" / "Empty". */
export function cacheSizeLine(c: Pick<CacheInfo, 'bytes' | 'items'>, rows = false): string {
  if (c.items <= 0 && c.bytes <= 0) return 'Empty';
  const n = c.items.toLocaleString();
  const unit = rows ? (c.items === 1 ? 'entry' : 'entries') : c.items === 1 ? 'file' : 'files';
  return `${formatBytes(c.bytes)} · ${n} ${unit}`;
}

/** "Updated 2 hours ago · oldest from 3 weeks ago" (age from the newest and oldest item). */
export function cacheAgeLine(c: Pick<CacheInfo, 'newest' | 'oldest'>, now = Date.now()): string | null {
  if (!c.newest) return null;
  const newest = `Updated ${formatRelative(c.newest, now).toLowerCase()}`;
  if (!c.oldest) return newest;
  const span = Date.parse(c.newest) - Date.parse(c.oldest);
  return span > 36 * 3_600_000 ? `${newest} · oldest from ${formatRelative(c.oldest, now).toLowerCase()}` : newest;
}

export function totalBytes(list: Pick<CacheInfo, 'bytes'>[]): number {
  return list.reduce((n, c) => n + Math.max(0, c.bytes), 0);
}
