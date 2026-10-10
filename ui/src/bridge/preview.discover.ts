/**
 * Preview handlers for Track U (universal search, pages for games you don't own). Every game here is FICTIONAL and
 * every image is a locally drawn placeholder: preview mode and UI tests never touch the network. The status says
 * `preview: true`, so the page labels results as preview data.
 *
 * Switches: `?discover` (or `?discover=<text>`) opens the Discover page; `?discoverSlow` makes sources answer slowly
 * (to see the shimmer); `?discoverNoKeys` acts as if IGDB isn't connected; `?discoverFail` makes Wikidata ask to slow down.
 * Track C3: `?discoverStore` turns Steam's store shelves on; `?discoverStoreFail` makes them fail with nothing saved.
 */
import type {
  Deals, DiscoverChannel, DiscoverDetails, DiscoverFeatured, DiscoverGenrePage, DiscoverResult, DiscoverSearch, DiscoverShelf, DiscoverSimilar,
  DiscoverSourceId, DiscoverSourceState, DiscoverStatus, DiscoverWatch, Game, PlatformKey, Settings,
} from './types';
import { BridgeError } from './bridge';
import { placeholderArt } from './preview.dataSources';

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
  timers: number[];
}

export const DISCOVER_DEFAULT_SETTINGS = { 'discover.searchOnline': true, 'discover.storeShelves': false } satisfies Partial<Settings>;

/** Track C3: `?discoverStore` starts with Steam's store shelves on. */
export function previewDiscoverSettings(params: URLSearchParams): Partial<Settings> {
  return params.has('discoverStore') ? { 'discover.storeShelves': true } : {};
}

interface Entry {
  title: string;
  year: number;
  genres: string[];
  stores: PlatformKey[];
  platforms: string[];
  sources: DiscoverSourceId[];
  dev: string;
  blurb: string;
  steam?: number;
  price?: [number, number];
  kind?: 'extra';
  ttb?: [number, number, number];
  deck?: 'verified' | 'playable' | 'unsupported';
  antiCheat?: string;
  gfn?: boolean;
  xbox?: boolean;
  /** Track C3: free to play. */
  free?: boolean;
  /** Track C3: not out yet; its release date as precise as the store says (yyyy-MM-dd, yyyy-MM). */
  soon?: string;
}

const E = (title: string, year: number, genres: string[], stores: PlatformKey[], platforms: string[], sources: DiscoverSourceId[], dev: string, blurb: string, extra: Partial<Entry> = {}): Entry =>
  ({ title, year, genres, stores, platforms, sources, dev, blurb, ...extra });

const ALL: DiscoverSourceId[] = ['steam', 'igdb', 'wikidata'];
const NOT_STEAM: DiscoverSourceId[] = ['igdb', 'wikidata'];

/** Fictional games, none of them real. Steam app IDs start at 9,000,001 (far above any real one). */
const CATALOGUE: Entry[] = [
  E('Starfall Tactics II', 2025, ['Strategy', 'Space'], ['steam', 'gog'], ['PC'], ALL, 'Meridian Labs', 'The fleet returns: bigger battles, the same memory for every lost ship.', { steam: 9000001, price: [2999, 3999], ttb: [22, 38, 70], deck: 'verified', gfn: true }),
  E('Nebula Drift: Overdrive', 2026, ['Racing', 'Sci-fi'], ['steam', 'xbox'], ['PC', 'Xbox Series X|S', 'PlayStation 5'], ALL, 'Halcyon Forge', 'Anti-gravity racing, now through living nebulae.', { steam: 9000002, price: [3999, 3999], ttb: [8, 14, 30], deck: 'playable', xbox: true }),
  E('Ashen Crown', 2021, ['RPG', 'Fantasy'], ['steam', 'epic'], ['PC'], ALL, 'Ninefold Studio', 'Reclaim a burned kingdom in a sprawling, choice-driven role-playing epic.', { steam: 9000003, price: [1999, 4999] }),
  E('Kingsfall', 2014, ['Strategy', 'Fantasy'], ['steam'], ['PC'], NOT_STEAM, 'Crown & Quill', 'Medieval grand strategy.'),
  E('Lighthouse at World’s End', 2019, ['Adventure', 'Indie'], ['steam', 'gog'], ['PC', 'Mac'], ALL, 'Quiet Owl', 'Keep the last light burning while the sea forgets the shore.', { steam: 9000005, price: [1499, 1499], ttb: [4, 6, 9], deck: 'verified' }),
  E('Orbital Gardener', 2023, ['Simulation', 'Casual'], ['steam'], ['PC', 'Nintendo Switch'], ALL, 'Gravity Well', 'Grow a garden on a spinning station, one sunbeam at a time.', { steam: 9000006, price: [1999, 1999], ttb: [12, 25, 60] }),
  E('Paper Comets', 2021, ['Puzzle'], ['epic'], ['PC', 'Mac'], NOT_STEAM, 'Fold Games', 'Fold the night sky until the comets line up.', { ttb: [3, 5, 8] }),
  E('Saltmarsh Saga', 2018, ['RPG'], ['gog'], ['PC'], NOT_STEAM, 'Low Tide', 'A tactical saga told across tidal flats and drowned villages.', { ttb: [30, 55, 90] }),
  E('Tales of the Ninth Moon', 2017, ['RPG', 'Fantasy'], ['steam'], ['PC', 'PlayStation 4'], ALL, 'Thornhill', 'Nine moons, nine oaths, one very tired knight.', { steam: 9000009, price: [999, 2999], ttb: [40, 70, 120], antiCheat: 'Easy Anti-Cheat' }),
  E('Tales of Copper Hollow', 2022, ['Adventure'], ['steam', 'epic'], ['PC'], ALL, 'Little Lichen', 'A mining town with a secret under every lamp.', { steam: 9000010, price: [1799, 1799] }),
  E('Echoes of the Deep', 2024, ['Horror', 'Adventure'], ['steam'], ['PC', 'Xbox Series X|S'], ALL, 'Coldwave', 'Sonar shows you what is there. Not what is coming.', { steam: 9000011, price: [2499, 2499], ttb: [7, 10, 16], deck: 'unsupported', antiCheat: 'BattlEye', gfn: true, xbox: true }),
  E('Echoes of Starlight', 2020, ['Adventure', 'Space'], ['steam'], ['PC'], ['steam', 'igdb'], 'Prism Lane', 'Follow a signal that left its star a thousand years ago.', { steam: 9000012, price: [1299, 1299] }),
  E('Song of the Glass Sea', 2016, ['Adventure', 'Indie'], ['gog'], ['PC', 'Linux'], NOT_STEAM, 'Saltworks', 'Sail a sea that rings when the wind is right.'),
  E('Children of the Comet', 2027, ['Strategy'], ['steam'], ['PC'], ALL, 'Meridian Labs', 'Guide a colony born on a comet’s tail.', { steam: 9000014 }),
  E('Keeper of Small Things', 2015, ['Puzzle', 'Casual'], ['steam'], ['PC', 'Mac', 'iOS'], ALL, 'Bloom', 'Return lost things to their owners, very carefully.', { steam: 9000015, price: [499, 499], ttb: [2, 3, 5] }),
  E('Crown of Cinders', 2012, ['Action', 'RPG'], ['steam'], ['PC', 'Xbox 360'], ALL, 'Ninefold Studio', 'The prequel to Ashen Crown, now harder to find.', { steam: 9000016, price: [999, 999] }),
  E('Rise of the Clockwork Fox', 2019, ['Platformer'], ['steam', 'xbox'], ['PC', 'Xbox One', 'Nintendo Switch'], ALL, 'Spark Theory', 'Wind up, leap far, never stop ticking.', { steam: 9000017, price: [1499, 1999], deck: 'verified', xbox: true }),
  E('Lords of the Long Night', 2008, ['Strategy'], ['gog'], ['PC'], NOT_STEAM, 'Bastion Works', 'A winter that lasts a generation, and the lords who outlast it.'),
  E('Shadows of Kestrel Bay', 2005, ['Adventure'], ['gog'], ['PC'], ['wikidata'], 'Quiet Owl', 'A point-and-click mystery in a fog-bound harbour town.'),
  E('Masters of the Quiet Sky', 2014, ['Simulation'], ['steam'], ['PC'], ALL, 'Gravity Well', 'Glider racing over silent valleys.', { steam: 9000020, price: [799, 799] }),
  E('Heart of the Hollow Wood', 2023, ['RPG', 'Fantasy'], ['epic'], ['PC', 'PlayStation 5'], NOT_STEAM, 'Thornhill', 'The forest has a heartbeat, and it is slowing.', { ttb: [25, 45, 80] }),
  E('Riders of the Red Dune', 2021, ['Racing'], ['steam'], ['PC', 'PlayStation 5', 'Xbox Series X|S'], ALL, 'Torque Collective', 'Rally across a desert that rewrites its map every race.', { steam: 9000022, price: [2999, 4999], antiCheat: 'Easy Anti-Cheat', gfn: true }),
  E('Hymn of Ashes', 2011, ['Action'], ['steam'], ['PC'], ['steam', 'wikidata'], 'Coldwave', 'A choir of embers sings the city awake.', { steam: 9000023, price: [499, 999] }),
  E('Driftwood Diner', 2024, ['Simulation', 'Casual'], ['steam', 'epic'], ['PC', 'Nintendo Switch'], ALL, 'Little Lichen', 'Run a diner built from whatever washes ashore.', { steam: 9000024, price: [1499, 1499], ttb: [10, 18, 35], deck: 'verified' }),
  E('Polarline Freight', 2020, ['Simulation'], ['steam'], ['PC'], ALL, 'Tundra Kin', 'Haul freight across the ice before the thaw.', { steam: 9000025, price: [1999, 1999] }),
  E('Circuit Apex 2', 2026, ['Racing', 'Sports'], ['xbox'], ['PC', 'Xbox Series X|S'], NOT_STEAM, 'Gridline Interactive', 'A new season, a new calendar, the same obsession.', { xbox: true }),
  E('Glasswing Original Soundtrack', 2022, ['Indie'], ['steam'], ['PC'], ['steam'], 'Prism Lane', 'The music of Glasswing.', { steam: 9000027, price: [599, 599], kind: 'extra' }),
  E('Moonlit Mechanic', 2022, ['Simulation', 'Indie'], ['steam'], ['PC', 'Linux'], ALL, 'Spark Theory', 'Fix robots by moonlight. They pay in stories.', { steam: 9000028, price: [1299, 1299] }),
  E('Quarry of Stars', 2019, ['Strategy', 'Space'], ['steam'], ['PC'], ALL, 'Meridian Labs', 'Mine asteroids, sell starlight.', { steam: 9000029, price: [1999, 1999] }),
  E('Tower of the Tin King', 1998, ['Platformer'], ['gog'], ['PC', 'DOS'], NOT_STEAM, 'Fold Games', 'A classic climb, lovingly preserved.'),
  E('Ballad of the Brass Wolf', 2003, ['Action', 'Adventure'], ['gog'], ['PC'], NOT_STEAM, 'Saltworks', 'An outlaw ballad in brass and steam.'),
  E('Gods of the Low Tide', 2025, ['Strategy', 'Fantasy'], ['steam'], ['PC'], ALL, 'Thornhill', 'When the sea pulls back, the old gods walk.', { steam: 9000032, price: [2499, 2499] }),
  E('Scions of the Salt Crown', 2026, ['RPG'], ['epic'], ['PC', 'PlayStation 5'], NOT_STEAM, 'Ninefold Studio', 'Heirs to a crown made of the sea itself.'),
  E('Wardens of the Wildwood', 2013, ['Strategy'], ['steam'], ['PC'], ALL, 'Bastion Works', 'Defend the forest with traps, songs and very patient bears.', { steam: 9000034, price: [799, 799] }),
  E('Fragments of Aurora', 2018, ['Puzzle', 'Adventure'], ['steam', 'gog'], ['PC', 'Mac'], ALL, 'Prism Lane', 'Rebuild a sky that shattered overnight.', { steam: 9000035, price: [1199, 1199] }),
  E('Ruins of Old Meridian', 2021, ['Survival'], ['steam'], ['PC'], ALL, 'Tundra Kin', 'Scavenge a city your ancestors built and forgot.', { steam: 9000036, price: [2499, 2499] }),
  E('Garden of Forking Paths', 2016, ['Puzzle'], ['steam'], ['PC'], ALL, 'Bloom', 'Every step plants a new path.', { steam: 9000037, price: [999, 999] }),
  E('Vault of the Violet Star', 2009, ['Action'], ['steam'], ['PC'], ['steam', 'igdb'], 'Hyperthread', 'A heist in a vault orbiting a dying star.', { steam: 9000038, price: [499, 499] }),
  E('Dawn of the Paper Kings', 2024, ['Strategy', 'Casual'], ['steam', 'epic'], ['PC'], ALL, 'Fold Games', 'Fold an army, unfold an empire.', { steam: 9000039, price: [1999, 1999] }),
  E('Velvet Orbit Season Pass', 2022, ['Simulation'], ['xbox'], ['PC'], ['igdb'], 'Gravity Well', 'Extra wings for your orbital hotel.', { kind: 'extra' }),
  // Track C3: editions and add-ons (grouped under their game in results), free games and games coming soon.
  E('Starfall Tactics II Deluxe Edition', 2025, ['Strategy', 'Space'], ['steam'], ['PC'], ['steam', 'igdb'], 'Meridian Labs', 'The game, the artbook and three extra fleets.', { steam: 9000041, price: [3999, 4999] }),
  E('Starfall Tactics II: Void Armada', 2025, ['Strategy', 'Space'], ['steam'], ['PC'], ['steam', 'igdb'], 'Meridian Labs', 'A new faction and twelve missions.', { steam: 9000042, price: [999, 999], kind: 'extra' }),
  E('Skyward Rally', 2024, ['Racing', 'Sports'], ['steam'], ['PC', 'Xbox Series X|S'], ALL, 'Torque Collective', 'Free-to-play rally on floating islands.', { steam: 9000043, free: true, deck: 'playable' }),
  E('Ember League', 2023, ['Action', 'Strategy'], ['steam', 'epic'], ['PC'], ALL, 'Hyperthread', 'Five against five, every match a new map.', { steam: 9000044, free: true, antiCheat: 'Easy Anti-Cheat' }),
  E('Pocket Constellations', 2022, ['Puzzle', 'Casual'], ['steam'], ['PC', 'Mac'], ALL, 'Bloom', 'Draw the night sky, one free puzzle a day.', { steam: 9000045, free: true }),
  E('Harbor of Lost Signals', 2027, ['Adventure', 'Horror'], ['steam'], ['PC'], ALL, 'Coldwave', 'A radio station that only plays tomorrow’s news.', { steam: 9000046, soon: `${new Date().getFullYear() + 1}-03` }),
  E('Tidewright', 2027, ['Simulation', 'Strategy'], ['steam'], ['PC'], ALL, 'Low Tide', 'Build a city that floats when the sea rises.', { steam: 9000047, soon: `${new Date().getFullYear() + 1}-05-14` }),
  // Track W's fictional wishlist (same app IDs), so wishlist games open their pages in the preview too.
  E('Aurora Vanguard', 2025, ['Action', 'Sci-fi'], ['steam'], ['PC'], ['steam'], 'Northwind', 'Fly the last escort of a fleet that forgot its way home.', { steam: 2480010, price: [2999, 5999] }),
  E('Lantern Shore', 2026, ['Adventure', 'Indie'], ['steam'], ['PC'], ['steam'], 'Quiet Owl', 'A seaside mystery told by lamplight.', { steam: 2480020, price: [2499, 2499] }),
  E('Halcyon Depths', 2026, ['Survival', 'Adventure'], ['steam'], ['PC'], ['steam'], 'Coldwave', 'Dive deeper than the light goes.', { steam: 2480030 }),
  E('Saltwind Chronicle', 2024, ['RPG', 'Fantasy'], ['steam'], ['PC'], ['steam'], 'Low Tide', 'A sailing saga across salt-white seas.', { steam: 2480040, price: [1599, 3999] }),
  E('Ironbloom', 2026, ['Strategy', 'Simulation'], ['steam'], ['PC'], ['steam'], 'Gravity Well', 'Grow a forest of steel.', { steam: 2480050, price: [1999, 1999] }),
  E('Paper Lanterns II', 2027, ['Puzzle', 'Adventure'], ['steam'], ['PC'], ['steam'], 'Fold Games', 'Light the way through a folded city.', { steam: 2480060 }),
  E('Starward Couriers', 2022, ['Simulation', 'Space'], ['steam'], ['PC'], ['steam'], 'Prism Lane', 'Deliver parcels between stars, on time, mostly.', { steam: 2480070, price: [374, 1499] }),
  E('Glacier Run', 2026, ['Racing', 'Sports'], ['steam'], ['PC'], ['steam'], 'Tundra Kin', 'Free-to-play racing down melting glaciers.', { steam: 2480080, free: true }),
  E('Mirewood', 2026, ['RPG', 'Horror'], ['steam'], ['PC'], ['steam'], 'Thornhill', 'A swamp that remembers every step.', { steam: 2480090 }),
  E('Vesper Protocol', 2026, ['Action', 'Shooter'], ['steam'], ['PC'], ['steam'], 'Hyperthread', 'A heist thriller at the edge of the night.', { steam: 2480100, price: [2799, 3499] }),
  E('Clockwork Pilgrim', 2019, ['Platformer', 'Adventure'], ['steam'], ['PC'], ['steam'], 'Spark Theory', 'Wind the pilgrim and walk the world.', { steam: 2480110, price: [999, 999] }),
  // Track D2: the release calendar's extra wishlist games.
  E('Quiet Orbit', 2026, ['Adventure', 'Space'], ['steam'], ['PC'], ['steam'], 'Prism Lane', 'Keep the only lighthouse on a silent moon.', { steam: 2480130, price: [3599, 3999] }),
  E('Velvet Circuit', 2026, ['Racing'], ['steam'], ['PC'], ['steam'], 'Torque Collective', 'Night races through a city of neon velvet.', { steam: 2480140 }),
  E('Granite Saga', 2026, ['RPG', 'Fantasy'], ['steam'], ['PC'], ['steam'], 'Thornhill', 'A mountain kingdom carved one legend at a time.', { steam: 2480150, price: [4999, 4999] }),
  E('Kite Season', 2027, ['Casual', 'Simulation'], ['steam'], ['PC'], ['steam'], 'Bloom', 'Build kites, read the wind, win the festival.', { steam: 2480160 }),
  E('Tidebreaker', 2026, ['Action', 'Adventure'], ['steam'], ['PC'], ['steam'], 'Low Tide', 'Hold the sea wall for one more night.', { steam: 2480170 }),
  E('Ember Atlas', 2027, ['Strategy'], ['steam'], ['PC'], ['steam'], 'Hyperthread', 'Map a continent that keeps catching fire.', { steam: 2480180 }),
  E('Northwind Relay', 2027, ['Simulation'], ['steam'], ['PC'], ['steam'], 'Northwind', 'Carry the post across the frozen north.', { steam: 2480190 }),
  E('Lumen Drift', 2028, ['Puzzle', 'Space'], ['steam'], ['PC'], ['steam'], 'Prism Lane', 'Steer light through a drifting nebula.', { steam: 2480200 }),
  E('Hollow Choir', 2027, ['Horror', 'Adventure'], ['steam'], ['PC'], ['steam'], 'Coldwave', 'An abandoned cathedral still sings at night.', { steam: 2480210 }),
  E('Moonlit Ferry', 2027, ['Adventure', 'Indie'], ['steam'], ['PC'], ['steam'], 'Quiet Owl', 'Ferry travellers across a lake that isn’t on any map.', { steam: 2480220 }),
];

const keyOf = (e: Entry) => (e.steam ? `steam-${e.steam}` : `igdb-${700000 + CATALOGUE.indexOf(e)}`);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function score(title: string, q: string): number {
  const t = fold(title);
  const f = fold(q);
  if (!f) return 0;
  if (t === f) return 100;
  if (t.startsWith(f)) return 90;
  const words = t.split(' ');
  if (words.some((w) => w.startsWith(f))) return 75;
  if (f.split(' ').every((qw) => words.some((w) => w.startsWith(qw)))) return 70;
  return t.includes(f) ? 55 : 0;
}

const NAMES: Record<DiscoverSourceId, string> = { steam: 'Steam', igdb: 'IGDB', rawg: 'RAWG', wikidata: 'Wikidata' };
const IGDB_PAGE = 8;

export function discoverPreviewHandlers(ctx: Ctx): Record<string, (p: any) => unknown> {
  const params = new URLSearchParams(location.search);
  const slow = params.has('discoverSlow') ? 6 : 1;
  const noKeys = params.has('discoverNoKeys');
  const fail = params.has('discoverFail');
  const watching: DiscoverWatch[] = [];
  const current = new Map<DiscoverChannel, { id: string; query: string; page: number; states: Map<DiscoverSourceId, DiscoverSourceState>; got: Map<DiscoverSourceId, Entry[]> }>();
  let seq = 0;

  const gate = (s: DiscoverSourceId): string | null => {
    const st = ctx.settings();
    if (st['privacy.localOnly']) return 'offline';
    if (!st['discover.searchOnline']) return 'off';
    if (s === 'steam') return st['library.fetchMetadata'] ? null : 'off';
    if (s === 'igdb') return noKeys ? 'noKey' : null;
    if (s === 'rawg') return 'noKey';
    return st['dataSources.wikidata'] ? null : 'off';
  };

  const libraryIdOf = (e: Entry) => ctx.lib.games.find((g) => fold(g.title) === fold(e.title))?.id ?? null;
  const toResult = (e: Entry, answered: DiscoverSourceId[], q: string): DiscoverResult => ({
    key: keyOf(e), title: e.title, year: e.year, stores: e.stores, platforms: e.platforms, genres: e.genres,
    sources: e.sources.filter((s) => answered.includes(s)), steamAppId: e.steam ? String(e.steam) : null, libraryGameId: libraryIdOf(e),
    price: e.price ? { finalCents: e.price[0], initialCents: e.price[1], currency: 'USD' } : null, hasCover: true, cover: null,
    score: score(e.title, q) + (e.kind === 'extra' ? -25 : 0), kind: e.kind ?? 'game',
  });

  const snapshot = (channel: DiscoverChannel): DiscoverSearch => {
    const run = current.get(channel)!;
    const answered = [...run.got.keys()];
    const seen = new Map<Entry, DiscoverSourceId[]>();
    for (const [source, list] of run.got) for (const e of list) seen.set(e, [...(seen.get(e) ?? []), source]);
    const results = [...seen.keys()].map((e) => toResult(e, answered, run.query))
      .sort((a, b) => Number(!!b.libraryGameId) - Number(!!a.libraryGameId) || b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, channel === 'bar' ? 12 : 300);
    const sources = (['steam', 'igdb', 'rawg', 'wikidata'] as DiscoverSourceId[]).map((s) => run.states.get(s)!).filter(Boolean);
    const st = ctx.settings();
    return {
      searchId: run.id, channel, query: run.query, page: run.page, sources, results, done: sources.every((s) => s.state !== 'pending'),
      hasMore: sources.some((s) => s.hasMore), reason: st['privacy.localOnly'] ? 'offline' : !st['discover.searchOnline'] ? 'off' : null,
    };
  };

  const matches = (q: string, source: DiscoverSourceId) =>
    CATALOGUE.filter((e) => e.sources.includes(source) && score(e.title, q) > 0).sort((a, b) => score(b.title, q) - score(a.title, q) || a.title.localeCompare(b.title));

  const status = (): DiscoverStatus => {
    const st = ctx.settings();
    return {
      searchOnline: st['discover.searchOnline'], localOnly: st['privacy.localOnly'], dataSaver: st['dataSaver.enabled'],
      reason: st['privacy.localOnly'] ? 'offline' : !st['discover.searchOnline'] ? 'off' : null, preview: true,
      sources: (['steam', 'igdb', 'rawg', 'wikidata'] as DiscoverSourceId[]).map((id) => ({ id, name: NAMES[id], state: gate(id) ? 'unavailable' : 'ready', reason: gate(id) })),
    };
  };

  // ---------------- Track C3: browse shelves ----------------

  const storeFail = params.has('discoverStoreFail');
  let featuredSeen = false;
  const thisYear = new Date().getFullYear();
  const later = <T,>(make: () => T, ms: number) => new Promise<T>((resolve, reject) => {
    ctx.timers.push(window.setTimeout(() => { try { resolve(make()); } catch (err) { reject(err); } }, ms * slow));
  });
  const isTwin = (e: Entry) => !!e.steam && e.steam >= 2480000 && e.steam < 2490000; // Track W's wishlist games
  const browseResult = (e: Entry): DiscoverResult => ({
    ...toResult(e, e.sources, ''), sources: ['steam'], score: 0,
    price: e.free ? null : toResult(e, e.sources, '').price,
    free: !!e.free, comingSoon: !!e.soon || e.year > thisYear, releaseDate: e.soon ?? null,
  });
  const shelf = (id: string, title: string, reason: string, list: Entry[]): DiscoverShelf | null =>
    list.length >= 3 ? { id, kind: 'store', title, reason, source: 'steam', seed: null, items: list.slice(0, 18).map(browseResult) } : null;
  const steamGames = () => CATALOGUE.filter((e) => e.steam && e.kind !== 'extra' && !isTwin(e) && !/edition$/i.test(e.title));
  const spin = (e: Entry) => (e.title.length * 7 + (e.steam ?? 0)) % 13;

  const featured = (): DiscoverFeatured => {
    const games = steamGames();
    const shelves = [
      shelf('trending', 'Trending on Steam', 'Steam’s top sellers right now', games.filter((e) => e.price && !e.soon && e.year <= thisYear).sort((a, b) => spin(a) - spin(b) || a.title.localeCompare(b.title))),
      shelf('specials', 'Deals on Steam', 'Steam’s featured discounts', games.filter((e) => e.price && e.price[0] < e.price[1])),
      shelf('newReleases', 'New releases', 'Just out on Steam', games.filter((e) => !e.soon && e.year >= thisYear - 1 && e.year <= thisYear)),
      shelf('comingSoon', 'Coming soon', 'Soon on Steam', games.filter((e) => e.soon || e.year > thisYear)),
      shelf('free', 'Free to play', 'Popular free games on Steam', games.filter((e) => e.free)),
    ].filter((s): s is DiscoverShelf => !!s);
    return { state: 'ready', reason: null, fetched: new Date(Date.now() - 40 * 60_000).toISOString(), stale: false, shelves };
  };

  const seedsOf = () => {
    const now = Date.now();
    const played = ctx.lib.games.filter((g) => !g.hidden);
    const recent = played.filter((g) => g.lastTrackedPlay && now - Date.parse(g.lastTrackedPlay) < 45 * 86_400_000)
      .sort((a, b) => Date.parse(b.lastTrackedPlay!) - Date.parse(a.lastTrackedPlay!)).slice(0, 2);
    const most = played.filter((g) => g.trackedSeconds >= 3600 && !recent.includes(g)).sort((a, b) => b.trackedSeconds - a.trackedSeconds).slice(0, 4 - recent.length);
    return [...recent.map((g) => ({ g, why: 'recent' as const })), ...most.map((g) => ({ g, why: 'mostPlayed' as const }))];
  };

  const similar = (): DiscoverSimilar => {
    const st = ctx.settings();
    const seeds = seedsOf();
    if (!seeds.length) return { state: 'noSeeds', source: null, reason: null, fetched: null, stale: false, shelves: [] };
    const source = !noKeys ? 'igdb' : st['discover.storeShelves'] ? 'steam' : null;
    if (!source) return { state: 'noSource', source: null, reason: null, fetched: null, stale: false, shelves: [] };
    if (!st['discover.searchOnline'] && !st['privacy.localOnly']) return { state: 'off', source, reason: 'off', fetched: null, stale: false, shelves: [] };
    const shown = new Set<string>();
    const shelves: DiscoverShelf[] = [];
    for (const { g, why } of seeds) {
      const genres = g.genres.map((x) => x.toLowerCase());
      const items = CATALOGUE.filter((e) => e.kind !== 'extra' && !isTwin(e) && !libraryIdOf(e) && !/edition$/i.test(e.title) && !shown.has(keyOf(e)) &&
        e.genres.some((x) => genres.includes(x.toLowerCase()))).slice(0, 12);
      if (items.length < 3) continue;
      items.forEach((e) => shown.add(keyOf(e)));
      const basis = g.genres.slice(0, 2).join(', ');
      shelves.push({
        id: `because:${g.id}`, kind: 'because', title: `Because you played ${g.title}`, source,
        reason: source === 'igdb' ? 'Similar games, according to IGDB' : `Shares Steam tags: ${basis}`,
        seed: { gameId: g.id, title: g.title, why }, items: items.map((e) => ({ ...browseResult(e), sources: source === 'igdb' ? ['igdb'] : ['steam'] })),
      });
    }
    const offline = st['privacy.localOnly'];
    return { state: offline ? 'offline' : 'ready', source, reason: offline ? 'offline' : null, fetched: new Date(Date.now() - 2 * 86_400_000).toISOString(), stale: offline, shelves };
  };

  const GENRE_MATCH: Record<string, [string, string[]]> = {
    action: ['Action', ['action']], adventure: ['Adventure', ['adventure']], rpg: ['RPG', ['rpg']], strategy: ['Strategy', ['strategy']],
    shooter: ['Shooter', ['shooter']], racing: ['Racing', ['racing']], sports: ['Sports', ['sports']], simulation: ['Simulation', ['simulation']],
    puzzle: ['Puzzle', ['puzzle']], platformer: ['Platformer', ['platformer']], fighting: ['Fighting', ['fighting']], indie: ['Indie', ['indie']],
    'open-world': ['Open world', ['survival', 'adventure']], 'co-op': ['Co-op', ['sports', 'racing']], horror: ['Horror', ['horror']],
    survival: ['Survival', ['survival']], 'sci-fi': ['Sci-fi', ['sci-fi', 'space']], fantasy: ['Fantasy', ['fantasy']], sandbox: ['Sandbox', ['simulation', 'casual']],
  };

  const genre = (p: { genre: string; page?: number }): DiscoverGenrePage => {
    const m = GENRE_MATCH[p?.genre];
    if (!m) throw new BridgeError('invalid', 'Unknown genre.');
    const st = ctx.settings();
    const source = st['discover.storeShelves'] ? 'steam' : !noKeys ? 'igdb' : null;
    const base = { genre: p.genre, label: m[0], source, reason: null, page: 0, hasMore: false, results: [] as DiscoverResult[] } satisfies Partial<DiscoverGenrePage>;
    if (!source) return { ...base, state: 'noSource' };
    if (st['privacy.localOnly']) return { ...base, state: 'offline', reason: 'offline' };
    if (source === 'igdb' && !st['discover.searchOnline']) return { ...base, state: 'off', reason: 'off' };
    const list = CATALOGUE.filter((e) => e.kind !== 'extra' && !/edition$/i.test(e.title) && (source === 'igdb' || e.steam) &&
      e.genres.some((x) => m[1].includes(x.toLowerCase())));
    return { ...base, state: 'ready', results: list.map((e) => ({ ...browseResult(e), sources: [source === 'igdb' ? 'igdb' : 'steam'] })) };
  };

  const entryOf = (key: string) => {
    const e = CATALOGUE.find((x) => keyOf(x) === key);
    if (!e) throw new BridgeError('notFound', 'None of the connected sources know this game any more.');
    return e;
  };

  return {
    'discover.status': status,
    'discover.search': (p: { query: string; channel?: DiscoverChannel; page?: number }) => {
      const q = (p.query ?? '').replace(/\s+/g, ' ').trim();
      if (q.length < 2) throw new BridgeError('invalid', 'Type at least two letters to search.');
      const channel = p.channel ?? 'page';
      let run = current.get(channel);
      const page = run && run.query === q ? Math.min(9, p.page ?? 0) : 0;
      if (!run || run.query !== q || page === 0) {
        run = { id: `s${++seq}`, query: q, page: 0, states: new Map(), got: new Map() };
        current.set(channel, run);
      }
      run.page = page;
      const thisRun = run;
      for (const s of ['steam', 'igdb', 'rawg', 'wikidata'] as DiscoverSourceId[]) {
        const why = gate(s);
        if (why) { run.states.set(s, { id: s, name: NAMES[s], state: 'skipped', reason: why, count: 0, hasMore: false }); continue; }
        if (page > 0 && (s !== 'igdb' || !run.states.get(s)?.hasMore)) continue;
        run.states.set(s, { id: s, name: NAMES[s], state: 'pending', reason: null, count: run.got.get(s)?.length ?? 0, hasMore: false });
        const delay = ({ steam: 260, igdb: 700, rawg: 0, wikidata: 1100 }[s]) * slow;
        ctx.timers.push(window.setTimeout(() => {
          if (current.get(channel) !== thisRun) return; // a newer search replaced this one
          if (s === 'wikidata' && fail) {
            thisRun.states.set(s, { id: s, name: NAMES[s], state: 'failed', reason: 'rateLimited', count: 0, hasMore: false });
          } else {
            const all = matches(q, s);
            const take = s === 'igdb' ? all.slice(0, (page + 1) * IGDB_PAGE) : all.slice(0, s === 'steam' ? 10 : 25);
            thisRun.got.set(s, take);
            thisRun.states.set(s, { id: s, name: NAMES[s], state: 'done', reason: null, count: take.length, hasMore: s === 'igdb' && all.length > take.length });
          }
          ctx.emit()('discover.results', snapshot(channel));
        }, delay));
      }
      return snapshot(channel);
    },
    'discover.cancel': (p: { channel: DiscoverChannel }) => { current.delete(p.channel); return true; },
    'discover.image': (p: { key: string; kind: 'cover' | 'hero' | 'logo' | 'header' }) => {
      const st = ctx.settings();
      const e = CATALOGUE.find((x) => keyOf(x) === p.key);
      if (!e) return { url: null, reason: 'none' };
      if (st['privacy.localOnly']) return { url: null, reason: 'offline' };
      if (st['dataSaver.enabled']) return { url: null, reason: 'dataSaver' };
      if (p.kind === 'logo') return { url: null, reason: 'none' };
      return { url: placeholderArt(p.kind === 'cover' ? 'cover' : 'hero', e.title, 0, 'alternate'), reason: null };
    },
    // Track D5: cloud availability on Discover cards, from the same fictional flags the page uses (only while cloud play is on).
    'discover.cloudMap': (p: { keys: string[] }) => {
      const on = !!ctx.settings()['cloud.enabled'];
      const map: Record<string, { service: 'gfn' | 'xbox'; match: 'store' | 'title'; playType: string | null }[]> = {};
      if (on) for (const key of (p?.keys ?? []).slice(0, 120)) {
        const e = CATALOGUE.find((x) => keyOf(x) === key);
        if (!e) continue;
        const list = [
          ...(e.gfn && e.steam ? [{ service: 'gfn' as const, match: 'store' as const, playType: 'ready' }] : []),
          ...(e.xbox ? [{ service: 'xbox' as const, match: 'title' as const, playType: 'ready' }] : []),
        ];
        if (list.length) map[key] = list;
      }
      return { enabled: on, map };
    },
    'discover.details': (p: { key: string }): DiscoverDetails => {
      const e = entryOf(p.key);
      const st = ctx.settings();
      if (st['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL can’t look this game up. Turn it off in Settings → Privacy.');
      const igdb = !noKeys;
      const cloudOn = st['cloud.enabled'];
      const cloud = cloudOn ? [
        ...(e.gfn && e.steam ? [{ service: 'gfn' as const, serviceName: 'GeForce NOW', playType: 'ready', premium: false, match: 'store' as const, note: 'Listed for Steam. You’d stream a copy you own.' }] : []),
        ...(e.xbox ? [{ service: 'xbox' as const, serviceName: 'Xbox Cloud Gaming', playType: 'ready', premium: false, match: 'title' as const, note: 'Likely match by title: Xbox Cloud Gaming may include it with Game Pass. xbox.com shows the final answer.' }] : []),
      ] : [];
      const links: DiscoverDetails['links'] = [
        ...(e.steam ? [{ id: 'steam' as const, label: 'Steam', platform: 'steam' as const, kind: 'store' as const }] : []),
        ...(e.stores.includes('gog') ? [{ id: 'gog' as const, label: 'GOG', platform: 'gog' as const, kind: 'store' as const }] : []),
        ...(e.stores.includes('epic') ? [{ id: 'epic' as const, label: 'Epic Games Store', platform: 'epic' as const, kind: 'store' as const }] : []),
        ...(e.stores.includes('xbox') ? [{ id: 'microsoft' as const, label: 'Microsoft Store', platform: 'xbox' as const, kind: 'store' as const }] : []),
        ...(igdb ? [{ id: 'igdb' as const, label: 'IGDB', platform: null, kind: 'info' as const }] : []),
        { id: 'wikidata', label: 'Wikidata', platform: null, kind: 'info' },
      ];
      const final = e.price?.[0];
      const initial = e.price?.[1];
      const money = (c: number) => `$${(c / 100).toFixed(2)}`;
      return {
        key: p.key, title: e.title, year: e.year, releaseDate: `${e.year}-0${(e.title.length % 9) + 1}-1${e.title.length % 9}`, description: `${e.blurb} (Preview data: a fictional game.)`,
        descriptionSource: e.steam ? 'steam' : 'igdb', genres: e.genres, developers: [e.dev], publishers: [e.dev], platforms: e.platforms, stores: e.stores,
        steamAppId: e.steam ? String(e.steam) : null, libraryGameId: libraryIdOf(e),
        price: e.free ? { formatted: null, initial: null, discountPercent: 0, currency: null, free: true, comingSoon: false, country: 'US' }
          : final != null && initial != null ? { formatted: money(final), initial: money(initial), discountPercent: Math.round((1 - final / initial) * 100), currency: 'USD', free: false, comingSoon: false, country: 'US' }
          : e.year > new Date().getFullYear() ? { formatted: null, initial: null, discountPercent: 0, currency: null, free: false, comingSoon: true, country: 'US' } : null,
        timeToBeat: igdb && e.ttb ? { hastilySeconds: e.ttb[0] * 3600, normallySeconds: e.ttb[1] * 3600, completelySeconds: e.ttb[2] * 3600, count: 120 + e.title.length * 7 } : null,
        metacritic: e.steam && e.price ? 70 + (e.title.length % 25) : null, rating: igdb ? 72 + (e.title.length % 20) : null, ratingCount: igdb ? 300 + e.title.length * 11 : 0,
        deck: e.deck ? { category: e.deck, tests: [{ text: 'Everything works with the default controller configuration', kind: 'pass' }], fetched: new Date().toISOString() } : null,
        antiCheat: e.antiCheat ? { names: [e.antiCheat], kernel: true, status: 'Supported', statusLabel: 'Supported on Linux/Steam Deck', reference: null, updated: null, slug: null } : null,
        links, cloud, cloudReason: !cloudOn ? 'off' : cloud.length ? null : 'none', trailerId: null,
        watching: watching.some((w) => w.key === p.key),
        credits: [
          ...(e.steam ? [{ id: 'steam' as const, name: 'Steam', note: 'Store details, price and trailer from the Steam store' }] : []),
          ...(igdb ? [{ id: 'igdb' as const, name: 'IGDB', note: 'Details and time to beat from IGDB.com' }] : []),
          { id: 'wikidata', name: 'Wikidata', note: 'Store IDs from Wikidata (CC0)' },
        ],
        notes: igdb ? [] : ['igdb:noKey'], fetched: new Date().toISOString(), reason: null, hasHero: true, hasLogo: false, hasCover: true,
      };
    },
    'discover.openLink': () => true,
    'discover.deals': (p: { key: string }): Deals => {
      const e = entryOf(p.key);
      if (!e.steam || !e.price) return { steamAppId: e.steam ? String(e.steam) : null, reason: e.steam ? null : 'noSteamId', country: 'US', quotes: [] };
      const best = e.price[0];
      return {
        steamAppId: String(e.steam), reason: null, country: 'US',
        quotes: [{
          provider: 'cheapshark', name: 'CheapShark', currency: 'USD', historicalLow: Math.round(best * 0.6) / 100, historicalLowAt: '2026-06-24T00:00:00Z',
          fetched: new Date().toISOString(), stale: false, error: null,
          offers: [
            { id: 'pv-offer-1', shop: 'Fictional Games Shop', price: Math.round(best * 0.85) / 100, regular: e.price[1] / 100, cut: Math.round((1 - (best * 0.85) / e.price[1]) * 100) },
            { id: 'pv-offer-2', shop: 'Steam', price: best / 100, regular: e.price[1] / 100, cut: Math.round((1 - best / e.price[1]) * 100) },
          ],
        }],
      };
    },
    'discover.openOffer': () => true,
    'discover.featured': () => later((): DiscoverFeatured => {
      const st = ctx.settings();
      if (!st['discover.storeShelves']) return { state: 'off', reason: null, fetched: null, stale: false, shelves: [] };
      if (st['privacy.localOnly']) return featuredSeen ? { ...featured(), state: 'offline', reason: 'offline', stale: true } : { state: 'offline', reason: 'offline', fetched: null, stale: false, shelves: [] };
      if (storeFail) return { state: 'failed', reason: 'unavailable', fetched: null, stale: false, shelves: [] };
      featuredSeen = true;
      return featured();
    }, 450),
    'discover.similar': () => later(similar, 650),
    'discover.genre': (p: { genre: string; page?: number }) => later(() => genre(p), 380),
    'discover.watching': () => [...watching],
    'discover.watch': (p: { key: string; on: boolean }) => {
      const e = entryOf(p.key);
      const i = watching.findIndex((w) => w.key === p.key);
      if (i >= 0) watching.splice(i, 1);
      if (p.on) watching.unshift({ key: p.key, title: e.title, year: e.year, steamAppId: e.steam ? String(e.steam) : null, addedAt: new Date().toISOString(), priceWhenAdded: e.price ? `$${(e.price[0] / 100).toFixed(2)}` : null, cover: null });
      ctx.emit()('discover.watching', [...watching]);
      return [...watching];
    },
  };
}
