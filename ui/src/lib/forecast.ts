/**
 * Track M: library value forecast helpers (next Steam sale, backlog savings). Pure and unit-tested.
 * Sale dates are Valve's published ones shipped with the app; savings use prices already cached when
 * game pages were opened. Nothing here predicts prices.
 */
import type { BacklogSavings, SaleForecast, SaleInfo } from '../bridge/types';

/** 'yyyy-mm-dd' as a local calendar date (no time zone shift). */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDay(s: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }): string {
  const d = parseDay(s);
  return d ? d.toLocaleDateString(undefined, opts) : s;
}

/** "17 Dec – 4 Jan 2027" style range; adds the year where it helps. */
export function saleRange(sale: SaleInfo, now = new Date()): string {
  const a = parseDay(sale.start);
  const b = parseDay(sale.end);
  if (!a || !b) return `${sale.start} – ${sale.end}`;
  const withYear = b.getFullYear() !== now.getFullYear() || a.getFullYear() !== b.getFullYear();
  const start = a.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(a.getFullYear() !== b.getFullYear() ? { year: 'numeric' } : {}) });
  const end = b.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  return `${start} – ${end}`;
}

export function daysText(n: number): string {
  if (n <= 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

export type SaleHeadline =
  | { kind: 'onNow'; sale: SaleInfo; daysLeft: number; next: SaleInfo | null; daysUntilNext: number | null }
  | { kind: 'upcoming'; sale: SaleInfo; days: number }
  | { kind: 'notAnnounced' };

export function saleHeadline(f: SaleForecast): SaleHeadline {
  if (f.current) return { kind: 'onNow', sale: f.current, daysLeft: Math.max(0, f.daysLeftInCurrent ?? 0), next: f.next, daysUntilNext: f.daysUntilNext };
  if (f.next && f.daysUntilNext != null) return { kind: 'upcoming', sale: f.next, days: Math.max(0, f.daysUntilNext) };
  return { kind: 'notAnnounced' };
}

/** The total in the currency with the most priced games (others are listed separately, never converted). */
export function mainTotal(s: BacklogSavings): { currency: string; total: number; games: number } | null {
  return s.totals.length ? s.totals[0] : null;
}

/** "Prices from IsThereAnyDeal and CheapShark". */
export function providersLabel(s: BacklogSavings): string {
  const names = [...new Set(s.games.map((g) => (g.provider === 'itad' ? 'IsThereAnyDeal' : 'CheapShark')))];
  return names.length ? `Prices from ${names.join(' and ')}` : '';
}

/** Oldest price date among the games (prices are cached when a game's page is opened). */
export function oldestPrice(s: BacklogSavings): string | null {
  const dates = s.games.map((g) => g.pricedAt).filter((d) => Number.isFinite(Date.parse(d))).sort();
  return dates[0] ?? null;
}
