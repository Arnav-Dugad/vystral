/**
 * Track D5: "Free this week" helpers over Track D4's freebies.get (GamerPower and Epic's free-games feed) — validating
 * what came back, folding the same giveaway seen by both sources, which ones you already own, the shelf order and
 * honest wording. Pure (tested in freebies.test.ts).
 */
import type { Freebie, Freebies, Game, PlatformKey } from '../bridge/types';
import { baseTitle, titleKey } from './discover';

export const FREEBIE_STORE: Record<Freebie['store'], string> = {
  steam: 'Steam', epic: 'Epic Games Store', gog: 'GOG', itch: 'itch.io', xbox: 'Microsoft Store', ubisoft: 'Ubisoft Store', ea: 'EA app',
  battlenet: 'Battle.net', other: 'its store',
};

/** The library platform a giveaway's store corresponds to (for "you own it there"). */
const PLATFORM_OF: Partial<Record<Freebie['store'], PlatformKey>> = { steam: 'steam', epic: 'epic', gog: 'gog', ubisoft: 'ubisoft', ea: 'ea', xbox: 'xbox', battlenet: 'battlenet' };

const STORES = new Set(Object.keys(FREEBIE_STORE));
/** Same shapes as FreebiesService.ItemId on the native side. */
export const FREEBIE_ID = /^(gp-\d{1,9}|epic-[0-9a-f]{16,32})$/;
const MAX_ITEMS = 60;

const iso = (v: unknown) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

/**
 * Keeps only well-formed items (third-party data, even after the native side checked it), capped. GamerPower also
 * lists Epic's giveaways: when both sources have the same game on the same store, Epic's own entry (exact dates) wins.
 */
export function cleanFreebies(raw: unknown): Freebies | null {
  const r = raw as Freebies | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.items)) return null;
  const items: Freebie[] = [];
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const x of r.items) {
    if (!x || typeof x !== 'object') continue;
    if (typeof x.id !== 'string' || !FREEBIE_ID.test(x.id) || ids.has(x.id)) continue;
    if (typeof x.title !== 'string' || !x.title.trim() || x.title.length > 200) continue;
    const store = STORES.has(x.store) ? x.store : 'other';
    const kind = x.kind === 'loot' || x.kind === 'beta' ? x.kind : 'game';
    const status = x.status === 'upcoming' ? 'upcoming' : 'now';
    const image = typeof x.image === 'string' && x.image.startsWith('https://art.vystral.example/') ? x.image : null;
    const worth = typeof x.worth === 'string' && x.worth.length <= 24 && !/^n\/?a$/i.test(x.worth.trim()) ? x.worth.trim() : null;
    const item: Freebie = {
      id: x.id, source: x.source === 'epic' ? 'epic' : 'gamerpower', title: x.title.trim(), store, kind, status, worth, image,
      platforms: Array.isArray(x.platforms) ? x.platforms.filter((p) => typeof p === 'string').slice(0, 8) : [],
      startsAt: iso(x.startsAt), endsAt: iso(x.endsAt), description: typeof x.description === 'string' ? x.description.slice(0, 400) : null,
      hasImage: !!x.hasImage || !!image,
    };
    ids.add(item.id);
    const dupKey = `${store}|${titleKey(baseTitle(item.title))}`;
    const at = seen.get(dupKey);
    if (at != null) {
      if (item.source === 'epic' && items[at].source !== 'epic') items[at] = item;
      continue;
    }
    seen.set(dupKey, items.length);
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  const sources = Array.isArray(r.sources) ? r.sources.filter((s) => s && typeof s.id === 'string') : [];
  return { items, sources, reason: r.reason === 'off' || r.reason === 'offline' ? r.reason : null };
}

export interface Owned {
  game: Game;
  /** You own it on the giveaway's own store (so claiming adds nothing). */
  sameStore: boolean;
}

/** The library game a giveaway matches (by title, editions folded), if any. Hidden and refunded games don't count. */
export function ownedMatch(item: Pick<Freebie, 'title' | 'store' | 'kind'>, games: readonly Game[]): Owned | null {
  if (item.kind !== 'game') return null;
  const key = titleKey(baseTitle(item.title));
  if (!key) return null;
  const p = PLATFORM_OF[item.store];
  let best: Owned | null = null;
  for (const g of games) {
    if (g.notOwned || g.userHidden) continue;
    if (titleKey(baseTitle(g.title)) !== key) continue;
    const sameStore = !!p && g.installations.some((i) => i.platform === p && !i.noLongerOwned);
    if (!best || (sameStore && !best.sameStore)) best = { game: g, sameStore };
  }
  return best;
}

/** Claimable right now (started, not ended). */
export function isClaimable(item: Pick<Freebie, 'status' | 'startsAt' | 'endsAt'>, now: number): boolean {
  if (item.status === 'upcoming' && (!item.startsAt || Date.parse(item.startsAt) > now)) return false;
  return !item.endsAt || Date.parse(item.endsAt) > now;
}

/** Still worth showing: claimable now, or starting within the next two weeks. */
export function isShown(item: Pick<Freebie, 'status' | 'startsAt' | 'endsAt'>, now: number): boolean {
  if (item.endsAt && Date.parse(item.endsAt) <= now) return false;
  if (isClaimable(item, now)) return true;
  return !!item.startsAt && Date.parse(item.startsAt) - now < 14 * 86_400_000;
}

const startOf = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

function dayWords(t: number, now: number, locale?: string): string {
  const days = Math.round((startOf(t) - startOf(now)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(t));
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(t));
}

/** "Ends today", "Ends tomorrow", "Ends Thursday", "Ends 14 Oct"; null with no end date. `soon` = within 48 hours. */
export function endsLabel(endsAt: string | null | undefined, now: number, locale?: string): { text: string; soon: boolean } | null {
  if (!endsAt) return null;
  const t = Date.parse(endsAt);
  if (!Number.isFinite(t)) return null;
  if (t <= now) return { text: 'Ended', soon: true };
  return { text: `Ends ${dayWords(t, now, locale)}`, soon: t - now < 48 * 3600_000 };
}

/** "Free from Thursday" for a giveaway that hasn't started. */
export function startsLabel(startsAt: string | null | undefined, now: number, locale?: string): string | null {
  if (!startsAt) return null;
  const t = Date.parse(startsAt);
  return Number.isFinite(t) && t > now ? `Free from ${dayWords(t, now, locale)}` : null;
}

/**
 * Shelf order: claimable before upcoming; ones you already own on that store last; claimable ones ending within two
 * days first (soonest first); then by `rank` (higher first, e.g. how well it fits your taste); then soonest ending.
 */
export function orderFreebies(items: readonly Freebie[], games: readonly Game[], now: number, rank?: (id: string) => number): Freebie[] {
  const urgent = now + 48 * 3600_000;
  return items
    .filter((i) => isShown(i, now))
    .map((item, i) => {
      const end = item.endsAt ? Date.parse(item.endsAt) : Infinity;
      const claimable = isClaimable(item, now);
      return { item, i, later: claimable ? 0 : 1, owned: ownedMatch(item, games)?.sameStore ? 1 : 0, end, soon: claimable && end <= urgent ? 0 : 1, r: rank?.(item.id) ?? 0 };
    })
    .sort((a, b) => a.later - b.later || a.owned - b.owned || a.soon - b.soon || (a.soon === 0 ? a.end - b.end : 0) || b.r - a.r || a.end - b.end || a.i - b.i)
    .map((x) => x.item);
}

/** Whether every source that's on failed with nothing to show (for an honest "couldn't check" line). */
export function allFailed(f: Freebies): boolean {
  const on = f.sources.filter((s) => s.enabled);
  return f.items.length === 0 && on.length > 0 && on.every((s) => !!s.error);
}
