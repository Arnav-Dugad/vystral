/**
 * Track D5: "Free this week" helpers — validating what freebies.get returned, which giveaways you already own, the
 * order (still running, soonest ending first, then taste), and honest wording. Pure (tested in freebies.test.ts).
 */
import type { FreebieItem, FreebiePlatform, Freebies, Game, PlatformKey } from '../bridge/types';
import { titleKey, baseTitle } from './discover';

export const FREEBIE_STORE: Record<FreebiePlatform, string> = {
  steam: 'Steam', epic: 'Epic Games Store', gog: 'GOG', prime: 'Prime Gaming', itch: 'itch.io', ubisoft: 'Ubisoft Store', ea: 'EA app',
  xbox: 'Microsoft Store', battlenet: 'Battle.net', other: 'its store',
};

/** The library platform a giveaway's store corresponds to (for "you own it there"). */
const PLATFORM_OF: Partial<Record<FreebiePlatform, PlatformKey>> = { steam: 'steam', epic: 'epic', gog: 'gog', ubisoft: 'ubisoft', ea: 'ea', xbox: 'xbox', battlenet: 'battlenet' };

const PLATFORMS = new Set(Object.keys(FREEBIE_STORE));
const MAX_ITEMS = 60;

/** Keeps only well-formed items (third-party data, even after the native side checked it), capped. */
export function cleanFreebies(raw: unknown): Freebies | null {
  const r = raw as Freebies | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.items) || typeof r.state !== 'string') return null;
  const items: FreebieItem[] = [];
  const seen = new Set<string>();
  for (const x of r.items) {
    if (!x || typeof x !== 'object') continue;
    if (typeof x.id !== 'string' || !/^\d{1,10}$/.test(x.id) || seen.has(x.id)) continue;
    if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 200) continue;
    if (typeof x.url !== 'string' || !/^https:\/\//i.test(x.url)) continue;
    const platform = PLATFORMS.has(x.platform) ? x.platform : 'other';
    const image = typeof x.image === 'string' && /^(https:\/\/art\.vystral\.example\/|data:image\/)/.test(x.image) ? x.image : null;
    const endDate = typeof x.endDate === 'string' && Number.isFinite(Date.parse(x.endDate)) ? x.endDate : null;
    const worth = typeof x.worth === 'string' && x.worth.length <= 24 && !/^n\/?a$/i.test(x.worth.trim()) ? x.worth.trim() : null;
    seen.add(x.id);
    items.push({ id: x.id, title: x.title.trim(), platform, url: x.url, image, endDate, worth, kind: x.kind ?? 'game' });
    if (items.length >= MAX_ITEMS) break;
  }
  return { ...r, items };
}

/** "store.epicgames.com" — what the claim opens, shown so nobody is surprised. Null for anything that isn't https. */
export function claimHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

export interface Owned {
  game: Game;
  /** You own it on the giveaway's own store (so claiming adds nothing). */
  sameStore: boolean;
}

/** The library game a giveaway matches (by title, editions folded), if any. Hidden and refunded games don't count. */
export function ownedMatch(item: Pick<FreebieItem, 'title' | 'platform' | 'kind'>, games: readonly Game[]): Owned | null {
  if (item.kind === 'loot' || item.kind === 'dlc') return null;
  const key = titleKey(baseTitle(item.title));
  if (!key) return null;
  const p = PLATFORM_OF[item.platform];
  let best: Owned | null = null;
  for (const g of games) {
    if (g.notOwned || g.userHidden) continue;
    if (titleKey(baseTitle(g.title)) !== key) continue;
    const sameStore = !!p && g.installations.some((i) => i.platform === p && !i.noLongerOwned);
    if (!best || (sameStore && !best.sameStore)) best = { game: g, sameStore };
  }
  return best;
}

/** Still claimable at `now` (no end date = still listed). */
export function isRunning(item: Pick<FreebieItem, 'endDate'>, now: number): boolean {
  if (!item.endDate) return true;
  const t = Date.parse(item.endDate);
  return !Number.isFinite(t) || t > now;
}

/** "Ends today", "Ends tomorrow", "Ends Thursday", "Ends 14 Oct", or null with no end date. `soon` = within 48 hours. */
export function endsLabel(endDate: string | null | undefined, now: number, locale?: string): { text: string; soon: boolean } | null {
  if (!endDate) return null;
  const t = Date.parse(endDate);
  if (!Number.isFinite(t)) return null;
  if (t <= now) return { text: 'Ended', soon: true };
  const startOf = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((startOf(t) - startOf(now)) / 86_400_000);
  const soon = t - now < 48 * 3600_000;
  if (days <= 0) return { text: 'Ends today', soon };
  if (days === 1) return { text: 'Ends tomorrow', soon };
  if (days < 7) return { text: `Ends ${new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(t))}`, soon };
  return { text: `Ends ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(t))}`, soon };
}

/**
 * Running giveaways in shelf order: ones you already own on that store last; ones ending within two days first
 * (soonest first); then by `rank` (higher first, e.g. how well it fits your taste); then soonest ending.
 */
export function orderFreebies(items: readonly FreebieItem[], games: readonly Game[], now: number, rank?: (id: string) => number): FreebieItem[] {
  const urgent = now + 48 * 3600_000;
  return items
    .filter((i) => isRunning(i, now))
    .map((item, i) => {
      const end = item.endDate ? Date.parse(item.endDate) : Infinity;
      return { item, i, owned: ownedMatch(item, games)?.sameStore ? 1 : 0, end, soon: end <= urgent ? 0 : 1, r: rank?.(item.id) ?? 0 };
    })
    .sort((a, b) => a.owned - b.owned || a.soon - b.soon || (a.soon === 0 ? a.end - b.end : 0) || b.r - a.r || a.end - b.end || a.i - b.i)
    .map((x) => x.item);
}
