/**
 * Track D4 preview handlers: cross-store identity, trailers from other sources, free games and ProtonDB. Everything is
 * FICTIONAL (the preview never touches the network): Steam app IDs in the 9100xxx range, a local video loop as the
 * "RAWG" trailer, and a local stand-in instead of any YouTube frame.
 *
 * Fictional library matches (no URL switch needed):
 * - Circuit Apex (Xbox) is matched to a Steam app by Wikidata and the Steam store (high confidence) — Steam reviews,
 *   tags, price and Deck rating show for it, labelled — and its trailer comes from RAWG.
 * - Velvet Orbit (Xbox) is only a suggestion; Kingsfall Remastered (Xbox) is a conflict; Summit Sixteen has no match.
 * URL switches: `?identity=off` (matching turned off), `?youtube` (Velvet Orbit has an IGDB trailer on YouTube),
 * `?freebies` (GamerPower and Epic on), `?protondb` (ProtonDB on).
 */
import type {
  Freebie, Freebies, Game, IdCandidate, IdEvidence, ProtonSummary, ProviderStatus, ResolvedId, ResolvedIdentity, Settings, SteamSearchHit, TrailerInfo,
} from './types';
import { BridgeError } from './bridge';
import liveTileLoop from './preview-assets/live-tile.webm?url';

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
}

const params = () => new URLSearchParams(typeof location !== 'undefined' ? location.search : '');

export const TRACK_D4_DEFAULT_SETTINGS = (): Pick<Settings,
  'dataSources.identityMatch' | 'trailers.youtube' | 'dataSources.gamerpower' | 'dataSources.epicFreeGames' | 'dataSources.protondb' | 'dataSources.gogCatalog'> => {
  const p = params();
  return {
    'dataSources.identityMatch': p.get('identity') !== 'off',
    'trailers.youtube': p.has('youtube'),
    'dataSources.gamerpower': p.has('freebies'),
    'dataSources.epicFreeGames': p.has('freebies'),
    'dataSources.protondb': p.has('protondb'),
    'dataSources.gogCatalog': false,
  };
};

/** Mirror of DataSourcesService.Providers (Track D4 rows). */
export const TRACK_D4_PROVIDERS: Omit<ProviderStatus, 'configured' | 'keyMasked' | 'enabled' | 'lastTest' | 'pausedUntil'>[] = [
  { id: 'gamerpower', name: 'GamerPower', access: 'keyless', settingKey: 'dataSources.gamerpower', licence: 'Free for personal and commercial use with an active link back to GamerPower.com (shown wherever its giveaways appear).', attribution: 'Giveaways from GamerPower.com.', host: 'www.gamerpower.com', sends: 'Nothing about you: the public list of PC giveaways, at most every few hours.', uses: 'Free games and in-game items you can claim right now on Steam, Epic, GOG and more.' },
  { id: 'epicfree', name: 'Epic free games', access: 'keyless', settingKey: 'dataSources.epicFreeGames', licence: 'Epic’s public store data, shown with attribution. Not a documented API: it may change, and VYSTRAL stops quietly if it does.', attribution: 'Free games from the Epic Games Store.', host: 'store-site-backend-static.ak.epicgames.com', sends: 'Your price country, when the free-games list is refreshed (at most every few hours).', uses: 'This week’s and next week’s free games on the Epic Games Store, with exact dates.' },
  { id: 'protondb', name: 'ProtonDB', access: 'keyless', settingKey: 'dataSources.protondb', licence: 'Community reports, ODbL. Shown with attribution; looked up on this PC only, never redistributed. Not a documented API.', attribution: 'Linux compatibility from ProtonDB.com.', host: 'www.protondb.com', sends: 'A game’s Steam app ID (its own or the matched one), when you open that game’s page.', uses: 'How well a game runs on Linux and Steam Deck through Proton, as rated by players.' },
  { id: 'gogcatalog', name: 'GOG catalogue', access: 'keyless', settingKey: 'dataSources.gogCatalog', licence: 'GOG’s public store data, shown with attribution. Not a documented API: it may change, and VYSTRAL stops quietly if it does.', attribution: 'Store IDs and trailers from GOG.com.', host: 'catalog.gog.com, api.gog.com', sends: 'Titles of games that aren’t from GOG (to find their GOG page), and GOG product IDs when you open a game’s page.', uses: 'Matching games to their GOG page, and GOG’s trailer list (YouTube) for the trailer fallback.' },
];

type Plan = { status: 'matched' | 'suggested' | 'conflict' | 'none'; steam: { value: string; name: string; year: number; evidence: IdEvidence[] }[]; igdb?: string; rawg?: string; qid?: string };

/** The fictional matches, by library title. */
const PLANS: Record<string, Plan> = {
  'Circuit Apex': {
    status: 'matched', igdb: '501234', rawg: 'circuit-apex', qid: 'Q99000101',
    steam: [{ value: '9100101', name: 'Circuit Apex', year: 2024, evidence: [{ source: 'wikidata', method: 'exactTitleYear', confidence: 0.85 }, { source: 'steam', method: 'exactTitleYear', confidence: 0.85 }] }],
  },
  'Velvet Orbit': {
    status: 'suggested', igdb: '501240',
    steam: [{ value: '9100102', name: 'Velvet Orbit', year: 2023, evidence: [{ source: 'steam', method: 'exactTitle', confidence: 0.7 }] }],
  },
  'Kingsfall Remastered': {
    status: 'conflict',
    steam: [
      { value: '9100103', name: 'Kingsfall Remastered', year: 2022, evidence: [{ source: 'wikidata', method: 'exactTitleYear', confidence: 0.85 }] },
      { value: '9100104', name: 'Kingsfall', year: 2009, evidence: [{ source: 'steam', method: 'editionTitle', confidence: 0.75 }] },
    ],
  },
};

/** Your fictional choices this session (preview only). */
const pins = new Map<string, string | null>();

const isSteam = (g: Game) => g.installations.some((i) => i.platform === 'steam');
const level = (c: number): ResolvedId['level'] => (c >= 0.99 ? 'certain' : c >= 0.9 ? 'high' : c >= 0.8 ? 'good' : c >= 0.6 ? 'medium' : 'low');
const combine = (ev: IdEvidence[]) => Math.min(0.99, 1 - ev.reduce((a, e) => a * (1 - e.confidence), 1));

/** The Steam app a preview game's Steam sections use (its own, your choice, or a used match), like IdentityResolverService.SteamAppFor. */
export function previewSteamAppFor(game: Game, settings: Settings): { appId: string; via: 'matched' | 'pinned' | null } | null {
  const own = game.installations.find((i) => i.platform === 'steam')?.platformGameId;
  if (own) return { appId: own, via: null };
  if (pins.has(game.id)) {
    const v = pins.get(game.id);
    return v ? { appId: v, via: 'pinned' } : null;
  }
  const plan = PLANS[game.title];
  if (!settings['dataSources.identityMatch'] || plan?.status !== 'matched') return null;
  return { appId: plan.steam[0].value, via: 'matched' };
}

export function identityPreviewHandlers(ctx: Ctx): Record<string, (p: any) => unknown> {
  const find = (id: string) => {
    const g = ctx.lib.games.find((x) => x.id === id);
    if (!g) throw new BridgeError('notFound', 'That game no longer exists.');
    return g;
  };
  const searched = new Map<string, SteamSearchHit>();

  const resolve = (g: Game): ResolvedIdentity => {
    const s = ctx.settings();
    const base = { gameId: g.id, canCheck: !isSteam(g) && s['dataSources.identityMatch'] && !s['privacy.localOnly'], checkedAt: new Date(Date.now() - 3 * 3600_000).toISOString() };
    const reason: ResolvedIdentity['reason'] = !s['dataSources.identityMatch'] ? 'off' : s['privacy.localOnly'] ? 'offline' : null;
    if (isSteam(g)) {
      const appId = g.installations.find((i) => i.platform === 'steam')!.platformGameId;
      const steam: ResolvedId = { kind: 'steam', label: 'Steam', value: appId, confidence: 1, level: 'certain', status: 'native', used: true, evidence: [{ source: 'store', method: 'native', confidence: 1 }], name: g.title, link: true };
      const wd: ResolvedId = { kind: 'wikidata', label: 'Wikidata', value: `Q9${appId.slice(-6)}`, confidence: 0.95, level: 'high', status: 'matched', used: true, evidence: [{ source: 'wikidata', method: 'storeId', confidence: 0.95 }], name: g.title, link: true };
      return { ...base, status: 'native', steam, ids: [steam, wd], steamCandidates: [], asked: [], reason: null };
    }
    const plan = PLANS[g.title];
    const candidates: IdCandidate[] = (plan?.steam ?? []).map((c) => ({ kind: 'steam', value: c.value, name: c.name, year: c.year, confidence: combine(c.evidence), sources: [...new Set(c.evidence.map((e) => e.source))] }));
    const others: ResolvedId[] = [];
    if (plan?.igdb && s['dataSources.identityMatch']) others.push({ kind: 'igdb', label: 'IGDB', value: plan.igdb, confidence: 0.85, level: 'good', status: 'matched', used: true, evidence: [{ source: 'igdb', method: 'exactTitleYear', confidence: 0.85 }], name: g.title, link: false });
    if (plan?.rawg && s['dataSources.identityMatch']) others.push({ kind: 'rawg', label: 'RAWG', value: plan.rawg, confidence: 0.85, level: 'good', status: 'matched', used: true, evidence: [{ source: 'wikidata', method: 'exactTitleYear', confidence: 0.85 }], name: g.title, link: true });
    if (plan?.qid && s['dataSources.identityMatch']) others.push({ kind: 'wikidata', label: 'Wikidata', value: plan.qid, confidence: 0.85, level: 'good', status: 'matched', used: true, evidence: [{ source: 'wikidata', method: 'exactTitleYear', confidence: 0.85 }], name: g.title, link: true });
    const asked: ResolvedIdentity['asked'] = reason === 'off' ? [] : ['wikidata', 'steam'];

    if (pins.has(g.id)) {
      const v = pins.get(g.id) ?? null;
      if (v === null) return { ...base, status: 'notOnSteam', steam: null, ids: others, steamCandidates: candidates, asked, reason };
      const name = plan?.steam.find((c) => c.value === v)?.name ?? searched.get(v)?.name ?? null;
      const steam: ResolvedId = { kind: 'steam', label: 'Steam', value: v, confidence: 1, level: 'certain', status: 'pinned', used: true, evidence: [{ source: 'pin', method: 'chosen', confidence: 1 }], name, link: true };
      return { ...base, status: 'pinned', steam, ids: [steam, ...others], steamCandidates: candidates, asked, reason };
    }
    if (!s['dataSources.identityMatch']) return { ...base, status: 'notChecked', steam: null, ids: [], steamCandidates: [], asked: [], reason };
    if (!plan || plan.status === 'none' || !plan.steam.length) return { ...base, status: 'none', steam: null, ids: others, steamCandidates: candidates, asked, reason };
    const best = plan.steam[0];
    const conf = plan.status === 'conflict' ? combine(best.evidence) : combine(best.evidence);
    const status: ResolvedId['status'] = plan.status === 'matched' ? 'matched' : plan.status === 'conflict' ? 'conflict' : 'suggested';
    const steam: ResolvedId = { kind: 'steam', label: 'Steam', value: best.value, confidence: Math.round(conf * 1000) / 1000, level: level(conf), status, used: status === 'matched', evidence: best.evidence, name: best.name, link: true };
    return { ...base, status: plan.status, steam, ids: [steam, ...others], steamCandidates: candidates, asked, reason };
  };

  const changed = (gameId: string) => ctx.emit()('identity.changed', { gameId });

  // ---------- Free games (fictional) ----------
  const soon = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19);
  const FREEBIES: Freebie[] = [
    { id: 'epic-0f3a9c1d2b4e6f70', source: 'epic', title: 'Lanternfall', store: 'epic', platforms: ['PC', 'Epic Games Store'], kind: 'game', status: 'now', worth: '$19.99', startsAt: soon(-2), endsAt: soon(5), description: 'A cosy lighthouse-keeping puzzle game.', image: null, hasImage: false },
    { id: 'gp-41001', source: 'gamerpower', title: 'Tin Soldiers Remastered', store: 'steam', platforms: ['PC', 'Steam'], kind: 'game', status: 'now', worth: '$9.99', startsAt: soon(-1), endsAt: soon(2), description: 'Free on Steam for a few days.', image: null, hasImage: false },
    { id: 'gp-41002', source: 'gamerpower', title: 'Starfall Tactics Pilot Pack', store: 'gog', platforms: ['PC', 'GOG'], kind: 'loot', status: 'now', worth: null, startsAt: soon(-3), endsAt: null, description: 'Cosmetic DLC.', image: null, hasImage: false },
    // Track D5: a giveaway for a game the preview library already has on Epic ("In your library" on the shelf).
    { id: 'gp-41003', source: 'gamerpower', title: 'Moss & Marrow', store: 'epic', platforms: ['PC', 'Epic Games Store'], kind: 'game', status: 'now', worth: '$14.99', startsAt: soon(-1), endsAt: soon(6), description: 'Free on Epic this week.', image: null, hasImage: false },
    { id: 'epic-9a8b7c6d5e4f3a21', source: 'epic', title: 'Hollow Meridian', store: 'epic', platforms: ['PC', 'Epic Games Store'], kind: 'game', status: 'upcoming', worth: '$24.99', startsAt: soon(5), endsAt: soon(12), description: 'Next week’s free game.', image: null, hasImage: false },
  ];

  return {
    'identity.resolved': (p: { gameId: string; refresh?: boolean }) => resolve(find(p.gameId)),
    'identity.pin': (p: { gameId: string; kind: string; value: string | null }) => {
      const g = find(p.gameId);
      if (isSteam(g)) throw new BridgeError('invalid', 'This game is a Steam game; its Steam app comes from Steam itself.');
      if (p.kind !== 'steam') throw new BridgeError('invalid', 'Unknown ID kind.');
      if (p.value !== null && !/^[1-9][0-9]{0,9}$/.test(p.value)) throw new BridgeError('invalid', 'That ID doesn’t look right.');
      pins.set(g.id, p.value);
      changed(g.id);
      return resolve(g);
    },
    'identity.unpin': (p: { gameId: string; kind: string }) => {
      const g = find(p.gameId);
      pins.delete(g.id);
      changed(g.id);
      return resolve(g);
    },
    'identity.searchSteam': (p: { gameId: string; query: string }): SteamSearchHit[] => {
      if (ctx.settings()['privacy.localOnly']) throw new BridgeError('offline', 'Offline mode is on, so VYSTRAL doesn’t search Steam.');
      const q = p.query.trim();
      const hits = [q, `${q} Deluxe Edition`, `${q}: Prologue`].map((name, i) => ({ appId: String(9200000 + ((q.length * 97 + i * 13) % 99_000)), name }));
      hits.forEach((h) => searched.set(h.appId, h));
      return hits;
    },
    'identity.openId': () => true,

    'freebies.get': (): Freebies => {
      const s = ctx.settings();
      const gp = s['dataSources.gamerpower'];
      const epic = s['dataSources.epicFreeGames'];
      const at = new Date(Date.now() - 40 * 60_000).toISOString();
      const sources: Freebies['sources'] = [
        { id: 'gamerpower', name: 'GamerPower', enabled: gp, fetchedAt: gp ? at : null, stale: false, error: null, attribution: 'Giveaways from GamerPower.com' },
        { id: 'epicfree', name: 'Epic Games Store', enabled: epic, fetchedAt: epic ? at : null, stale: false, error: null, attribution: 'Free games from the Epic Games Store' },
      ];
      if (!gp && !epic) return { items: [], sources, reason: 'off' };
      return { items: FREEBIES.filter((f) => (f.source === 'epic' ? epic : gp)), sources, reason: s['privacy.localOnly'] ? 'offline' : null };
    },
    'freebies.image': () => null,
    'freebies.open': (p: { id: string }) => {
      if (!FREEBIES.some((f) => f.id === p.id)) throw new BridgeError('notFound', 'That giveaway is no longer listed. Refresh the list.');
      return true;
    },

    'protondb.get': (p: { gameId?: string; key?: string; appId?: string | null }): ProtonSummary => {
      const s = ctx.settings();
      const g = p.gameId ? find(p.gameId) : null;
      const app = g ? previewSteamAppFor(g, s) : p.appId ? { appId: p.appId, via: null } : null;
      const base: ProtonSummary = { status: 'off', message: null, appId: app?.appId ?? null, via: app?.via ?? null, tier: null, bestReported: null, trending: null, total: 0, confidence: null, fetchedAt: null, stale: false };
      if (!s['dataSources.protondb']) return base;
      if (!app) return { ...base, status: 'notSteam' };
      const tiers = ['platinum', 'gold', 'silver', 'bronze', 'borked'] as const;
      const n = [...app.appId].reduce((a, c) => a + c.charCodeAt(0), 0);
      const tier = tiers[n % tiers.length];
      return { ...base, status: 'ok', tier, bestReported: tiers[Math.max(0, (n % tiers.length) - 1)], trending: tier, total: 40 + (n * 37) % 2400, confidence: 'good', fetchedAt: new Date(Date.now() - 86400_000).toISOString() };
    },
    'protondb.open': () => true,

    // Trailers from other sources (fictional): Circuit Apex's comes from "RAWG" (a local loop); Velvet Orbit's from IGDB on YouTube.
    'trailer.get': (p: { gameId: string }): TrailerInfo => {
      const s = ctx.settings();
      const g = ctx.lib.games.find((x) => x.id === p.gameId);
      const blocked = s['privacy.localOnly'] ? 'offline' : s['dataSaver.enabled'] ? 'dataSaver' : null;
      const none = (reason: TrailerInfo['reason'], source = 'Steam'): TrailerInfo => ({ available: false, kind: null, src: null, name: null, reason, source });
      if (!g) return none(blocked ?? 'notChecked');
      if (g.title === 'Circuit Apex' && s['dataSources.identityMatch']) {
        if (blocked) return none(blocked, 'RAWG');
        return { available: true, kind: 'file', src: `${liveTileLoop}#rawg`, name: 'Launch trailer', reason: null, source: 'RAWG' };
      }
      if (g.title === 'Velvet Orbit' && params().has('youtube')) {
        if (blocked) return none(blocked, 'IGDB');
        if (!s['trailers.youtube']) return none('youtubeOff', 'IGDB');
        return { available: true, kind: 'youtube', src: 'https://www.youtube-nocookie.com/embed/aaaaaaaaaaa', name: 'Reveal Trailer', reason: null, source: 'IGDB' };
      }
      // Preview can't reach Steam's video CDN, so other trailers are honestly unavailable here.
      return none(blocked ?? 'notChecked');
    },
  };
}
