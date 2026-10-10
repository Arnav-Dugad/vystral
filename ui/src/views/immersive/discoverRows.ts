/**
 * Track C6: Immersive Discover — the rows for games you don't own. Pure, so what shows (and the words for every
 * state: searching, nothing found, offline, search off) is unit-tested. The view feeds it what the existing Discover
 * bridge methods answered (discover.search, discover.watching) plus the opt-in Steam wishlist when it's already
 * loaded; nothing here asks the network for anything.
 */
import type { DiscoverDetails, DiscoverResult, DiscoverSearch, DiscoverWatch, Game, PlatformKey, WishlistItem } from '../../bridge/types';
import { formatStorePrice, hoursLabel } from '../../lib/discover';
import { sentence } from '../../lib/voiceover';
import { formatDate, plural } from '../../lib/format';
import { playedSeconds, type Row, type Tile } from './rows';

/** A game you don't own, as a card: from a search, your Watching list or your Steam wishlist. */
export interface DiscoverItem {
  key: string;
  title: string;
  year: number | null;
  /** Cover art URL when already known; otherwise asked for lazily. */
  cover: string | null;
  genres: string[];
  stores: PlatformKey[];
  /** "$29.99" / "Free", or null when unknown. */
  price: string | null;
  /** Percent off, 0 when not on sale. */
  cut: number;
  source: 'result' | 'watching' | 'wishlist';
  /** One short extra line ("Watching since 3 Mar", "$29.99 when you started watching"). */
  note: string | null;
  /** An add-on, soundtrack or the like. */
  extra: boolean;
}

export type NoteAction = 'turnOn' | 'retry' | 'more' | 'search';

export interface DiscoverInput {
  /** The text you searched for (null: nothing searched yet). */
  query: string | null;
  search: DiscoverSearch | null;
  busy: boolean;
  error: string | null;
  loadingMore: boolean;
  /** Why searching is unavailable: Offline mode, or searching stores is turned off. */
  reason: 'offline' | 'off' | null;
  preview: boolean;
  watching: DiscoverWatch[] | null;
  /** The Steam wishlist when it's on and loaded; null otherwise. */
  wishlist: WishlistItem[] | null;
  /** Your library (visible games), for "In your library" matches and series ideas. */
  library: readonly Game[];
  now?: Date;
}

const MAX_RESULTS = 48;
const MAX_WISHLIST = 24;
const MAX_IDEAS = 6;

export function fromResult(r: DiscoverResult, watchingKeys: ReadonlySet<string>): DiscoverItem {
  const price = formatStorePrice(r.price);
  return {
    key: r.key, title: r.title, year: r.year, cover: r.cover, genres: r.genres, stores: r.stores,
    price: price?.now ?? null, cut: price?.cut ?? 0, source: 'result', extra: r.kind === 'extra',
    note: watchingKeys.has(r.key) ? 'On your Watching list' : null,
  };
}

export function fromWatch(w: DiscoverWatch): DiscoverItem {
  return {
    key: w.key, title: w.title, year: w.year, cover: w.cover, genres: [], stores: w.steamAppId ? ['steam'] : [],
    price: null, cut: 0, source: 'watching', extra: false,
    note: w.priceWhenAdded ? `${w.priceWhenAdded} when you started watching` : `Watching since ${formatDate(w.addedAt)}`,
  };
}

export function fromWishlist(w: WishlistItem): DiscoverItem | null {
  if (!/^\d{1,10}$/.test(w.appId) || w.gameId) return null;
  const cut = w.discount > 0 ? Math.round(w.discount) : 0;
  return {
    key: `steam-${w.appId}`, title: w.name, year: w.releaseDate ? new Date(w.releaseDate).getFullYear() : null, cover: null, genres: [], stores: ['steam'],
    price: w.isFree ? 'Free' : w.priceText, cut, source: 'wishlist', extra: false,
    note: w.comingSoon ? (w.releaseText ? `Coming ${w.releaseText}` : 'Coming soon') : cut ? `${cut}% off on Steam` : null,
  };
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Library games whose title holds every typed word (the start of a word), best matches first. */
export function libraryMatches(games: readonly Game[], query: string, limit = 12): Game[] {
  const words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const scored: { g: Game; score: number }[] = [];
  for (const g of games) {
    if (g.hidden) continue;
    const t = fold(g.title);
    const tw = t.split(' ');
    if (!words.every((w) => tw.some((x) => x.startsWith(w)))) continue;
    scored.push({ g, score: (t.startsWith(fold(query)) ? 2 : 0) + (t === fold(query) ? 3 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || a.g.title.localeCompare(b.g.title)).slice(0, limit).map((x) => x.g);
}

const ROMAN = /\s+(?:[ivx]{1,4}|\d{1,4})$/i;
const EDITION = /\s+(?:remastered|remake|definitive edition|goty|game of the year edition|complete edition|anniversary edition|deluxe edition|enhanced edition|hd)$/i;

/** The series part of a title: "Ashen Crown II: Embers" → "Ashen Crown". Null when there's nothing distinctive left. */
export function seriesName(title: string): string | null {
  let t = title.replace(/[™®©]/g, '').split(/\s*(?::|\s[-–—]\s)\s*/)[0].trim();
  for (let i = 0; i < 3; i++) t = t.replace(EDITION, '').replace(ROMAN, '').trim();
  t = t.replace(/^the\s+/i, (m) => (t.length > 12 ? '' : m)).trim();
  if (t.length < 3 || /^\d+$/.test(t)) return null;
  return t;
}

/**
 * Search ideas from your own library: the series of the games you play most, so a search finds sequels, prequels
 * and spin-offs you don't own yet. Deterministic and offline (no recommendation service is asked).
 */
export function seriesIdeas(games: readonly Game[], max = MAX_IDEAS): { query: string; sample: Game }[] {
  const out: { query: string; sample: Game }[] = [];
  const seen = new Set<string>();
  const played = games.filter((g) => !g.hidden && playedSeconds(g) > 0).sort((a, b) => playedSeconds(b) - playedSeconds(a) || a.title.localeCompare(b.title));
  for (const g of played) {
    const name = seriesName(g.title);
    if (!name) continue;
    const k = fold(name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ query: name, sample: g });
    if (out.length >= max) break;
  }
  return out;
}

const note = (key: string, title: string, body: string, action: NoteAction | null = null, busy = false): Tile => ({ kind: 'note', key, title, body, action, busy });

/** The Discover section's rows, top to bottom. */
export function discoverRows(input: DiscoverInput): Row[] {
  const { query, search, busy, error, loadingMore, reason, watching, wishlist, library } = input;
  const rows: Row[] = [];
  const watchingKeys = new Set((watching ?? []).map((w) => w.key));

  // 1. Find: the search card, or why searching other stores isn't possible right now.
  const find: Tile[] = [{ kind: 'search', key: 'find', query: null, label: query ? `“${query}”` : 'Search any game', sample: null }];
  if (reason === 'offline') find.push(note('offline', 'Offline mode is on', 'VYSTRAL isn’t contacting any store or game database, so only your library can be searched. Turn Offline mode off in desktop Settings › Privacy.'));
  else if (reason === 'off') find.push(note('off', 'Searching stores is off', 'Turn it on to also search Steam, Wikidata and, with your own keys, IGDB and RAWG.', 'turnOn'));
  rows.push({
    id: 'disc-find', kind: 'discover', title: 'Find a game',
    meta: input.preview ? 'Preview · fictional games' : reason ? 'Your library only' : 'Steam, IGDB, RAWG and Wikidata', tiles: find,
  });

  // 2. Results for what you searched.
  if (query) {
    const owned = libraryMatches(library, query);
    const ownedIds = new Set(owned.map((g) => g.id));
    const remote = search?.results ?? [];
    for (const r of remote) {
      const g = r.libraryGameId ? library.find((x) => x.id === r.libraryGameId) : undefined;
      if (g && !ownedIds.has(g.id) && !g.hidden) {
        owned.push(g);
        ownedIds.add(g.id);
      }
    }
    if (!reason) {
      const rest = remote.filter((r) => !r.libraryGameId)
        // Games first, then add-ons and soundtracks.
        .sort((a, b) => Number(a.kind === 'extra') - Number(b.kind === 'extra'))
        .slice(0, MAX_RESULTS);
      const tiles: Tile[] = rest.map((r) => ({ kind: 'discover', key: `res-${r.key}`, item: fromResult(r, watchingKeys) }));
      if (error) tiles.push(note('error', 'The search didn’t finish', error, 'retry'));
      else if (busy && tiles.length === 0) for (let i = 0; i < 4; i++) tiles.push(note(`pending-${i}`, 'Searching…', 'Asking Steam and the game databases.', null, true));
      else if (search?.done && tiles.length === 0) tiles.push(note('none', 'Nothing found', nothingBody(query, search), 'search'));
      else if (search?.done && search.hasMore) tiles.push(note('more', loadingMore ? 'Loading more…' : 'Show more results', 'Ask the sources for the next page.', 'more', loadingMore));
      const shown = rest.length;
      rows.push({
        id: 'disc-results', kind: 'discover', title: `Results for “${query}”`,
        meta: busy ? (shown ? `${plural(shown, 'game')} so far · searching…` : 'Searching…') : error ? 'Search failed' : shown ? plural(shown, 'game') : 'Nothing found',
        tiles,
      });
    }
    if (owned.length) {
      rows.push({ id: 'disc-owned', kind: 'discover', title: 'Already in your library', meta: plural(owned.length, 'game'), tiles: owned.map((g) => ({ kind: 'game', key: `own-${g.id}`, game: g })) });
    }
  }

  // 3. Watching.
  if (watching) {
    rows.push({
      id: 'disc-watching', kind: 'discover', title: 'Watching', meta: watching.length ? plural(watching.length, 'game') : undefined,
      tiles: watching.length
        ? watching.map((w) => ({ kind: 'discover', key: `watch-${w.key}`, item: fromWatch(w) }))
        : [note('watch-empty', 'Nothing watched yet', 'Open a game here and press Y to watch it. Prices are checked when you open its page; nothing runs in the background.')],
    });
  }

  // 4. Your Steam wishlist (when it's on and loaded), games you don't own yet.
  const wish = (wishlist ?? [])
    .slice()
    .sort((a, b) => (a.priority || 1e9) - (b.priority || 1e9) || a.name.localeCompare(b.name))
    .flatMap((w) => { const it = fromWishlist(w); return it && !watchingKeys.has(it.key) ? [it] : []; })
    .slice(0, MAX_WISHLIST);
  if (wish.length) rows.push({ id: 'disc-wishlist', kind: 'discover', title: 'On your Steam wishlist', meta: plural(wish.length, 'game'), tiles: wish.map((it) => ({ kind: 'discover', key: `wish-${it.key}`, item: it })) });

  // 5. Ideas from the series you play most.
  const ideas = seriesIdeas(library);
  if (ideas.length && !reason) {
    rows.push({
      id: 'disc-ideas', kind: 'discover', title: 'More from series you play', meta: 'Search for sequels and spin-offs',
      tiles: ideas.map((i) => ({ kind: 'search', key: `idea-${i.query}`, query: i.query, label: i.query, sample: i.sample })),
    });
  }
  return rows;
}

function nothingBody(query: string, search: DiscoverSearch): string {
  const failed = search.sources.filter((s) => s.state === 'failed').map((s) => s.name);
  if (failed.length) return `${failed.join(' and ')} couldn’t answer, and the others found nothing for “${query}”. Try again in a moment, or with fewer words.`;
  return `No other game called “${query}” was found. Check the spelling, or try fewer words.`;
}

/** What voice-over says for a Discover card. */
export function discoverItemSpeech(it: DiscoverItem): string {
  const parts = [
    it.title,
    it.year ? String(it.year) : null,
    it.extra ? 'Add-on' : null,
    it.price ? (it.cut ? `${it.price}, ${it.cut} percent off` : it.price) : null,
    it.source === 'watching' ? 'On your Watching list' : it.source === 'wishlist' ? 'On your Steam wishlist' : it.note,
    'Not in your library',
  ].filter(Boolean);
  return parts.join('. ');
}

/** The words a page says when it opens (and the focus line under the title). Exported for tests. */
export function pageSummary(d: DiscoverDetails, watching: boolean): string {
  const price = d.price?.free ? 'Free to play' : d.price?.formatted ? `${d.price.formatted} on Steam${d.price.discountPercent ? `, ${d.price.discountPercent} percent off` : ''}` : d.price?.comingSoon ? 'Not out yet' : null;
  const ttb = hoursLabel(d.timeToBeat?.hastilySeconds) ?? hoursLabel(d.timeToBeat?.normallySeconds);
  return sentence(
    d.title,
    d.libraryGameId ? 'In your library' : 'Not in your library',
    price,
    ttb ? `About ${ttb.replace(' h', ' hours').replace(' min', ' minutes')} to beat` : null,
    watching ? 'Watching. Press Y to stop watching' : 'Press Y to watch it',
  );
}
