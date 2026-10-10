/**
 * Track W: pure helpers for the Wishlist page — sorting, release badges, price comparison against the
 * lowest price ever, money formatting and the price-history sparkline geometry.
 */
import type { WishlistItem, WishlistPoint } from '../bridge/types';
import { centsText, isCurrencyCode } from './money';

export type WishlistSort = 'priority' | 'drop' | 'release' | 'added';
export type WishlistFilter = 'all' | 'sale' | 'lowest' | 'upcoming';

const DAY = 86_400_000;

const sameLocalDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today" on launch day (local calendar), "soon" when it's out within a week, else null. */
export function releaseBadge(item: Pick<WishlistItem, 'releaseDate' | 'comingSoon'>, now = new Date()): 'today' | 'soon' | null {
  if (!item.releaseDate) return null;
  const at = new Date(item.releaseDate);
  if (Number.isNaN(at.getTime())) return null;
  if (sameLocalDay(at, now) && (!item.comingSoon || at.getTime() <= now.getTime())) return 'today';
  const ahead = at.getTime() - now.getTime();
  if (item.comingSoon && ahead > 0 && ahead <= 7 * DAY) return 'soon';
  return null;
}

/** Whole days until a release (1 = tomorrow). */
export function daysUntil(iso: string, now = new Date()): number {
  const a = new Date(iso);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  return Math.round((day - start) / DAY);
}

export function releaseLabel(item: Pick<WishlistItem, 'releaseDate' | 'comingSoon' | 'releaseText'>, now = new Date()): string {
  const badge = releaseBadge(item, now);
  if (badge === 'today') return 'Out today';
  if (item.comingSoon) {
    if (item.releaseDate) {
      const d = daysUntil(item.releaseDate, now);
      if (d === 1) return 'Out tomorrow';
      if (d > 1 && d <= 7) return `Out in ${d} days`;
      return `Coming ${formatDay(item.releaseDate)}`;
    }
    return item.releaseText ? (/^coming/i.test(item.releaseText) ? item.releaseText : `Coming ${item.releaseText}`) : 'Coming soon';
  }
  return item.releaseDate ? `Released ${formatDay(item.releaseDate)}` : item.releaseText ?? 'Released';
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Steam reports every currency in hundredths, including ones without minor units (¥1,980 is 198000). */
export function formatMoney(cents: number, currency: string | null): string {
  const value = cents / 100;
  if (!isCurrencyCode(currency)) return value.toFixed(2);
  // Track D6: in the currency chosen in Settings (converted and marked "≈" when Steam priced it in another one).
  return centsText(cents, currency);
}

export interface PriceVerdict {
  /** The lowest price is in the same currency as Steam's price, so they can be compared. */
  comparable: boolean;
  atLowest: boolean;
  belowLowest: boolean;
  /** How far above the lowest price ever the current price is (0–1), when comparable. */
  aboveLowest: number | null;
}

export function priceVerdict(item: Pick<WishlistItem, 'priceCents' | 'currency' | 'lowestCents' | 'lowestCurrency'>): PriceVerdict {
  const comparable = item.priceCents != null && item.lowestCents != null && item.currency != null && item.currency === item.lowestCurrency;
  if (!comparable) return { comparable: false, atLowest: false, belowLowest: false, aboveLowest: null };
  const price = item.priceCents!;
  const low = item.lowestCents!;
  return {
    comparable,
    atLowest: price <= low && price > 0,
    belowLowest: price < low && price > 0,
    aboveLowest: low > 0 ? Math.max(0, price / low - 1) : null,
  };
}

const time = (iso: string | null) => (iso ? new Date(iso).getTime() : NaN);

export function sortWishlist(items: WishlistItem[], sort: WishlistSort): WishlistItem[] {
  const list = [...items];
  const byPriority = (a: WishlistItem, b: WishlistItem) => (a.priority || 1e9) - (b.priority || 1e9) || a.name.localeCompare(b.name);
  switch (sort) {
    case 'drop':
      // Biggest discount first; at the lowest price ever breaks ties; full price last.
      return list.sort((a, b) => b.discount - a.discount || Number(priceVerdict(b).atLowest) - Number(priceVerdict(a).atLowest) || byPriority(a, b));
    case 'release': {
      // Upcoming soonest first, then undated upcoming, then released newest first.
      const rank = (i: WishlistItem) => (i.comingSoon ? (i.releaseDate ? 0 : 1) : 2);
      return list.sort((a, b) => {
        const r = rank(a) - rank(b);
        if (r) return r;
        const ta = time(a.releaseDate);
        const tb = time(b.releaseDate);
        if (rank(a) === 0) return ta - tb || byPriority(a, b);
        if (rank(a) === 2) return (Number.isNaN(tb) ? -Infinity : tb) - (Number.isNaN(ta) ? -Infinity : ta) || byPriority(a, b);
        return byPriority(a, b);
      });
    }
    case 'added':
      return list.sort((a, b) => (Number.isNaN(time(b.added)) ? 0 : time(b.added)) - (Number.isNaN(time(a.added)) ? 0 : time(a.added)) || byPriority(a, b));
    default:
      return list.sort(byPriority);
  }
}

export function filterWishlist(items: WishlistItem[], filter: WishlistFilter, query = ''): WishlistItem[] {
  const q = query.trim().toLocaleLowerCase();
  return items.filter((i) => {
    if (q && !i.name.toLocaleLowerCase().includes(q)) return false;
    switch (filter) {
      case 'sale': return i.discount > 0;
      case 'lowest': return priceVerdict(i).atLowest;
      case 'upcoming': return i.comingSoon;
      default: return true;
    }
  });
}

export function wishlistSummary(items: WishlistItem[], now = new Date()) {
  return {
    onSale: items.filter((i) => i.discount > 0).length,
    atLowest: items.filter((i) => priceVerdict(i).atLowest).length,
    upcoming: items.filter((i) => i.comingSoon).length,
    outToday: items.filter((i) => releaseBadge(i, now) === 'today').length,
  };
}

export interface Sparkline {
  /** Step line through every recorded price (prices change in steps, not slopes). */
  line: string;
  /** The same line closed to the baseline, for a soft fill. */
  area: string;
  /** Y of the lowest-ever line when it falls inside the chart's range, else null. */
  lowY: number | null;
  last: { x: number; y: number };
  min: number;
  max: number;
  days: number;
}

/**
 * Sparkline geometry over real time (days, not point index) with a small vertical pad. Null when there
 * are fewer than two points: a single price is not a history.
 */
export function sparkline(history: WishlistPoint[], width: number, height: number, lowestCents?: number | null, today = new Date()): Sparkline | null {
  const pts = history.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day) && Number.isFinite(p.cents));
  if (pts.length < 2) return null;
  const t = pts.map((p) => Date.parse(`${p.day}T00:00:00Z`));
  const t0 = t[0];
  // The line runs on to today: the latest price is still the price.
  const tEnd = Math.max(t[t.length - 1], Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const span = Math.max(DAY, tEnd - t0);
  const values = pts.map((p) => p.cents);
  const withLow = lowestCents != null && lowestCents > 0 ? [...values, lowestCents] : values;
  let min = Math.min(...withLow);
  let max = Math.max(...withLow);
  if (max === min) { max += 1; min -= 1; }
  const pad = 3;
  const x = (ms: number) => +(((ms - t0) / span) * width).toFixed(2);
  const y = (v: number) => +(pad + (1 - (v - min) / (max - min)) * (height - pad * 2)).toFixed(2);
  let line = `M${x(t[0])},${y(values[0])}`;
  for (let i = 1; i < pts.length; i++) line += ` H${x(t[i])} V${y(values[i])}`;
  line += ` H${x(tEnd)}`;
  const area = `${line} V${height} H${x(t[0])} Z`;
  return {
    line,
    area,
    lowY: lowestCents != null && lowestCents > 0 ? y(lowestCents) : null,
    last: { x: x(tEnd), y: y(values[values.length - 1]) },
    min: Math.min(...values),
    max: Math.max(...values),
    days: Math.round(span / DAY),
  };
}

/** A sentence describing the history, for screen readers. */
export function sparklineSummary(history: WishlistPoint[], currency: string | null): string {
  if (history.length < 2) return '';
  const values = history.map((p) => p.cents);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return `Steam price seen by VYSTRAL since ${new Date(`${history[0].day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}: between ${formatMoney(lo, currency)} and ${formatMoney(hi, currency)}, now ${formatMoney(values[values.length - 1], currency)}.`;
}
