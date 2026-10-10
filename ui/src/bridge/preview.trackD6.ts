/**
 * Track D6 preview: exchange rates, Data sources health, the cache viewer and the crash-free streak, with fictional
 * numbers (the preview has no network, data folder or start history). URL switches:
 *   ?currency=INR       start with that display currency (else the browser region's)
 *   ?fxNone             no exchange rates downloaded yet (prices stay in their own currency)
 *   ?fxOffline          rates from four days ago, Offline mode on
 *   ?healthCalm         every provider healthy (no back-off or error rows)
 *   ?streakIncident     a failed start 9 days ago (else a long clean streak)
 *   ?streakNew          no start history yet
 */
import type { CacheClearResult, CacheInfo, FxStatus, ProviderHealthEntry, ProviderHealthSnapshot, Settings, StreakIncident, StreakSummary } from './types';
import { BridgeError } from './bridge';
import { regionCurrency } from '../lib/money';

type Emit = (name: string, payload: unknown) => void;

export const TRACK_D6_DEFAULT_SETTINGS: Pick<Settings, 'app.currency'> = { 'app.currency': '' };

/** ?currency=XXX sets the starting display currency. */
export function previewD6Settings(params: URLSearchParams): Partial<Settings> {
  const c = params.get('currency');
  return c && /^[A-Z]{3}$/.test(c) ? { 'app.currency': c } : {};
}

// Fictional but realistic EUR-based rates (rounded), for the preview only.
const PREVIEW_RATES: Record<string, number> = {
  EUR: 1, USD: 1.12, GBP: 0.85, INR: 108.4, JPY: 177.3, CAD: 1.6, AUD: 1.61, NZD: 2, CHF: 0.93, SEK: 11.17, NOK: 10.72, DKK: 7.48,
  PLN: 4.38, CZK: 24.37, HUF: 365, RON: 5.34, TRY: 55.1, BRL: 5.61, MXN: 20.4, ARS: 1701, CLP: 1099, COP: 3612, PEN: 4.2, ZAR: 18.5,
  SAR: 4.2, AED: 4.12, QAR: 4.08, KWD: 0.34, ILS: 3.43, KRW: 1503, CNY: 7.5, HKD: 8.79, TWD: 36.1, SGD: 1.43, MYR: 4.58, THB: 37.6,
  IDR: 20037, PHP: 70.4, VND: 29500, UAH: 46.4, KZT: 600, ISK: 136.8,
};

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

export function trackD6PreviewHandlers(ctx: { emit: () => Emit; settings: () => Settings; timers: number[] }) {
  const params = new URLSearchParams(location.search);
  const none = params.has('fxNone');
  const stale = params.has('fxOffline');
  let fetchedAt: number | null = none ? null : Date.now() - (stale ? 4 * DAY : 3 * 3_600_000);
  const fx = (): FxStatus => {
    const offline = ctx.settings()['privacy.localOnly'];
    const date = fetchedAt ? new Date(fetchedAt - (new Date(fetchedAt).getUTCHours() < 16 ? DAY : 0)).toISOString().slice(0, 10) : null;
    return {
      state: offline ? 'offline' : fetchedAt == null ? 'never' : Date.now() - fetchedAt > 3 * DAY ? 'stale' : 'ok',
      base: fetchedAt ? 'EUR' : null,
      date,
      fetchedAt: fetchedAt ? iso(fetchedAt) : null,
      rates: fetchedAt ? PREVIEW_RATES : null,
      regionCurrency: regionCurrency(),
      source: 'Frankfurter (European Central Bank and other central banks)',
      error: null,
      nextAttemptAt: offline ? null : iso((fetchedAt ?? Date.now()) + 20 * 3_600_000),
    };
  };

  // ---- Data sources health ----
  const calm = params.has('healthCalm');
  const s = () => ctx.settings();
  const row = (p: Partial<ProviderHealthEntry> & Pick<ProviderHealthEntry, 'id' | 'name' | 'group' | 'logo' | 'purpose'>): ProviderHealthEntry => ({
    enabled: true, optIn: false, disabledReason: null, state: 'idle', lastSuccess: null, lastError: null, lastErrorText: null,
    backoffUntil: null, backoffReason: null, requestsToday: 0, cacheUpdated: null, ...p,
  });
  const gate = (on: boolean, why: string, optIn = true): Pick<ProviderHealthEntry, 'enabled' | 'optIn' | 'disabledReason' | 'state'> | Record<string, never> => {
    if (s()['privacy.localOnly']) return { enabled: false, optIn, disabledReason: 'Offline mode is on', state: 'off' };
    return on ? {} : { enabled: false, optIn, disabledReason: why, state: 'off' };
  };
  const ago = (min: number) => iso(Date.now() - min * 60_000);
  const health = (): ProviderHealthSnapshot => ({
    at: new Date().toISOString(),
    offline: s()['privacy.localOnly'],
    providers: [
      row({ id: 'steam.webapi', name: 'Steam Web API', group: 'Steam', logo: 'steam', purpose: 'Owned games, achievements, wishlist, friends, news and tags (with your key)', state: 'ok', optIn: true, lastSuccess: ago(4), requestsToday: 38, ...gate(true, '') }),
      row({ id: 'steam.store', name: 'Steam store', group: 'Steam', logo: 'steam', purpose: 'Game details, prices, reviews, Steam Deck reports, Discover and Workshop titles',
        ...(calm ? { state: 'ok', lastSuccess: ago(2) } : { state: 'backoff', lastSuccess: ago(26), backoffUntil: iso(Date.now() + 9 * 60_000), backoffReason: 'Steam asked VYSTRAL to slow down (HTTP 429)' }),
        requestsToday: 214, cacheUpdated: ago(26), ...gate(s()['library.fetchMetadata'], 'Game details, Discover and store prices are off', false) }),
      row({ id: 'igdb', name: 'IGDB', group: 'Game details', logo: 'igdb', purpose: 'Genres, descriptions, release dates, series and similar games', optIn: true, ...gate(false, 'Needs your Twitch app') }),
      row({ id: 'rawg', name: 'RAWG', group: 'Game details', logo: 'rawg', purpose: 'Missing details and Discover search', optIn: true, ...gate(false, 'Needs your RAWG key') }),
      row({ id: 'wikidata', name: 'Wikidata', group: 'Game details', logo: 'wikidata', purpose: 'The same game across stores (for duplicate suggestions and links)', state: 'ok', lastSuccess: ago(180), requestsToday: 3, ...gate(true, 'Turned off', false) }),
      row({ id: 'pcgamingwiki', name: 'PCGamingWiki', group: 'Game details', logo: 'pcgamingwiki', purpose: 'Where games keep their save files', optIn: true, ...gate(false, 'Turned off') }),
      row({ id: 'awacy', name: 'AreWeAntiCheatYet', group: 'Game details', logo: 'awacy', purpose: 'Anti-cheat notes on game pages', state: 'ok', lastSuccess: ago(60 * 30), requestsToday: 0, ...gate(true, 'Turned off', false) }),
      row({ id: 'steamgriddb', name: 'SteamGridDB', group: 'Artwork', logo: 'steamgriddb', purpose: 'Community covers, heroes, logos and art packs', optIn: true,
        ...(calm ? { state: 'ok', lastSuccess: ago(40) } : { state: 'error', lastSuccess: ago(60 * 26), lastError: ago(40), lastErrorText: 'SteamGridDB didn’t accept the key (HTTP 401)' }), requestsToday: 2, ...gate(true, '') }),
      row({ id: 'itad', name: 'IsThereAnyDeal', group: 'Prices', logo: 'itad', purpose: 'Current deals and the lowest price ever, in your region', optIn: true, ...gate(false, 'Needs your IsThereAnyDeal key') }),
      row({ id: 'cheapshark', name: 'CheapShark', group: 'Prices', logo: 'cheapshark', purpose: 'Deals and the lowest price ever (US dollars)', state: 'ok', lastSuccess: ago(12), requestsToday: 17, cacheUpdated: ago(12), ...gate(true, 'Turned off', false) }),
      row({ id: 'fx', name: 'Exchange rates', group: 'Prices', logo: null, purpose: 'Daily rates from Frankfurter (European Central Bank and other central banks) to show prices in your currency',
        state: fetchedAt ? 'ok' : 'idle', lastSuccess: fetchedAt ? iso(fetchedAt) : null, requestsToday: fetchedAt && Date.now() - fetchedAt < DAY ? 1 : 0, cacheUpdated: fetchedAt ? iso(fetchedAt) : null, ...gate(true, '', false) }),
      row({ id: 'gfn.catalog', name: 'GeForce NOW catalogue', group: 'Cloud & subscriptions', logo: 'geforce-now', purpose: 'Which of your games stream on GeForce NOW', optIn: true, ...gate(s()['cloud.enabled'], 'Cloud play is off') }),
      row({ id: 'gfn.status', name: 'GeForce NOW status', group: 'Cloud & subscriptions', logo: 'geforce-now', purpose: 'Whether GeForce NOW is up right now', optIn: true, ...gate(s()['cloud.enabled'], 'Cloud play is off') }),
      row({ id: 'gamepass.catalog', name: 'Game Pass catalogue', group: 'Cloud & subscriptions', logo: 'game-pass', purpose: 'What your plans include, leaving soon, and Xbox Cloud Gaming', optIn: true, ...gate(s()['subs.catalog'], 'Off: turn on “Show what my plans include” or Xbox Cloud Gaming') }),
      row({ id: 'msstore', name: 'Microsoft Store', group: 'Cloud & subscriptions', logo: 'xbox-cloud', purpose: 'Names and posters for Game Pass and cloud games', optIn: true, ...gate(s()['subs.catalog'], 'Only used with the Game Pass lists') }),
      ...(['anthropic', 'openai', 'gemini', 'compatible'] as const).map((id) => row({
        id: `ai-${id}`, name: { anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini', compatible: 'OpenAI-compatible' }[id], group: 'Cloud AI', logo: null,
        purpose: `Optional AI features through ${{ anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google', compatible: 'your own endpoint' }[id]}, with your own key`, optIn: true,
        ...gate(s()[`ai.cloud.${id}.optIn` as 'ai.cloud.anthropic.optIn'], 'No key added'),
      })),
    ],
  });

  // ---- Cache viewer ----
  const MB = 1024 * 1024;
  const caches: Record<string, CacheInfo> = {};
  const seed = (id: string, bytes: number, items: number, newestMin: number | null, oldestDays: number | null) => {
    caches[id] = { id, bytes, items, newest: newestMin == null ? null : ago(newestMin), oldest: oldestDays == null ? null : iso(Date.now() - oldestDays * DAY), clearable: true };
  };
  seed('art', 412.6 * MB, 1834, 50, 212);
  seed('thumbs', 38.2 * MB, 906, 20, 64);
  seed('trailers', 141.9 * MB, 37, 300, 21);
  seed('news', 2.4 * MB, 88, 95, 6);
  seed('prices', 0.9 * MB, 412, 26, 1);
  seed('ai', 0.2 * MB, 31, 60 * 30, 40);
  seed('discover', 1.6 * MB, 74, 130, 7);
  seed('tags', 1.1 * MB, 2, 60 * 22, 14);
  seed('friends', 0.05 * MB, 1, 60 * 3, 0);
  seed('wishlist', 0.3 * MB, 1, 60 * 5, 0);
  seed('catalogs', 5.8 * MB, 3108, 60 * 9, 1);
  seed('gamePages', 0.7 * MB, 3, 40, 14);
  seed('lookups', 0, 0, null, null);
  seed('fx', fetchedAt ? 4.1 * 1024 : 0, fetchedAt ? 1 : 0, fetchedAt ? (Date.now() - fetchedAt) / 60_000 : null, fetchedAt ? (Date.now() - fetchedAt) / DAY : null);
  seed('firstPaint', 61 * 1024, 1, 1, 0);

  // ---- Crash-free streak ----
  const streak = (): StreakSummary => {
    const today = new Date();
    const dayKey = (n: number) => new Date(today.getTime() - n * DAY).toISOString().slice(0, 10);
    if (params.has('streakNew')) {
      return { days: 0, since: null, sinceHistoryBegan: true, startsCounted: 0, failedStarts: 0, unexpectedCloses: 0, lastIncident: null, incidents: [],
        recent: Array.from({ length: 30 }, (_, i) => ({ day: dayKey(29 - i), starts: 0, failed: 0, unexpected: 0 })) };
    }
    const incident = params.has('streakIncident');
    const days = incident ? 9 : 42;
    const incidents: StreakIncident[] = incident
      ? [{ at: iso(Date.now() - 9 * DAY), kind: 'failedStart', version: '0.8.0', text: 'VYSTRAL 0.8.0 didn’t finish starting' },
         { at: iso(Date.now() - 23 * DAY), kind: 'unexpectedClose', version: '0.8.0', text: 'VYSTRAL 0.8.0 closed unexpectedly' }]
      : [{ at: iso(Date.now() - 44 * DAY), kind: 'unexpectedClose', version: '0.7.2', text: 'VYSTRAL 0.7.2 closed unexpectedly' }];
    const recent = Array.from({ length: 30 }, (_, i) => {
      const n = 29 - i;
      const starts = [0, 1, 2, 1, 1, 0, 3][n % 7];
      return { day: dayKey(n), starts: incident && n === 9 ? starts + 1 : starts, failed: incident && n === 9 ? 1 : 0, unexpected: incident && n === 23 ? 1 : 0 };
    });
    return {
      days, since: dayKey(days), sinceHistoryBegan: false, startsCounted: incident ? 61 : 118, failedStarts: incident ? 1 : 0, unexpectedCloses: 1,
      lastIncident: incidents[0], incidents, recent,
    };
  };

  return {
    'fx.rates': () => fx(),
    'fx.refresh': () => {
      if (ctx.settings()['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL keeps using the exchange rates it already has.');
      fetchedAt = Date.now();
      const st = fx();
      ctx.emit()('fx.changed', st);
      return st;
    },
    'providers.health': () => health(),
    'caches.list': () => Object.values(caches).map((c) => ({ ...c })),
    'caches.clear': (p: { id?: string }): CacheClearResult => {
      const c = p?.id ? caches[p.id] : undefined;
      if (!c) throw new BridgeError('invalid', 'Unknown cache.');
      const result = { id: c.id, freedBytes: c.bytes, items: c.items, failed: 0 };
      caches[c.id] = { ...c, bytes: 0, items: 0, newest: null, oldest: null };
      if (c.id === 'fx') fetchedAt = null;
      ctx.emit()('caches.cleared', { id: c.id });
      return result;
    },
    'about.streak': () => streak(),
  };
}
