/**
 * Track C4 preview handlers: review snapshot, store facts with a price history, community tags, the franchise
 * timeline and achievement progress. Everything here is FICTIONAL (preview never touches the network); covers are
 * locally drawn placeholders.
 *
 * URL switches:
 * - `?reviews` shows Steam review snapshots on Steam games (both pages); `?reviews=down` makes recent reviews drop,
 *   `?reviews=few` has too few recent reviews for a trend, `?reviews=offline` shows saved ones in Offline mode.
 * - `?tags` shows community tags on game pages and fills the Library's tag filter; `?tags=loading` is still filling.
 * - `?franchise` shows series timelines (Starfall Tactics, Ashen Crown, Nebula Drift and their Discover pages);
 *   `?franchise=noKey` acts as if IGDB isn't connected, `?franchise=none` as if the game has no series.
 * Store facts (price, Metacritic, release) and achievement progress need no switch: they follow the settings.
 */
import type {
  AchievementProgress, CommunityTag, Deals, DiscoverDetails, Franchise, FranchiseEntry, Game, GameTags, LibraryTags, PricePoint, ReviewsSnapshot,
  Settings, StoreFacts,
} from './types';
import { placeholderArt } from './preview.dataSources';
import { previewSteamAppFor } from './preview.identity';

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
  timers: number[];
  deals: (gameId: string) => Deals;
  discoverDetails: (key: string) => DiscoverDetails | null;
}

export const GAME_PAGE_DEFAULT_SETTINGS: Pick<Settings, 'dataSources.steamReviews' | 'dataSources.steamTags'> = {
  'dataSources.steamReviews': true,
  'dataSources.steamTags': true,
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const TAGS: [number, string][] = [
  [19, 'Action'], [21, 'Adventure'], [122, 'RPG'], [9, 'Strategy'], [599, 'Simulation'], [492, 'Indie'], [1662, 'Survival'], [1695, 'Open World'],
  [1716, 'Roguelike'], [3843, 'Online Co-Op'], [1685, 'Co-op'], [4182, 'Singleplayer'], [3859, 'Multiplayer'], [1742, 'Story Rich'], [4166, 'Atmospheric'],
  [3942, 'Sci-fi'], [1684, 'Fantasy'], [1667, 'Horror'], [1664, 'Puzzle'], [1625, 'Platformer'], [699, 'Racing'], [1644, 'Driving'], [701, 'Sports'],
  [1663, 'FPS'], [1708, 'Tactical'], [1741, 'Turn-Based Strategy'], [1755, 'Space'], [4604, 'Dark Fantasy'], [29482, 'Souls-like'], [3871, '2D'],
  [4191, '3D'], [4136, 'Funny'], [6650, 'Nudity-free'], [1773, 'Arcade'], [5611, 'Mature'], [3834, 'Exploration'], [4747, 'Character Customization'],
];
const TAG_NAME = new Map(TAGS);
/** Genre → the tags players would likely apply. */
const GENRE_TAGS: Record<string, number[]> = {
  Racing: [699, 1644, 1773], 'Sci-fi': [3942, 4166], RPG: [122, 1742, 4747], Fantasy: [1684, 4604], Horror: [1667, 4166, 5611], Adventure: [21, 3834],
  Strategy: [9, 1708, 1741], Space: [1755, 3942], Action: [19], Indie: [492, 3871], Platformer: [1625, 3871], Survival: [1662, 1695], 'Open World': [1695, 3834],
  Shooter: [1663, 19], Multiplayer: [3859, 3843], Simulation: [599], Puzzle: [1664], Sports: [701], Casual: [4136], Exploration: [3834],
};

const steamAppOf = (g: Game) => g.installations.find((i) => i.platform === 'steam')?.platformGameId ?? null;

/** Fictional series: owned games by library title, the others by their Discover catalogue key. */
const SERIES: { name: string; kind: 'series' | 'franchise'; games: { name: string; year: number | null; type?: FranchiseEntry['type']; key?: string }[] }[] = [
  {
    name: 'Starfall', kind: 'series',
    games: [
      { name: 'Starfall Tactics', year: 2019 }, { name: 'Deep Field', year: 2021, type: 'expanded' },
      { name: 'Starfall Tactics II', year: 2025, key: 'steam-9000001' }, { name: 'Children of the Comet', year: 2027, key: 'steam-9000014' },
    ],
  },
  {
    name: 'Ashen Crown', kind: 'series',
    games: [{ name: 'Crown of Cinders', year: 2012, key: 'steam-9000016' }, { name: 'Ashen Crown', year: 2021 }, { name: 'Wyrmspire', year: 2023 }],
  },
  {
    name: 'Nebula Drift', kind: 'franchise',
    games: [{ name: 'Nebula Drift', year: 2018 }, { name: 'Nebula Drift: Overdrive', year: 2026, key: 'steam-9000002' }],
  },
];

export function gamePagePreviewHandlers(ctx: Ctx) {
  const params = new URLSearchParams(location.search);
  const reviewsMode = params.has('reviews') ? params.get('reviews') || 'on' : null;
  const tagsMode = params.has('tags') ? params.get('tags') || 'on' : null;
  const franchiseMode = params.has('franchise') ? params.get('franchise') || 'on' : null;
  let tagsReady = tagsMode !== 'loading';
  const find = (id: string) => ctx.lib.games.find((g) => g.id === id) ?? null;
  const coverNames = new Map<string, string>();

  /** The Steam app a request is about: a library game's, or a Discover page's. */
  const appIdOf = (p: { gameId?: string; key?: string; appId?: string | null }): string | null => {
    if (p.gameId) {
      const g = find(p.gameId);
      return g ? steamAppOf(g) ?? previewSteamAppFor(g, ctx.settings())?.appId ?? null : null; // Track D4: matched Steam apps too
    }
    return p.appId ?? (p.key?.startsWith('steam-') ? p.key.slice(6) : null);
  };

  const fetchedAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

  const reviews = (p: { gameId?: string; key?: string; appId?: string | null }): ReviewsSnapshot => {
    const s = ctx.settings();
    const appId = appIdOf(p);
    const empty = (status: ReviewsSnapshot['status'], message: string | null = null): ReviewsSnapshot =>
      ({ status, message, appId, allTime: null, recent: null, trend: null, trendPoints: null, fetchedAt: null, stale: false });
    if (!s['dataSources.steamReviews'] || !s['library.fetchMetadata']) return empty('off');
    if (!appId) return empty('notSteam');
    if (!reviewsMode) return empty('none');
    if (s['privacy.localOnly'] && reviewsMode !== 'offline') return empty('offline', 'Offline mode is on, so VYSTRAL doesn’t ask Steam for reviews.');
    const r = seeded(hash(`${appId}reviews`));
    const title = p.gameId ? find(p.gameId)?.title : ctx.discoverDetails(p.key ?? '')?.title;
    const total = Math.round(400 + r() * 60_000);
    const allPct = title === 'Overclock Arena' ? 64 : 72 + r() * 25;
    const recentTotal = reviewsMode === 'few' ? 4 : Math.round(30 + r() * 900);
    const drift = reviewsMode === 'down' || title === 'Overclock Arena' ? -(12 + r() * 10) : (r() - 0.35) * 12;
    const recentPct = Math.max(5, Math.min(99.5, allPct + drift));
    const score = (pct: number, n: number) => {
      const label = n < 10 ? `${n} user reviews` : pct >= 95 && n >= 500 ? 'Overwhelmingly Positive' : pct >= 80 ? 'Very Positive' : pct >= 70 ? 'Mostly Positive' : pct >= 40 ? 'Mixed' : pct >= 20 ? 'Mostly Negative' : 'Negative';
      return { score: n < 10 ? 0 : pct >= 80 ? 8 : pct >= 70 ? 7 : pct >= 40 ? 5 : 3, label, positive: Math.round((pct / 100) * n), total: n, percent: Math.round(pct * 10) / 10 };
    };
    const allTime = score(allPct, total);
    const recent = score(recentPct, recentTotal);
    const points = recentTotal >= 10 ? Math.round((recent.percent - allTime.percent) * 10) / 10 : null;
    return {
      status: reviewsMode === 'offline' ? 'offline' : 'ok', message: reviewsMode === 'offline' ? 'Offline mode is on, so these are the reviews saved on this PC.' : null,
      appId, allTime, recent, trend: points == null ? null : points >= 3 ? 'up' : points <= -3 ? 'down' : 'steady', trendPoints: points,
      fetchedAt: fetchedAgo(reviewsMode === 'offline' ? 60 * 30 : 35), stale: reviewsMode === 'offline',
    };
  };

  const toCents = (s: string | null | undefined) => (s && /^\$\d+(\.\d{2})?$/.test(s) ? Math.round(Number(s.slice(1)) * 100) : null);

  const storeFacts = (p: { gameId?: string; key?: string; appId?: string | null }): StoreFacts => {
    const s = ctx.settings();
    const country = s['dataSources.priceCountry'] || 'US';
    const appId = appIdOf(p);
    const base: StoreFacts = {
      status: 'ok', message: null, country, appId, sold: false, priceCents: null, regularCents: null, discount: 0, currency: null, priceText: null,
      metacritic: null, releaseText: null, comingSoon: false, history: [], fetchedAt: null, stale: false,
    };
    if (!s['dataSources.storePrices']) return { ...base, status: 'off' };
    if (!appId) return { ...base, status: 'notSteam', appId: null };
    if (s['privacy.localOnly']) return { ...base, status: 'offline', message: 'Offline mode is on, so VYSTRAL doesn’t ask Steam for prices.' };
    const r = seeded(hash(`${appId}store`));
    let now: number | null;
    let regular: number | null;
    let metacritic: number | null = null;
    let release: string | null = null;
    let comingSoon = false;
    if (p.gameId) {
      const g = find(p.gameId)!;
      const quote = ctx.deals(g.id).quotes[0];
      const reg = quote?.offers[0]?.regular ?? null;
      regular = reg != null ? Math.round(reg * 100) : null;
      const steamOffer = quote?.offers.find((o) => o.shop === 'Steam');
      now = steamOffer ? Math.round(steamOffer.price * 100) : regular;
      metacritic = r() > 0.35 ? 64 + Math.floor(r() * 32) : null;
      release = g.releaseDate ? `${1 + Math.floor(r() * 27)} ${['Jan', 'Mar', 'Apr', 'Jun', 'Sep', 'Nov'][Math.floor(r() * 6)]}, ${g.releaseDate.slice(0, 4)}` : null;
    } else {
      const d = ctx.discoverDetails(p.key ?? `steam-${appId}`);
      now = toCents(d?.price?.formatted);
      regular = toCents(d?.price?.initial) ?? now;
      metacritic = d?.metacritic ?? null;
      comingSoon = !!d?.price?.comingSoon;
      release = comingSoon ? 'Coming soon' : d?.year ? `${d.year}` : null;
    }
    if (now == null) return { ...base, releaseText: release, comingSoon, metacritic, fetchedAt: fetchedAgo(20) };
    // Ninety days of fictional history: the regular price with one or two sales, ending at today's price.
    const history: PricePoint[] = [];
    const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
    const reg = regular ?? now;
    history.push({ day: day(92), cents: reg });
    const saleAt = 40 + Math.floor(r() * 30);
    history.push({ day: day(saleAt), cents: Math.round(reg * (0.5 + r() * 0.25)) });
    history.push({ day: day(saleAt - 10), cents: reg });
    if (now !== reg) history.push({ day: day(3), cents: now });
    return {
      ...base, sold: true, priceCents: now, regularCents: reg, discount: reg > now ? Math.round((1 - now / reg) * 100) : 0, currency: 'USD',
      priceText: `$${(now / 100).toFixed(2)}`, metacritic, releaseText: release, comingSoon, history, fetchedAt: fetchedAgo(20),
    };
  };

  const tagsFor = (appId: string, genres: string[]): CommunityTag[] => {
    const r = seeded(hash(`${appId}tags`));
    const ids = [...new Set([...genres.flatMap((g) => GENRE_TAGS[g] ?? []), 4182, ...TAGS.map(([id]) => id).filter(() => r() > 0.86)])].slice(0, 14);
    return ids.map((id, i) => ({ id, name: TAG_NAME.get(id)!, weight: Math.round(620 - i * (18 + r() * 25)) })).sort((a, b) => b.weight - a.weight);
  };

  const gameTags = (p: { gameId?: string; key?: string; appId?: string | null }): GameTags => {
    const s = ctx.settings();
    const appId = appIdOf(p);
    if (!s['dataSources.steamTags'] || !s['library.fetchMetadata']) return { status: 'off', message: null, tags: [], fetchedAt: null, stale: false };
    if (!appId) return { status: 'notSteam', message: null, tags: [], fetchedAt: null, stale: false };
    if (!tagsMode) return { status: 'none', message: null, tags: [], fetchedAt: null, stale: false };
    const genres = p.gameId ? find(p.gameId)?.genres ?? [] : ctx.discoverDetails(p.key ?? '')?.genres ?? [];
    return { status: 'ok', message: null, tags: tagsFor(appId, genres), fetchedAt: fetchedAgo(60 * 26), stale: false };
  };

  const libraryTags = (): LibraryTags => {
    const s = ctx.settings();
    const steamGames = ctx.lib.games.filter((g) => steamAppOf(g));
    if (!s['dataSources.steamTags'] || !s['library.fetchMetadata']) return { status: 'off', message: null, tags: [], games: {}, covered: 0, steamGames: steamGames.length, refreshing: false, fetchedAt: null };
    if (!tagsMode) return { status: 'ok', message: null, tags: [], games: {}, covered: 0, steamGames: steamGames.length, refreshing: false, fetchedAt: null };
    if (!tagsReady) {
      ctx.timers.push(window.setTimeout(() => { tagsReady = true; ctx.emit()('tags.changed', { done: steamGames.length }); }, 1500));
      return { status: 'ok', message: null, tags: [], games: {}, covered: 0, steamGames: steamGames.length, refreshing: true, fetchedAt: null };
    }
    const games: Record<string, number[]> = {};
    const counts = new Map<number, number>();
    for (const g of steamGames) {
      const ids = tagsFor(steamAppOf(g)!, g.genres).map((t) => t.id);
      games[g.id] = ids;
      for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const tags = [...counts].sort((a, b) => b[1] - a[1] || TAG_NAME.get(a[0])!.localeCompare(TAG_NAME.get(b[0])!)).map(([id, count]) => ({ id, name: TAG_NAME.get(id)!, count }));
    return { status: 'ok', message: null, tags, games, covered: steamGames.length, steamGames: steamGames.length, refreshing: false, fetchedAt: fetchedAgo(60 * 26) };
  };

  const franchise = (p: { gameId?: string; key?: string }): Franchise => {
    const s = ctx.settings();
    const empty = (status: Franchise['status'], message: string | null = null): Franchise => ({ status, message, name: null, kind: null, entries: [], owned: 0, fetchedAt: null, stale: false });
    if (s['privacy.localOnly']) return empty('offline', 'Offline mode is on, so VYSTRAL doesn’t ask IGDB.');
    if (!s['dataSources.enrichment']) return empty('off');
    if (franchiseMode === 'noKey') return empty('noKey');
    if (!franchiseMode || franchiseMode === 'none') return empty('none');
    const title = p.gameId ? find(p.gameId)?.title : null;
    const series = SERIES.find((x) => x.games.some((g) => (title ? g.name === title && !g.key : g.key === p.key)));
    if (!series) return empty('none');
    const entries: FranchiseEntry[] = series.games.map((g, i) => {
      const owned = g.key ? null : ctx.lib.games.find((x) => x.title === g.name) ?? null;
      const igdbId = String(880000 + (hash(g.name) % 9000) * 10 + i);
      coverNames.set(igdbId, g.name);
      return {
        igdbId, name: g.name, date: g.year ? `${g.year}-0${(i % 8) + 1}-1${i}` : null, year: g.year, type: g.type ?? 'main',
        gameId: owned?.id ?? null, discoverKey: g.key ?? `igdb-${880000 + i}`, current: title ? g.name === title : g.key === p.key, hasCover: true,
      };
    });
    return { status: 'ok', message: null, name: series.name, kind: series.kind, entries, owned: entries.filter((e) => e.gameId).length, fetchedAt: fetchedAgo(60 * 50), stale: false };
  };

  return {
    'reviews.get': reviews,
    'reviews.open': () => true,
    'store.facts': storeFacts,
    'tags.get': gameTags,
    'tags.library': libraryTags,
    'franchise.get': franchise,
    'franchise.cover': (p: { igdbId: string }) => ({ url: placeholderArt('cover', coverNames.get(p.igdbId) ?? p.igdbId, 0, 'alternate'), reason: null }),
    'gamePage.achievements': (p: { gameId: string }): AchievementProgress | null => {
      const g = find(p.gameId);
      if (!g || !steamAppOf(g) || g.title === 'Glasswing' || g.title === 'Last Signal') return null;
      const r = seeded(hash(`${g.id}ach`));
      const total = 12 + Math.floor(r() * 50);
      const unlocked = Math.floor(total * r());
      return { unlocked, total, fetchedAt: fetchedAgo(40), rarestName: unlocked ? 'Against the Odds' : null, rarestPercent: unlocked ? Math.round(r() * 60) / 10 + 0.4 : null };
    },
  };
}
