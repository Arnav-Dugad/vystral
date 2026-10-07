/**
 * Track W preview handlers: wishlist, friends' recent games, achievement guide and news. Everything here
 * is fictional; images are drawn locally as SVG data URIs (preview never touches the network).
 *
 * URL switches:
 * - `?wishlist` turns the (opt-in) wishlist on with a dozen fictional games; `?wishlist=empty` has none;
 *   `?wishlist=loading` is still on its first refresh; `?wishlist=invalid` simulates a rejected key.
 * - `?friendsHistory` turns friends' recent games on (Nebula Drift has three friends); `?friendsHistory=loading`
 *   is the first, slow round.
 * - `?news` lists fictional posts on Steam games' News tab with one "since you last played"; `?news=empty` has
 *   none; `?news=offline` shows saved posts in Offline mode.
 * - `?achGuide` pins a current goal on Nebula Drift (the guide itself works on every Steam game).
 */
import type {
  AchievementGuide, AchievementsResult, FriendPlayed, FriendsHistory, Game, GuideAchievement, NewsBlock, NewsFeed, NewsPost, Settings,
  SteamApiStatus, Wishlist, WishlistItem, WishlistPoint, WishlistRefreshResult,
} from './types';
import { BridgeError } from './bridge';

export const TRACK_W_DEFAULT_SETTINGS: Pick<Settings, 'wishlist.sync' | 'notifications.wishlist' | 'friends.gameHistory' | 'news.patchNotes'> = {
  'wishlist.sync': false,
  'notifications.wishlist': true,
  'friends.gameHistory': false,
  'news.patchNotes': true,
};

/** Settings the URL switches turn on at start. */
export function previewTrackWSettings(params: URLSearchParams): Partial<Settings> {
  return {
    ...(params.has('wishlist') ? { 'wishlist.sync': true } : {}),
    ...(params.has('friendsHistory') ? { 'friends.gameHistory': true } : {}),
  };
}

type Emit = (name: string, payload: unknown) => void;

interface Ctx {
  lib: { games: Game[] };
  emit: () => Emit;
  settings: () => Settings;
  steamStatus: () => SteamApiStatus;
  achievements: (gameId: string) => Promise<AchievementsResult>;
  timers: number[];
}

const DAY = 86_400_000;

function art(title: string, hue: number, w = 460, h = 215): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 62% 34%)"/><stop offset="1" stop-color="hsl(${(hue + 70) % 360} 58% 14%)"/></linearGradient><radialGradient id="r" cx="0.78" cy="0.2" r="0.7"><stop offset="0" stop-color="hsl(${(hue + 30) % 360} 90% 70% / .55)"/><stop offset="1" stop-color="transparent"/></radialGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#r)"/><text x="24" y="${h - 28}" font-family="Segoe UI, sans-serif" font-size="30" font-weight="700" fill="rgba(255,255,255,.92)">${title.replace(/[<&>]/g, '')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function avatar(name: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 58%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 65% 32%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="42" font-family="Segoe UI, sans-serif" font-size="28" font-weight="600" text-anchor="middle" fill="rgba(255,255,255,.92)">${name[0]}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A fictional price walk: regular price with sales at the given days back. */
function history(regular: number, sales: [daysAgo: number, cents: number, lengthDays: number][], start: number, now: number): WishlistPoint[] {
  const points: WishlistPoint[] = [{ day: dayOf(now - start * DAY), cents: regular }];
  for (const [ago, cents, len] of sales.sort((a, b) => b[0] - a[0])) {
    points.push({ day: dayOf(now - ago * DAY), cents });
    if (ago - len > 0) points.push({ day: dayOf(now - (ago - len) * DAY), cents: regular });
  }
  return points;
}

interface Seed {
  appId: string; name: string; hue: number; priority: number; addedDaysAgo: number;
  release?: number; comingSoon?: boolean; releaseText?: string; free?: boolean; notSold?: boolean;
  regular?: number; price?: number; low?: number; lowSource?: 'itad' | 'cheapshark'; sales?: [number, number, number][]; owned?: string;
}

const SEEDS: Seed[] = [
  { appId: '2480010', name: 'Aurora Vanguard', hue: 205, priority: 1, addedDaysAgo: 220, release: -420, regular: 5999, price: 2999, low: 2999, lowSource: 'itad', sales: [[180, 4199, 14], [60, 3599, 10], [3, 2999, 99]] },
  { appId: '2480020', name: 'Lantern Shore', hue: 40, priority: 2, addedDaysAgo: 140, release: 0, comingSoon: false, regular: 2499, price: 2499, low: 2499, lowSource: 'itad', sales: [] },
  { appId: '2480030', name: 'Halcyon Depths', hue: 260, priority: 3, addedDaysAgo: 90, release: 3, comingSoon: true, releaseText: undefined },
  { appId: '2480040', name: 'Saltwind Chronicle', hue: 165, priority: 4, addedDaysAgo: 380, release: -900, regular: 3999, price: 1599, low: 1199, lowSource: 'itad', sales: [[300, 1999, 14], [200, 1199, 7], [120, 1999, 10], [8, 1599, 99]] },
  { appId: '2480050', name: 'Ironbloom', hue: 120, priority: 5, addedDaysAgo: 30, release: -60, regular: 1999, price: 1999, low: 1499, lowSource: 'itad', sales: [[40, 1499, 7]] },
  { appId: '2480060', name: 'Paper Lanterns II', hue: 330, priority: 6, addedDaysAgo: 12, comingSoon: true, releaseText: 'Q2 2027' },
  { appId: '2480070', name: 'Starward Couriers', hue: 285, priority: 7, addedDaysAgo: 400, release: -1600, regular: 1499, price: 374, low: 374, lowSource: 'itad', sales: [[700, 749, 14], [365, 599, 10], [180, 449, 7], [2, 374, 99]] },
  { appId: '2480080', name: 'Glacier Run', hue: 190, priority: 8, addedDaysAgo: 75, release: -30, free: true },
  { appId: '2480090', name: 'Mirewood', hue: 95, priority: 9, addedDaysAgo: 50, release: 41, comingSoon: true, notSold: true },
  { appId: '2480100', name: 'Vesper Protocol', hue: 15, priority: 0, addedDaysAgo: 5, release: -12, regular: 3499, price: 2799, low: 2449, lowSource: 'itad', sales: [[10, 2799, 99]] },
  { appId: '2480110', name: 'Clockwork Pilgrim', hue: 50, priority: 10, addedDaysAgo: 600, release: -2400, regular: 999, price: 999, low: 199, lowSource: 'itad', sales: [[900, 299, 7], [500, 199, 3], [200, 249, 7]] },
  { appId: '2480120', name: 'Deep Field', hue: 230, priority: 11, addedDaysAgo: 700, release: -800, regular: 2999, price: 2999, low: 1499, lowSource: 'itad', owned: 'Deep Field' },
];

export function trackWPreviewHandlers(ctx: Ctx): Record<string, (p: any) => unknown> {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const wishMode = params.get('wishlist') ?? '';
  const friendsMode = params.get('friendsHistory') ?? '';
  const newsMode = params.get('news') ?? '';
  const now = Date.now();
  let fetchedAt = now - 2 * 3600_000;
  let refreshing = wishMode === 'loading';
  const goals = new Map<string, string>();
  const revealed = new Set<string>();

  const findGame = (id: string) => {
    const g = ctx.lib.games.find((x) => x.id === id);
    if (!g) throw new BridgeError('notFound', 'That item no longer exists.');
    return g;
  };
  const steamApp = (g: Game) => g.installations.find((i) => i.platform === 'steam')?.platformGameId ?? null;

  // ---------- Wishlist ----------

  const items = (): WishlistItem[] => SEEDS.map((s) => {
    const owned = s.owned ? ctx.lib.games.find((g) => g.title === s.owned) : undefined;
    const releaseMs = s.release == null ? null : s.release === 0 ? new Date(new Date(now).setHours(9, 0, 0, 0)).getTime() : now + s.release * DAY;
    const priced = !s.free && !s.notSold && s.price != null;
    const regular = s.regular ?? null;
    return {
      appId: s.appId, name: s.name, priority: s.priority, added: new Date(now - s.addedDaysAgo * DAY).toISOString(),
      releaseDate: releaseMs == null ? null : new Date(releaseMs).toISOString(), comingSoon: s.comingSoon ?? false, releaseText: s.releaseText ?? null,
      isFree: s.free ?? false,
      priceCents: priced ? s.price! : null, regularCents: priced ? regular : null,
      discount: priced && regular ? Math.round((1 - s.price! / regular) * 100) : 0,
      currency: priced ? 'USD' : null, priceText: priced ? `$${(s.price! / 100).toFixed(2)}` : null, notSold: s.notSold ?? false,
      lowestCents: s.low ?? null, lowestCurrency: s.low != null ? 'USD' : null, lowestSource: s.lowSource ?? null,
      lowestAt: s.low != null ? new Date(now - 30 * DAY).toISOString() : null,
      history: priced && regular ? history(regular, s.sales ?? [], Math.min(s.addedDaysAgo, 360), now) : [],
      header: art(s.name, s.hue), gameId: owned?.id ?? null, pricedAt: new Date(fetchedAt).toISOString(),
    };
  });

  const wishlist = (): Wishlist => {
    const s = ctx.settings();
    const base: Wishlist = { status: 'ok', message: null, fetchedAt: null, stale: false, refreshing: false, count: 0, items: [], retryAt: null, country: s['dataSources.priceCountry'] ?? 'US', lowestSource: 'IsThereAnyDeal' };
    if (!s['wishlist.sync']) return { ...base, status: 'off' };
    if (!ctx.steamStatus().configured) return { ...base, status: 'notConnected' };
    if (wishMode === 'invalid') return { ...base, status: 'invalidKey', message: 'Steam didn’t accept your Web API key. Check it in Settings → Library & stores.', retryAt: new Date(now + 30 * 60_000).toISOString() };
    if (refreshing && wishMode === 'loading') return { ...base, status: 'notLoaded', refreshing: true };
    if (wishMode === 'empty') return { ...base, status: 'empty', fetchedAt: new Date(fetchedAt).toISOString(), message: 'Steam didn’t list any games. If your wishlist isn’t empty, check that your Steam profile’s Game details are public.' };
    const list = items();
    const offline = s['privacy.localOnly'];
    return {
      ...base, fetchedAt: new Date(fetchedAt).toISOString(), refreshing, count: list.length, items: list,
      message: offline ? 'Offline mode is on, so this is the wishlist saved on this PC.' : null,
    };
  };

  // ---------- Friends' recent games ----------

  const FRIENDS: [string, number][] = [['Juniper', 280], ['Rook', 200], ['Saffron', 30], ['Atlas', 150], ['Wren', 330], ['Quill', 100]];
  const friendsFor = (title: string, seed: number): FriendPlayed[] => {
    if (title === 'Nebula Drift') return [
      { key: 'f1a1b2c3d4e5f601', name: 'Juniper', avatar: avatar('Juniper', 280), minutesTwoWeeks: 412 },
      { key: 'f1a1b2c3d4e5f602', name: 'Rook', avatar: avatar('Rook', 200), minutesTwoWeeks: 185 },
      { key: 'f1a1b2c3d4e5f603', name: 'Saffron', avatar: null, minutesTwoWeeks: 48 },
    ];
    const n = seed % 4 === 0 ? 0 : seed % 3;
    return FRIENDS.slice(seed % 3, (seed % 3) + n).map(([name, hue], i) => ({ key: `f1a1b2c3d4e5f6${10 + i}`, name, avatar: avatar(name, hue), minutesTwoWeeks: 30 + ((seed * (i + 3)) % 300) }));
  };

  // ---------- News ----------

  const lastPlayedOf = (g: Game): number | null => {
    const times = [g.lastTrackedPlay, ...g.installations.map((i) => i.importedLastPlayed)].filter((t): t is string => !!t).map((t) => Date.parse(t));
    return times.length ? Math.max(...times) : null;
  };
  const sp = (text: string, bold = false): { text: string; bold?: boolean } => (bold ? { text, bold } : { text });
  const block = (kind: NewsBlock['kind'], ...spans: { text: string; bold?: boolean }[]): NewsBlock => ({ kind, spans, image: null, imageId: null });
  const loadedImages = new Set<string>();

  const posts = (g: Game): NewsPost[] => {
    const last = lastPlayedOf(g) ?? now - 20 * DAY;
    const sinceLast = Math.min(now - 3600_000, last + 2 * DAY);
    const make = (gid: string, title: string, date: number, patch: boolean, blocks: NewsBlock[], author = `${g.title} team`): NewsPost => {
      const withImages = blocks.map((b) => (b.kind === 'img' ? { ...b, image: loadedImages.has(gid) ? art(`${g.title}`, (gid.length * 37) % 360, 960, 420) : null } : b));
      const text = blocks.filter((b) => b.kind !== 'img').map((b) => b.spans.map((s) => s.text).join('')).join(' ');
      return {
        gid, title, author, date: new Date(date).toISOString(), patch, excerpt: text.length > 220 ? `${text.slice(0, text.lastIndexOf(' ', 218))}…` : text,
        blocks: withImages, images: blocks.filter((b) => b.kind === 'img').length, imagesLoaded: loadedImages.has(gid) ? blocks.filter((b) => b.kind === 'img').length : 0,
      };
    };
    const img: NewsBlock = { kind: 'img', spans: [], image: null, imageId: 'a1b2c3d4e5f6' };
    return [
      make('5124585837390000001', 'Patch 1.4.2: smoother frame pacing and save fixes', sinceLast, true, [
        block('p', sp('This update focuses on stability. Thank you to everyone who sent reports after the last patch.')),
        img,
        block('h', sp('Fixes')),
        block('li', sp('Fixed a rare crash when loading a save made during a cutscene.')),
        block('li', sp('Frame pacing is steadier on '), sp('high refresh rate', true), sp(' displays.')),
        block('li', sp('Controller vibration no longer continues after pausing.')),
        block('h', sp('Balance')),
        block('p', sp('Boost recharge is 10% faster in Time Trial.\nGhost replays from older versions still load.')),
        block('quote', sp('We read every report. Keep them coming.')),
      ]),
      make('5124585837390000002', 'Community spotlight: your best photo-mode shots', last - 5 * DAY, false, [
        block('p', sp('Every month we pick ten photo-mode shots from the community. This month’s theme was '), sp('night light', true), sp('.')),
        img,
        block('p', sp('Share yours in the community hub with the photo-mode tag for a chance to be featured next time.')),
      ]),
      make('5124585837390000003', 'Hotfix 1.4.1', last - 12 * DAY, true, [
        block('li', sp('Fixed the options menu resetting the language to English.')),
        block('li', sp('Fixed achievements not unlocking in offline mode.')),
        block('code', sp('Build 1.4.1 (12483)')),
      ]),
      make('5124585837390000004', 'Version 1.4: the Night Circuits update is out now', last - 26 * DAY, true, [
        block('p', sp('Six new night tracks, a new photo mode and a rebuilt career mode are live now. Here is everything that changed.')),
        block('hr'),
        block('h', sp('New')),
        block('li', sp('Six night circuits with dynamic lighting.')),
        block('li', sp('Photo mode with depth of field and film grain.')),
        block('h', sp('Changed')),
        block('p', sp('Career mode now saves after every race.')),
      ]),
    ];
  };

  const handlers: Record<string, (p: any) => unknown> = {
    'wishlist.get': wishlist,
    'wishlist.refresh': (): WishlistRefreshResult => {
      const s = ctx.settings();
      if (!s['wishlist.sync']) return { started: false, reason: 'off', wishlist: wishlist() };
      if (s['privacy.localOnly']) return { started: false, reason: 'offline', wishlist: wishlist() };
      if (refreshing) return { started: false, reason: 'running', wishlist: wishlist() };
      refreshing = true;
      ctx.timers.push(window.setTimeout(() => {
        refreshing = false;
        fetchedAt = Date.now();
        ctx.emit()('wishlist.changed', { refreshing: false });
      }, wishMode === 'loading' ? 1800 : 1100));
      return { started: true, reason: null, wishlist: wishlist() };
    },
    'wishlist.openStore': (p: { appId: string }) => {
      if (!SEEDS.some((s) => s.appId === p?.appId)) throw new BridgeError('notFound', 'That game isn’t on your wishlist anymore.');
      return true;
    },

    'friends.gameHistory': (p: { gameId: string }): FriendsHistory => {
      const g = findGame(p.gameId);
      const s = ctx.settings();
      const empty = (status: FriendsHistory['status'], message: string | null = null): FriendsHistory =>
        ({ status, message, fetchedAt: null, refreshing: false, friends: [], totalMinutes: 0, checked: 0, publicFriends: 0, friendCount: 0 });
      if (!s['friends.gameHistory']) return empty('off');
      if (!ctx.steamStatus().configured) return empty('notConnected');
      const appId = steamApp(g);
      if (!appId) return empty('notSteam');
      if (friendsMode === 'loading') return { ...empty('notLoaded'), refreshing: true };
      if (s['privacy.localOnly']) return { ...empty('offline', 'Offline mode is on, so VYSTRAL doesn’t ask Steam what your friends played.') };
      const seed = [...g.id].reduce((a, c) => a + c.charCodeAt(0), 0);
      const friends = friendsFor(g.title, seed);
      return {
        status: 'ok', message: null, fetchedAt: new Date(now - 95 * 60_000).toISOString(), refreshing: false, friends,
        totalMinutes: friends.reduce((t, f) => t + f.minutesTwoWeeks, 0), checked: 38, publicFriends: 38, friendCount: 52,
      };
    },

    'achievements.guide': async (p: { gameId: string }): Promise<AchievementGuide> => {
      const data = await ctx.achievements(p.gameId);
      const toGuide = (a: AchievementsResult['achievements'][number]): GuideAchievement => ({
        apiName: a.apiName, name: a.name, description: a.hidden && !a.achieved ? null : a.description, hidden: a.hidden,
        globalPercent: a.globalPercent, icon: a.icon, achieved: a.achieved, unlockedAt: a.unlockedAt,
      });
      const next = data.achievements.map((a, i) => ({ a, i })).filter((x) => !x.a.achieved)
        .sort((x, y) => Number(x.a.globalPercent == null) - Number(y.a.globalPercent == null) || (y.a.globalPercent ?? 0) - (x.a.globalPercent ?? 0) || x.i - y.i)
        .slice(0, 12).map((x) => toGuide(x.a));
      const goalName = goals.get(p.gameId);
      const goal = goalName ? data.achievements.find((a) => a.apiName === goalName) : undefined;
      return {
        status: data.status, message: data.message, total: data.total, unlocked: data.unlocked,
        hiddenLocked: data.achievements.filter((a) => a.hidden && !a.achieved).length, next, goal: goal ? toGuide(goal) : null, fetchedAt: data.fetchedAt,
      };
    },
    'achievements.goal': async (p: { gameId: string }): Promise<GuideAchievement | null> => {
      const name = goals.get(p.gameId);
      if (!name) return null;
      const data = await ctx.achievements(p.gameId);
      const a = data.achievements.find((x) => x.apiName === name);
      return a ? { apiName: a.apiName, name: a.name, description: a.hidden && !a.achieved ? null : a.description, hidden: a.hidden, globalPercent: a.globalPercent, icon: a.icon, achieved: a.achieved, unlockedAt: a.unlockedAt } : null;
    },
    'achievements.reveal': (p: { gameId: string; apiName: string }) => {
      revealed.add(`${p.gameId}:${p.apiName}`);
      const n = Number(p.apiName.replace(/\D/g, '')) || 0;
      return { description: `Sample hidden achievement ${n + 1}: finish a fictional chapter without being spotted.` };
    },
    'achievements.setGoal': async (p: { gameId: string; apiName: string | null }) => {
      if (p.apiName) goals.set(p.gameId, p.apiName);
      else goals.delete(p.gameId);
      const goal = await handlers['achievements.goal']({ gameId: p.gameId }) as GuideAchievement | null;
      ctx.emit()('achievements.goalChanged', { gameId: p.gameId, goal });
      return goal;
    },

    'news.get': (p: { gameId: string; refresh?: boolean }): NewsFeed => {
      const g = findGame(p.gameId);
      const s = ctx.settings();
      if (!s['news.patchNotes']) return { status: 'off', message: null, fetchedAt: null, stale: false, posts: [] };
      if (!steamApp(g)) return { status: 'notSteam', message: null, fetchedAt: null, stale: false, posts: [] };
      if (newsMode === 'empty') return { status: 'none', message: null, fetchedAt: new Date(now - 20 * 60_000).toISOString(), stale: false, posts: [] };
      const offline = s['privacy.localOnly'] || newsMode === 'offline';
      return {
        status: 'ok', message: offline ? 'Offline mode is on, so these are the posts saved on this PC.' : null,
        fetchedAt: new Date(now - (offline ? 26 : 0.3) * 3600_000).toISOString(), stale: offline, posts: posts(g),
      };
    },
    'news.images': (p: { gameId: string; gid: string; force?: boolean }): NewsFeed => {
      const s = ctx.settings();
      if (!s['privacy.localOnly'] && (!s['dataSaver.enabled'] || p.force)) loadedImages.add(p.gid);
      return handlers['news.get']({ gameId: p.gameId }) as NewsFeed;
    },
    'news.open': () => true,
  };

  if (typeof window !== 'undefined') {
    // ?wishlist=loading: the first refresh finishes a moment after start.
    if (wishMode === 'loading') {
      ctx.timers.push(window.setTimeout(() => {
        refreshing = false;
        fetchedAt = Date.now();
        ctx.emit()('wishlist.changed', { refreshing: false });
      }, 2500));
    }
    // ?achGuide: pin Nebula Drift's easiest locked achievement (once every handler exists).
    const nebula = params.has('achGuide') ? ctx.lib.games.find((g) => g.title === 'Nebula Drift') : undefined;
    if (nebula) {
      ctx.timers.push(window.setTimeout(() => void ctx.achievements(nebula.id).then((d) => {
        const easiest = d.achievements.filter((a) => !a.achieved).sort((a, b) => (b.globalPercent ?? 0) - (a.globalPercent ?? 0))[0];
        if (easiest && !goals.has(nebula.id)) goals.set(nebula.id, easiest.apiName);
      }), 0));
    }
  }
  return handlers;
}
