/**
 * Preview handlers for Track I (data sources). Fictional data only; artwork previews are SVG
 * placeholders generated right here, so preview mode and UI tests never touch the network.
 */
import type {
  ArtOption, ArtOptions, Compat, DataSourceId, DataSourceOutcome, DataSourcesStatus, Deals, Enrichment, Game, Identity, PickerKind, ProviderAction,
  ProviderStatus, Settings, UserArt, ValueGame, ValueTimeline,
} from './types';
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[]; sessions: { gameId: string; start: string }[] };
  emit: () => Emit;
  settings: () => Settings;
  timers: number[];
}

export const DATA_SOURCE_DEFAULT_SETTINGS = {
  'dataSources.enrichment': true,
  'dataSources.cheapshark': true,
  'dataSources.wikidata': true,
  'dataSources.steamDeck': true,
  'dataSources.antiCheat': true,
  'dataSources.storePrices': true,
  'dataSources.priceCountry': 'US',
} satisfies Partial<Settings>;

const STYLES: Record<PickerKind, string[]> = {
  cover: ['alternate', 'blurred', 'white_logo', 'material', 'no_logo'],
  hero: ['alternate', 'blurred', 'material'],
  logo: ['official', 'white', 'black', 'custom'],
  icon: ['official', 'custom'],
};

const SIZE: Record<PickerKind, [number, number]> = { cover: [600, 900], hero: [1920, 620], logo: [800, 310], icon: [256, 256] };

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0xffffffff);
}

const hash = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);

/** A locally drawn placeholder: a gradient with the game's initials. Never a real image, never remote. */
export function placeholderArt(kind: PickerKind, title: string, n: number, style: string): string {
  const [w, h] = SIZE[kind];
  const r = seeded(hash(`${title}|${kind}|${n}`));
  const hue = Math.floor(r() * 360);
  const hue2 = (hue + 40 + Math.floor(r() * 80)) % 360;
  const initials = title.split(/\s+/).map((x) => x[0]).join('').slice(0, 3).toUpperCase();
  const blur = style === 'blurred' ? '<filter id="b"><feGaussianBlur stdDeviation="18"/></filter>' : '';
  const bg = kind === 'logo' ? '' : `<rect width="${w}" height="${h}" fill="url(#g)" ${style === 'blurred' ? 'filter="url(#b)"' : ''}/>`;
  const fill = kind === 'logo' ? (style === 'black' ? '#111' : style === 'white' ? '#fff' : `hsl(${hue} 80% 70%)`) : 'rgba(255,255,255,.9)';
  const text = style === 'no_logo' ? '' : `<text x="50%" y="${kind === 'cover' ? '78%' : '58%'}" text-anchor="middle" font-family="Segoe UI, sans-serif" font-weight="800" font-size="${Math.round(Math.min(w, h) / (kind === 'logo' ? 2.6 : 4))}" fill="${fill}">${initials}</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue2} 75% 18%)"/></linearGradient>${blur}</defs>${bg}<circle cx="${w * (0.2 + r() * 0.6)}" cy="${h * (0.2 + r() * 0.4)}" r="${Math.min(w, h) * (0.15 + r() * 0.2)}" fill="hsl(${hue2} 90% 70% / .35)"/>${text}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const AUTHORS = ['Lumen', 'pixelwren', 'Halcyon', 'grid_smith', 'Orbit', 'mossy', 'Corvid', 'nightjar'];

export function dataSourcePreviewHandlers(ctx: Ctx): Record<string, (p: any) => unknown> {
  const keys: Partial<Record<DataSourceId, string>> = { steamgriddb: '••••7f3a', igdb: '••••k2pq' };
  const lastTests: Partial<Record<DataSourceId, ProviderStatus['lastTest']>> = {
    steamgriddb: { outcome: 'ok', message: 'Connected. SteamGridDB accepted the key.', at: new Date(Date.now() - 86400000).toISOString() },
  };
  const userArt = new Map<string, UserArt[]>();
  const pickedArt = new Map<string, Record<string, string>>();
  const options = new Map<string, Map<string, string>>(); // gameId|kind → optionId → data URL

  const find = (id: string) => {
    const g = ctx.lib.games.find((x) => x.id === id);
    if (!g) throw new BridgeError('notFound', 'That item no longer exists.');
    return g;
  };
  const steamAppOf = (g: Game) => g.installations.find((i) => i.platform === 'steam')?.platformGameId ?? null;
  const offline = () => ctx.settings()['privacy.localOnly'];

  const INFO: Omit<ProviderStatus, 'configured' | 'keyMasked' | 'enabled' | 'lastTest' | 'pausedUntil'>[] = [
    { id: 'steamgriddb', name: 'SteamGridDB', access: 'key', settingKey: null, licence: 'Community artwork; each image belongs to its author. SteamGridDB terms: personal, non-commercial use.', attribution: 'Artwork from SteamGridDB, credited to its author.', host: 'www.steamgriddb.com, cdn2.steamgriddb.com', sends: 'Your key, the Steam app ID or title of a game when you open the artwork picker.', uses: 'Alternative covers, backgrounds, logos and icons in the artwork picker.' },
    { id: 'igdb', name: 'IGDB', access: 'twitch', settingKey: 'dataSources.enrichment', licence: 'Free under the Twitch Developer Services Agreement.', attribution: 'Game details from IGDB.com.', host: 'id.twitch.tv, api.igdb.com', sends: 'Your Twitch client ID and secret (to get a token), then Steam app IDs or exact titles of games in your library.', uses: 'Missing descriptions, genres, themes, modes, release dates, studios, ratings, time to beat, series and similar games.' },
    { id: 'rawg', name: 'RAWG', access: 'key', settingKey: 'dataSources.enrichment', licence: 'RAWG API terms: free for personal use with an active link to RAWG on every page that shows its data.', attribution: 'Data from RAWG.io.', host: 'api.rawg.io', sends: 'Your key and the titles (or Wikidata-linked IDs) of games in your library.', uses: 'Missing descriptions, genres, release dates, studios, user rating and average playtime.' },
    { id: 'itad', name: 'IsThereAnyDeal', access: 'key', settingKey: null, licence: 'IsThereAnyDeal API terms: data and shop links are shown unchanged, with a link to IsThereAnyDeal.', attribution: 'Prices from IsThereAnyDeal.com.', host: 'api.isthereanydeal.com', sends: 'Your key, a game’s Steam app ID and your price country, when you open that game’s page.', uses: 'Current prices across shops and the historical low on game pages.' },
    { id: 'cheapshark', name: 'CheapShark', access: 'keyless', settingKey: 'dataSources.cheapshark', licence: 'CheapShark API: free; deal links go through CheapShark’s own redirect.', attribution: 'Prices from CheapShark.com.', host: 'www.cheapshark.com', sends: 'A game’s Steam app ID, only when you open that game’s page.', uses: 'Current best price (US dollars) and the lowest price ever on game pages.' },
    { id: 'wikidata', name: 'Wikidata', access: 'keyless', settingKey: 'dataSources.wikidata', licence: 'CC0 (public domain).', attribution: 'Store IDs from Wikidata.', host: 'query.wikidata.org', sends: 'Steam app IDs (and GOG product IDs) of games in your library, in batches.', uses: 'The same game’s IDs on other stores and sites, “Open on…” links and duplicate suggestions.' },
    { id: 'steamdeck', name: 'Steam Deck compatibility', access: 'keyless', settingKey: 'dataSources.steamDeck', licence: 'Valve’s public store data, shown with attribution.', attribution: 'Steam Deck compatibility as reported by Valve on the Steam store.', host: 'store.steampowered.com', sends: 'A game’s Steam app ID when you open its page (also used for current Steam prices in the library value timeline).', uses: 'Verified / Playable / Unsupported badges with Valve’s test results.' },
    { id: 'awacy', name: 'AreWeAntiCheatYet', access: 'keyless', settingKey: 'dataSources.antiCheat', licence: 'MIT licence (AreWeAntiCheatYet contributors).', attribution: 'Anti-cheat details per AreWeAntiCheatYet.', host: 'raw.githubusercontent.com', sends: 'Nothing about you: the whole public list is downloaded at most once a week.', uses: 'Which anti-cheat a game uses, and its Linux/Steam Deck status.' },
    // Track X (mirror of DataSourcesService.Providers).
    { id: 'pcgamingwiki', name: 'PCGamingWiki', access: 'keyless', settingKey: 'dataSources.pcgamingwiki', licence: 'CC BY-NC-SA 3.0 (PCGamingWiki contributors). Credited wherever it’s shown; looked up on this PC only, never shipped with VYSTRAL.', attribution: 'Save locations from PCGamingWiki, CC BY-NC-SA 3.0.', host: 'www.pcgamingwiki.com', sends: 'A game’s Steam app ID, then its article name, when you open that game’s Files tab.', uses: 'Where a game keeps its saves on Windows, checked against your PC (read-only), with Open folder.' },
    { id: 'workshop', name: 'Steam Workshop titles', access: 'keyless', settingKey: 'dataSources.workshopTitles', licence: 'Valve’s public Steam Web API (no key), shown with attribution.', attribution: 'Workshop titles from Steam.', host: 'api.steampowered.com', sends: 'The Workshop item IDs installed for a game, when you open its Files tab (up to 100 per request).', uses: 'Names for the Workshop items in a game’s mod list instead of bare numbers.' },
  ];

  const status = (): DataSourcesStatus => {
    const s = ctx.settings();
    return {
      providers: INFO.map((p) => {
        const configured = p.access === 'keyless' || !!keys[p.id];
        const enabled = p.access === 'keyless' ? !!s[p.settingKey!] : configured && (p.settingKey ? !!s[p.settingKey] : true);
        return { ...p, configured, keyMasked: keys[p.id] ?? null, enabled, lastTest: lastTests[p.id] ?? null, pausedUntil: null };
      }),
      localOnly: s['privacy.localOnly'],
      dataSaver: s['dataSaver.enabled'],
      fetchMetadata: s['library.fetchMetadata'],
      priceCountry: s['dataSources.priceCountry'],
    };
  };

  const record = (id: DataSourceId, outcome: DataSourceOutcome, message: string): ProviderAction => {
    lastTests[id] = { outcome, message, at: new Date().toISOString() };
    return { result: lastTests[id]!, status: status() };
  };

  const requireOnline = () => {
    if (offline()) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL doesn’t contact data sources. Turn it off in Settings → Privacy.');
  };

  const handlers: Record<string, (p: any) => unknown> = {
    'dataSources.status': () => status(),
    'dataSources.connect': (p: { provider: DataSourceId; key: string; secret?: string | null }) => {
      if (offline()) return record(p.provider, 'offline', 'Offline mode is on, so nothing was sent.');
      // Preview rule: keys that start with "bad" are rejected, like a provider would.
      if (/^bad/i.test(p.key)) return record(p.provider, 'invalidKey', 'The provider didn’t accept this key. Copy it again.');
      keys[p.provider] = `••••${p.key.trim().slice(-4)}`;
      const r = record(p.provider, 'ok', p.provider === 'igdb' ? 'Connected. IGDB answered with your Twitch application’s token (kept in memory only).' : 'Connected. The key works.');
      ctx.emit()('dataSources.changed', r.status);
      return r;
    },
    'dataSources.test': (p: { provider: DataSourceId }) =>
      offline() ? record(p.provider, 'offline', 'Offline mode is on, so nothing was sent.') : record(p.provider, 'ok', 'Answered just now (preview).'),
    'dataSources.disconnect': (p: { provider: DataSourceId }) => {
      delete keys[p.provider];
      delete lastTests[p.provider];
      const s = status();
      ctx.emit()('dataSources.changed', s);
      return s;
    },
    'dataSources.openLink': () => true,

    'art.options': (p: { gameId: string; kind: PickerKind; styles?: string[]; animated?: boolean; page?: number; sgdbGameId?: string | null }): ArtOptions => {
      requireOnline();
      if (!keys.steamgriddb) throw new BridgeError('notConfigured', 'Add your SteamGridDB API key in Settings → Data sources to browse alternatives.');
      const g = find(p.gameId);
      const steam = steamAppOf(g);
      // Games without a Steam ID and whose title doesn't match exactly offer candidates first.
      if (!steam && !p.sgdbGameId && g.title.length % 2 === 0) {
        return { kind: p.kind, game: null, matchedBy: null, items: [], candidates: [{ id: '501', name: g.title, year: 2021 }, { id: '502', name: `${g.title}: Director’s Cut`, year: 2023 }], styles: STYLES[p.kind], previewsPaused: ctx.settings()['dataSaver.enabled'], hasMore: false };
      }
      const r = seeded(hash(`${g.id}|${p.kind}|${(p.styles ?? []).join()}`));
      const pool = (p.styles?.length ? p.styles : STYLES[p.kind]).filter((s) => STYLES[p.kind].includes(s));
      const count = 10 + Math.floor(r() * 8);
      const map = new Map<string, string>();
      const items: ArtOption[] = Array.from({ length: count }, (_, i) => {
        const style = pool[i % pool.length] ?? STYLES[p.kind][0];
        const id = String(10000 + hash(`${g.id}${p.kind}${i}${style}`) % 89999);
        map.set(id, placeholderArt(p.kind, g.title, i, style));
        const [w, h] = SIZE[p.kind];
        return { id, thumb: null, width: w, height: h, style, author: AUTHORS[i % AUTHORS.length], score: Math.floor(r() * 40), animated: false };
      });
      options.set(`${g.id}|${p.kind}`, map);
      return {
        kind: p.kind, game: { id: p.sgdbGameId ?? String(4000 + (hash(g.id) % 900)), name: g.title, year: null }, matchedBy: p.sgdbGameId ? 'chosen' : steam ? 'steam' : 'title',
        items, candidates: [], styles: STYLES[p.kind], previewsPaused: ctx.settings()['dataSaver.enabled'], hasMore: false,
      };
    },
    'art.thumb': async (p: { gameId: string; kind: PickerKind; optionId: string; force?: boolean }) => {
      const url = options.get(`${p.gameId}|${p.kind}`)?.get(p.optionId);
      if (!url) throw new BridgeError('unavailable', 'That image is no longer in the list. Refresh the picker and try again.');
      if (ctx.settings()['dataSaver.enabled'] && !p.force) throw new BridgeError('disabled', 'Data saver is on, so previews aren’t downloaded.');
      await new Promise((res) => setTimeout(res, 60 + Math.random() * 240));
      return url;
    },
    'art.apply': (p: { gameId: string; kind: PickerKind; optionId: string }) => {
      const url = options.get(`${p.gameId}|${p.kind}`)?.get(p.optionId);
      if (!url) throw new BridgeError('unavailable', 'That image is no longer in the list.');
      const g = find(p.gameId);
      const art = { ...g.art, [p.kind]: url };
      const i = ctx.lib.games.indexOf(g);
      ctx.lib.games[i] = { ...g, art };
      const picks = pickedArt.get(g.id) ?? {};
      picks[p.kind] = url;
      pickedArt.set(g.id, picks);
      const list = (userArt.get(g.id) ?? []).filter((u) => u.kind !== p.kind);
      list.push({ kind: p.kind, source: 'steamgriddb', author: AUTHORS[Number(p.optionId) % AUTHORS.length] });
      userArt.set(g.id, list);
      ctx.emit()('library.changed', { reason: 'artwork' });
      return true;
    },
    'art.userArt': (p: { gameId: string }) => userArt.get(p.gameId) ?? [],
    'art.reset': (p: { gameId: string; kind: string }) => {
      const g = find(p.gameId);
      const list = userArt.get(g.id) ?? [];
      if (!list.some((u) => u.kind === p.kind)) return false;
      userArt.set(g.id, list.filter((u) => u.kind !== p.kind));
      const i = ctx.lib.games.indexOf(g);
      ctx.lib.games[i] = { ...g, art: { ...g.art, [p.kind]: null } };
      ctx.emit()('library.changed', { reason: 'artwork' });
      return true;
    },

    'enrichment.get': (p: { gameId: string }): Enrichment => {
      const g = find(p.gameId);
      const s = ctx.settings();
      const canFetch = !s['privacy.localOnly'] && s['dataSources.enrichment'] && !!(keys.igdb || keys.rawg);
      if (!keys.igdb) return { sources: [], fieldSources: {}, canFetch, reason: s['privacy.localOnly'] ? 'offline' : !s['dataSources.enrichment'] ? 'disabled' : 'noKeys' };
      const r = seeded(hash(g.id));
      return {
        sources: [{
          source: 'igdb', name: 'IGDB', matched: true, matchMethod: steamAppOf(g) ? 'steam-appid' : 'exact-title', confidence: steamAppOf(g) ? 1 : 0.85,
          url: null, fetched: new Date(Date.now() - 3 * 86400000).toISOString(),
          facts: {
            themes: ['Science fiction', 'Exploration'].slice(0, 1 + Math.floor(r() * 2)), gameModes: ['Single player', 'Co-operative'],
            perspectives: ['Third person'], franchises: [], series: [`${g.title.split(' ')[0]} series`],
            similar: ctx.lib.games.filter((x) => x.id !== g.id).slice(0, 4).map((x) => x.title),
            criticRating: Math.round((70 + r() * 25) * 10) / 10, criticRatingCount: 8 + Math.floor(r() * 30),
            totalRating: Math.round((65 + r() * 30) * 10) / 10, totalRatingCount: 40 + Math.floor(r() * 400),
            timeToBeat: { hastily: Math.round((6 + r() * 10) * 3600), normally: Math.round((14 + r() * 20) * 3600), completely: Math.round((30 + r() * 50) * 3600), count: 12 + Math.floor(r() * 300) },
          },
        }],
        fieldSources: { genres: 'igdb' },
        canFetch,
        reason: null,
      };
    },
    'enrichment.run': (p: { gameId: string }) => {
      requireOnline();
      return { filled: [], details: handlers['enrichment.get']({ gameId: p.gameId }) as Enrichment };
    },
    'enrichment.open': () => true,

    'deals.get': (p: { gameId: string; refresh?: boolean }): Deals => {
      const g = find(p.gameId);
      const steam = steamAppOf(g);
      const s = ctx.settings();
      if (!steam) return { steamAppId: null, reason: 'noSteamId', country: s['dataSources.priceCountry'], quotes: [] };
      if (!s['dataSources.cheapshark'] && !keys.itad) return { steamAppId: steam, reason: 'disabled', country: s['dataSources.priceCountry'], quotes: [] };
      const r = seeded(hash(`${g.id}deals`));
      const regular = [9.99, 14.99, 19.99, 29.99, 39.99, 59.99][Math.floor(r() * 6)];
      const shops = ['Steam', 'GreenManGaming', 'Fanatical', 'GamersGate', 'Humble Store'];
      const offers = shops.slice(0, 3 + Math.floor(r() * 3)).map((shop, i) => {
        const cut = i === 0 ? Math.floor(r() * 60) : Math.floor(r() * 80);
        return { id: (hash(shop + g.id) % 1e12).toString(16).padStart(16, '0').slice(0, 16), shop, price: Math.round(regular * (1 - cut / 100) * 100) / 100, regular, cut };
      }).sort((a, b) => a.price - b.price);
      const fetched = new Date(Date.now() - 42 * 60000).toISOString();
      return {
        steamAppId: steam, reason: s['privacy.localOnly'] ? 'offline' : null, country: s['dataSources.priceCountry'],
        quotes: s['dataSources.cheapshark'] ? [{
          provider: 'cheapshark', name: 'CheapShark', currency: 'USD', offers, historicalLow: Math.round(regular * 0.2 * 100) / 100,
          historicalLowAt: new Date(Date.now() - 200 * 86400000).toISOString(), fetched, stale: false, error: null,
        }] : [],
      };
    },
    'deals.open': () => true,

    'identity.get': (p: { gameId: string }): Identity => {
      const g = find(p.gameId);
      const steam = steamAppOf(g);
      if (!steam) return { keyKind: null, keyValue: null, wikidataId: null, label: null, ids: [], fetched: null, reason: 'noStoreId' };
      const slug = g.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const ids = [
        { name: 'steam', label: 'Steam', value: steam, platform: 'steam' as const, link: true },
        ...(hash(g.id) % 2 ? [{ name: 'gog', label: 'GOG', value: `game/${slug.replace(/-/g, '_')}`, platform: 'gog' as const, link: true }] : []),
        ...(hash(g.id) % 3 ? [{ name: 'microsoft', label: 'Microsoft Store', value: '9pzfictional', platform: 'xbox' as const, link: true }] : []),
        { name: 'igdb', label: 'IGDB', value: slug, platform: null, link: true },
        { name: 'pcgamingwiki', label: 'PCGamingWiki', value: g.title.replace(/ /g, '_'), platform: null, link: true },
        { name: 'hltb', label: 'HowLongToBeat', value: String(10000 + (hash(g.id) % 80000)), platform: null, link: true },
      ];
      return { keyKind: 'steam', keyValue: steam, wikidataId: `Q${9000000 + (hash(g.id) % 900000)}`, label: g.title, ids, fetched: new Date(Date.now() - 5 * 86400000).toISOString(), reason: null };
    },
    'identity.open': () => true,

    'compat.get': (p: { gameId: string }): Compat => {
      const g = find(p.gameId);
      const s = ctx.settings();
      const steam = steamAppOf(g);
      const h = hash(g.id);
      const category = (['verified', 'playable', 'unsupported', 'unknown'] as const)[h % 4];
      const tests = category === 'verified'
        ? [{ text: 'Everything works with the default controller configuration', kind: 'pass' as const }, { text: 'Shows Steam Deck controller icons', kind: 'pass' as const }, { text: 'Interface text is legible on Steam Deck', kind: 'pass' as const }, { text: 'The default graphics settings perform well on Steam Deck', kind: 'pass' as const }]
        : category === 'playable'
          ? [{ text: 'Some interface text is small and may be hard to read', kind: 'note' as const }, { text: 'Text input doesn’t open the on-screen keyboard automatically', kind: 'note' as const }]
          : category === 'unsupported' ? [{ text: 'Unsupported because of its anti-cheat', kind: 'fail' as const }] : [];
      const anti = h % 3 === 0;
      return {
        deck: steam && s['dataSources.steamDeck'] && s['library.fetchMetadata'] ? { category, tests, fetched: new Date(Date.now() - 2 * 86400000).toISOString() } : null,
        deckReason: !steam ? 'noSteamId' : !s['dataSources.steamDeck'] || !s['library.fetchMetadata'] ? 'disabled' : null,
        antiCheat: s['dataSources.antiCheat'] && anti && steam ? { names: h % 2 ? ['Easy Anti-Cheat'] : ['BattlEye'], kernel: true, status: h % 2 ? 'Supported' : 'Denied', statusLabel: h % 2 ? 'Supported on Linux/Steam Deck' : 'Linux/Steam Deck blocked by the developer', reference: null, updated: '2025-11-02T00:00:00.000Z', slug: 'fictional' } : null,
        antiCheatReason: !s['dataSources.antiCheat'] ? 'disabled' : anti && steam ? null : 'notListed',
      };
    },
    'compat.antiCheatMap': () => ({}),
    'compat.openAntiCheat': () => true,

    'value.timeline': (): ValueTimeline => valueTimeline(ctx, false),
    'value.refreshPrices': (): ValueTimeline => {
      requireOnline();
      return valueTimeline(ctx, true);
    },
  };
  return handlers;
}

let pricedOnce = false;

function valueTimeline(ctx: Ctx, refresh: boolean): ValueTimeline {
  if (refresh) pricedOnce = true;
  const s = ctx.settings();
  const now = Date.now();
  const firstSession = new Map<string, string>();
  for (const x of ctx.lib.sessions) if (!firstSession.has(x.gameId) || x.start < firstSession.get(x.gameId)!) firstSession.set(x.gameId, x.start);
  const games: ValueGame[] = ctx.lib.games.filter((g) => !g.hidden).map((g, i) => {
    const r = seeded(hash(`${g.id}value`));
    // Fictional history: spread "first seen" over the last few years so the chart has a shape.
    const seen = new Date(now - Math.floor(r() * 4.5 * 365) * 86400000 - i * 3600000).toISOString();
    const session = firstSession.get(g.id);
    const lastPlayed = g.installations.map((x) => x.importedLastPlayed).filter((x): x is string => !!x).sort()[0];
    const candidates: [string, ValueGame['sinceSource']][] = [[seen, 'firstSeen']];
    if (session) candidates.push([session, 'firstSession']);
    if (lastPlayed) candidates.push([lastPlayed, 'storeLastPlayed']);
    if (r() > 0.7) candidates.push([new Date(now - Math.floor(r() * 6 * 365) * 86400000).toISOString(), 'firstAchievement']);
    candidates.sort((a, b) => a[0].localeCompare(b[0]));
    const steam = g.installations.some((x) => x.platform === 'steam');
    const free = r() > 0.88;
    const cents = steam && !free && pricedOnce ? [499, 999, 1499, 1999, 2499, 2999, 3999, 5999][Math.floor(r() * 8)] : null;
    return {
      gameId: g.id, title: g.title, platforms: [...new Set(g.installations.map((x) => x.platform))], since: candidates[0][0], sinceSource: candidates[0][1],
      priceCents: cents, regularCents: cents, currency: cents != null ? 'USD' : null, formatted: cents != null ? `$${(cents / 100).toFixed(2)}` : null,
      notSold: steam && free && pricedOnce, pricedAt: pricedOnce && steam ? new Date(now - 60000).toISOString() : null,
    };
  });
  const priced = games.filter((g) => g.priceCents != null);
  return {
    games: games.sort((a, b) => a.since.localeCompare(b.since)), currency: priced.length ? 'USD' : null, totalCents: priced.reduce((n, g) => n + (g.priceCents ?? 0), 0),
    priced: priced.length, unpriced: games.length - priced.length, lastPriced: pricedOnce ? new Date(now - 60000).toISOString() : null,
    country: s['dataSources.priceCountry'], pricesEnabled: s['dataSources.storePrices'], reason: !s['dataSources.storePrices'] ? 'disabled' : s['privacy.localOnly'] ? 'offline' : null,
  };
}
