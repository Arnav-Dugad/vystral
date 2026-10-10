/**
 * Track I: pure helpers for data-source UI (prices, value timeline, compatibility and picker
 * labels). Everything here is deterministic and unit-tested; nothing touches the network.
 */
import { isCurrencyCode, moneyText } from './money';
import type { DataSourceId, DeckCategory, EnrichmentSource, PlatformKey, ValueGame, ValueSince } from '../bridge/types';

/** A price in the currency chosen in Settings (Track D6: converted and marked "≈" when it was in another one). */
export function formatMoney(amount: number, currency: string | null | undefined): string {
  if (!Number.isFinite(amount)) return '—';
  if (!isCurrencyCode(currency)) return amount.toFixed(2);
  return moneyText(amount, currency);
}

export const formatCents = (cents: number, currency: string | null | undefined) => formatMoney(cents / 100, currency);

export const SINCE_LABEL: Record<ValueSince, string> = {
  firstSeen: 'First seen by VYSTRAL',
  firstSession: 'First session tracked by VYSTRAL',
  firstAchievement: 'First achievement unlocked (Steam)',
  storeLastPlayed: 'Played by then (reported by the store)',
};

export interface ValuePoint {
  t: number;
  cents: number;
  count: number;
  /** The game that moved the line at this point. */
  gameId: string;
}

/**
 * Cumulative value over time: each priced game in the chosen currency adds its current price at
 * the earliest date it's known to have been in the library. Games without a price still count
 * toward `count` (the number of games), but add nothing to value.
 */
export function cumulativeValue(games: ValueGame[], currency: string | null, platform: PlatformKey | 'all' = 'all'): ValuePoint[] {
  const rows = games
    .filter((g) => platform === 'all' || g.platforms.includes(platform))
    .map((g) => ({ g, t: Date.parse(g.since) }))
    .filter((x) => Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t || a.g.title.localeCompare(b.g.title));
  let cents = 0;
  let count = 0;
  return rows.map(({ g, t }) => {
    count += 1;
    if (g.priceCents != null && g.currency === currency) cents += g.priceCents;
    return { t, cents, count, gameId: g.gameId };
  });
}

/** Start-of-year timestamps strictly inside the series' time span. */
export function yearMarkers(points: ValuePoint[]): { t: number; year: number }[] {
  if (points.length < 2) return [];
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const out: { t: number; year: number }[] = [];
  for (let y = new Date(first).getFullYear() + 1; ; y++) {
    const t = new Date(y, 0, 1).getTime();
    if (t >= last) break;
    out.push({ t, year: y });
  }
  return out;
}

export function topValue(games: ValueGame[], currency: string | null, n = 5, platform: PlatformKey | 'all' = 'all'): ValueGame[] {
  return games
    .filter((g) => g.priceCents != null && g.currency === currency && (platform === 'all' || g.platforms.includes(platform)))
    .sort((a, b) => (b.priceCents ?? 0) - (a.priceCents ?? 0) || a.title.localeCompare(b.title))
    .slice(0, n);
}

/** Stores present among the games (for the filter), in a stable order. */
export function storesIn(games: ValueGame[]): PlatformKey[] {
  const order: PlatformKey[] = ['steam', 'xbox', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'manual'];
  const present = new Set(games.flatMap((g) => g.platforms));
  return order.filter((p) => present.has(p));
}

export const DECK_LABEL: Record<DeckCategory, string> = {
  verified: 'Steam Deck Verified',
  playable: 'Steam Deck Playable',
  unsupported: 'Unsupported on Steam Deck',
  unknown: 'Steam Deck: not tested',
};

export function deckTone(c: DeckCategory): 'ok' | 'warn' | 'danger' | undefined {
  return c === 'verified' ? 'ok' : c === 'playable' ? 'warn' : c === 'unsupported' ? 'danger' : undefined;
}

/** "12 h", "1 h 30 min", "45 min" from seconds; null for missing values. */
export function formatHours(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  // Estimates of 10 hours or more read best rounded to the hour.
  if (h >= 10 || m === 0) return `${Math.round(minutes / 60)}h`;
  return `${h}h ${m}m`;
}

export function matchLabel(s: Pick<EnrichmentSource, 'matchMethod' | 'confidence'>): string {
  switch (s.matchMethod) {
    case 'steam-appid': return 'matched by Steam app ID';
    case 'wikidata': return 'matched through Wikidata’s store IDs';
    case 'exact-title': return `matched by exact title (${Math.round((s.confidence ?? 0) * 100)}% confidence)`;
    default: return 'not matched';
  }
}

export const STYLE_LABEL: Record<string, string> = {
  alternate: 'Alternate',
  blurred: 'Blurred',
  white_logo: 'White logo',
  material: 'Material',
  no_logo: 'No logo',
  official: 'Official',
  white: 'White',
  black: 'Black',
  custom: 'Custom',
};

export const PICKER_SLOTS: { kind: 'cover' | 'hero' | 'logo' | 'icon'; label: string; ratio: string }[] = [
  { kind: 'cover', label: 'Cover', ratio: '2 / 3' },
  { kind: 'hero', label: 'Background', ratio: '96 / 31' },
  { kind: 'logo', label: 'Logo', ratio: '16 / 9' },
  { kind: 'icon', label: 'Icon', ratio: '1 / 1' },
];

/** Client-side shape checks that mirror the native ones (the native side checks again). */
export function keyLooksValid(id: DataSourceId, key: string, secret?: string): boolean {
  const k = key.trim();
  if (id === 'igdb') return /^[A-Za-z0-9]{16,64}$/.test(k) && /^[A-Za-z0-9]{16,64}$/.test((secret ?? '').trim()) && k.toLowerCase() !== (secret ?? '').trim().toLowerCase();
  if (id === 'itad') return /^[A-Za-z0-9-]{16,80}$/.test(k);
  return /^[A-Za-z0-9]{16,64}$/.test(k);
}

/** Moves focus in a grid of `count` cells with `cols` columns; returns the new index (clamped). */
export function gridMove(index: number, key: string, count: number, cols: number): number {
  if (count <= 0) return -1;
  const c = Math.max(1, cols);
  switch (key) {
    case 'ArrowRight': return Math.min(count - 1, index + 1);
    case 'ArrowLeft': return Math.max(0, index - 1);
    case 'ArrowDown': return Math.min(count - 1, index + c);
    case 'ArrowUp': return index - c >= 0 ? index - c : index;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return index;
  }
}
