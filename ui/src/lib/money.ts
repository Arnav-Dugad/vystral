/**
 * Track D6: the one place prices are formatted. Every price VYSTRAL shows goes through `money()` (or a wrapper around
 * it), so all of them appear in the currency chosen in Settings › Appearance › Currency (`app.currency`; empty = the
 * Windows region's currency).
 *
 * - A price already in that currency (the store's own regional price) is shown exactly.
 * - Anything else is converted with the day's rates (Frankfurter: the European Central Bank and other central banks,
 *   cached daily, last copy used offline) and labelled approximate: "≈ ₹1,299", with "converted from $14.99" in its
 *   title and spoken label.
 * - With no rates (never downloaded, or the currency isn't listed), the original price is shown as it is. A price is
 *   never shown in a currency it wasn't converted to.
 * - Charts convert the whole series (`convertSeries`), so one chart never mixes currencies.
 *
 * How to adopt it (other tracks): `const m = useMoney()` in a component (re-renders when the currency or rates change),
 * then `m.text(amount, 'USD')` / `m.cents(1499, 'USD')` for a string, or `<Price amount={14.99} currency="USD" />` for
 * the labelled element. Pure code takes an optional `MoneyCtx` and falls back to the current one.
 */

export interface FxTable {
  /** Every rate is "1 base = rate quote". The base is included with 1. */
  base: string;
  /** The rates' publication date, YYYY-MM-DD. */
  date: string;
  rates: Record<string, number>;
}

export interface MoneyCtx {
  /** ISO 4217 code every price is shown in. */
  target: string;
  fx: FxTable | null;
  /** Number formatting locale (undefined = the system's). */
  locale?: string;
}

export interface Money {
  /** What to show: "₹1,299" or "≈ ₹1,299" (or the original price when it couldn't be converted). */
  text: string;
  /** True when converted with exchange rates. */
  approx: boolean;
  /** The amount as shown, in `currency` (major units). */
  value: number;
  /** The currency of `value`/`text` (null when the source had none). */
  currency: string | null;
  /** The original price when converted: "$14.99". */
  original: string | null;
  /** A tooltip / spoken explanation: "About ₹1,299, converted from $14.99 at 9 Oct rates". Null when exact. */
  note: string | null;
}

const CODE = /^[A-Z]{3}$/;
export const isCurrencyCode = (c: unknown): c is string => typeof c === 'string' && CODE.test(c);

// ---------------- the current context (set by state/money.ts) ----------------

let current: MoneyCtx | null = null; // created on first use (the region table below must exist first)
const listeners = new Set<() => void>();

export function getMoneyContext(): MoneyCtx {
  return (current ??= { target: regionCurrency(), fx: null });
}

export function setMoneyContext(next: MoneyCtx): void {
  if (next.target === getMoneyContext().target && next.fx === getMoneyContext().fx && next.locale === getMoneyContext().locale) return;
  current = { ...next, target: isCurrencyCode(next.target) ? next.target : regionCurrency(next.locale) };
  for (const l of listeners) l();
}

export function onMoneyContext(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------- conversion ----------------

/** `amount` of `from` in `to`; null when the rates don't list both. Same currency needs no rates. */
export function convertAmount(amount: number, from: string | null | undefined, to: string, fx: FxTable | null): number | null {
  if (!Number.isFinite(amount) || !isCurrencyCode(from) || !isCurrencyCode(to)) return null;
  if (from === to) return amount;
  const f = fx?.rates[from];
  const t = fx?.rates[to];
  if (!f || !t || !Number.isFinite(f) || !Number.isFinite(t) || f <= 0 || t <= 0) return null;
  const v = (amount / f) * t;
  return Number.isFinite(v) ? v : null;
}

/** True when a price in `from` would be shown converted (and can be). */
export function needsConversion(from: string | null | undefined, ctx: MoneyCtx = getMoneyContext()): boolean {
  return isCurrencyCode(from) && from !== ctx.target && convertAmount(1, from, ctx.target, ctx.fx) != null;
}

/**
 * A whole series in one currency, for a chart: every value converted to the chosen currency, or — when that isn't
 * possible — every value left in its own currency. Never a mix.
 */
export function convertSeries(values: number[], from: string | null | undefined, ctx: MoneyCtx = getMoneyContext()): { values: number[]; currency: string | null; approx: boolean } {
  if (!isCurrencyCode(from)) return { values, currency: null, approx: false };
  if (from === ctx.target) return { values, currency: from, approx: false };
  const rate = convertAmount(1, from, ctx.target, ctx.fx);
  if (rate == null) return { values, currency: from, approx: false };
  return { values: values.map((v) => v * rate), currency: ctx.target, approx: true };
}

/**
 * Totals kept per currency, added up in the chosen currency. Totals that can't be converted (no rate) stay apart, so
 * nothing is ever added across currencies without a rate. `approx` is true when any part was converted.
 */
export function sumInto<T extends { currency: string; total: number; games: number }>(totals: T[], ctx: MoneyCtx = getMoneyContext()):
  { total: number; games: number; currency: string; approx: boolean; apart: T[] } | null {
  let total = 0;
  let games = 0;
  let approx = false;
  let any = false;
  const apart: T[] = [];
  for (const t of totals) {
    const v = convertAmount(t.total, t.currency, ctx.target, ctx.fx);
    if (v == null) { apart.push(t); continue; }
    any = true;
    total += v;
    games += t.games;
    if (t.currency !== ctx.target) approx = true;
  }
  if (!any) {
    const [first, ...rest] = totals;
    return first ? { total: first.total, games: first.games, currency: first.currency, approx: false, apart: rest } : null;
  }
  return { total, games, currency: ctx.target, approx, apart };
}

// ---------------- formatting ----------------

const fmtCache = new Map<string, Intl.NumberFormat>();

function numberFormat(locale: string | undefined, currency: string, digits: 'auto' | 0 | 2): Intl.NumberFormat {
  const key = `${locale ?? ''}|${currency}|${digits}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = digits === 'auto'
      ? new Intl.NumberFormat(locale, { style: 'currency', currency })
      : new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (fmtCache.size > 200) fmtCache.clear();
    fmtCache.set(key, f);
  }
  return f;
}

/** Exact formatting in one currency, no conversion: "$14.99", "¥1,980", "€9,99" (by locale). */
export function formatCurrency(amount: number, currency: string | null | undefined, opts: { locale?: string; digits?: 'auto' | 0 | 2 } = {}): string {
  if (!Number.isFinite(amount)) return '—';
  if (!isCurrencyCode(currency)) return amount.toLocaleString(opts.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  try {
    // Currencies without minor units (JPY, KRW) ignore a request for two digits.
    const digits = opts.digits === 2 && minorDigits(currency, opts.locale) === 0 ? 0 : opts.digits ?? 'auto';
    return numberFormat(opts.locale, currency, digits).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

function minorDigits(currency: string, locale?: string): number {
  try {
    return numberFormat(locale, currency, 'auto').resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function rateDate(fx: FxTable | null, locale?: string): string {
  if (!fx?.date || !/^\d{4}-\d{2}-\d{2}$/.test(fx.date)) return '';
  const d = new Date(`${fx.date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : ` at ${d.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" })} rates`;
}

export interface MoneyOptions {
  ctx?: MoneyCtx;
  /** The amount is in hundredths (Steam reports every currency that way, even JPY: ¥1,980 is 198000). */
  minor?: boolean;
  /** Fraction digits for exact prices ('auto' = the currency's own). Converted prices round to whole units from 100 up. */
  digits?: 'auto' | 0 | 2;
}

/** The price in the chosen currency, with everything needed to label it honestly. */
export function money(amount: number, from: string | null | undefined, opts: MoneyOptions = {}): Money {
  const ctx = opts.ctx ?? getMoneyContext();
  const major = opts.minor ? amount / 100 : amount;
  const own = isCurrencyCode(from) ? from : null;
  if (!Number.isFinite(major)) return { text: '—', approx: false, value: NaN, currency: own, original: null, note: null };
  const exact = formatCurrency(major, own, { locale: ctx.locale, digits: opts.digits });
  if (!own || own === ctx.target) return { text: exact, approx: false, value: major, currency: own, original: null, note: null };
  const converted = convertAmount(major, own, ctx.target, ctx.fx);
  if (converted == null) return { text: exact, approx: false, value: major, currency: own, original: null, note: null };
  const shown = formatCurrency(converted, ctx.target, { locale: ctx.locale, digits: Math.abs(converted) >= 100 ? 0 : 'auto' });
  return {
    text: `≈ ${shown}`,
    approx: true,
    value: converted,
    currency: ctx.target,
    original: exact,
    note: `About ${shown}, converted from ${exact}${rateDate(ctx.fx, ctx.locale)}`,
  };
}

/**
 * A store's own formatted price ("$19.99", "19,99€", "₹ 1,299") in the chosen currency: as it is when it's already in
 * that currency (or can't be read or converted), else converted and marked "≈".
 */
export function storeText(text: string | null | undefined, currency: string | null | undefined, opts: { ctx?: MoneyCtx } = {}): string | null {
  if (!text) return text ?? null;
  const ctx = opts.ctx ?? getMoneyContext();
  if (!isCurrencyCode(currency) || currency === ctx.target || !needsConversion(currency, ctx)) return text;
  const n = parseMoneyInput(text);
  return n == null ? text : money(n, currency, { ctx }).text;
}

/** Just the text: "₹1,299" or "≈ ₹1,299". */
export const moneyText = (amount: number, from: string | null | undefined, opts?: MoneyOptions): string => money(amount, from, opts).text;

/** Hundredths (Steam's unit) to text. */
export const centsText = (cents: number, from: string | null | undefined, opts?: Omit<MoneyOptions, 'minor'>): string => money(cents, from, { ...opts, minor: true }).text;

/** What a screen reader should hear for a price: "about ₹1,299, converted from $14.99" or just "₹1,299". */
export function moneyLabel(m: Money): string {
  return m.approx && m.original ? `about ${m.text.replace(/^≈\s*/, '')}, converted from ${m.original}` : m.text;
}

/**
 * A price someone typed: "12.99", "12,99", "1,299.00", "1.299,00", "1 299", "₹1,299", "$ 9.5". Null when it isn't a
 * non-negative number. A lone separator followed by exactly three digits is read as a thousands separator ("1,299"),
 * otherwise as the decimal point ("12,5").
 */
export function parseMoneyInput(text: string): number | null {
  const raw = text.replace(/[\s  ']/g, '').replace(/[^\d.,-]/g, '');
  if (!raw || /-/.test(raw)) return raw === '' ? null : null;
  if (!/\d/.test(raw)) return null;
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let normal: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both appear: the later one is the decimal point.
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    normal = raw.split(thou).join('').replace(dec, '.');
  } else {
    const sep = lastDot >= 0 ? '.' : lastComma >= 0 ? ',' : null;
    if (!sep) normal = raw;
    else {
      const parts = raw.split(sep);
      const thousands = parts.length > 2 || (parts.length === 2 && parts[1].length === 3 && parts[0].length > 0 && parts[0] !== '0');
      normal = thousands ? parts.join('') : `${parts[0]}.${parts[1]}`;
    }
  }
  if (!/^\d*\.?\d*$/.test(normal) || normal === '.' || normal.split('.').length > 2) return null;
  const n = Number(normal);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// ---------------- the region's currency ----------------

const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', KR: 'KRW', IN: 'INR', BR: 'BRL', MX: 'MXN', CH: 'CHF', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', TR: 'TRY', ZA: 'ZAR', SA: 'SAR', AR: 'ARS', CO: 'COP', CN: 'CNY', HK: 'HKD',
  TW: 'TWD', SG: 'SGD', MY: 'MYR', TH: 'THB', ID: 'IDR', PH: 'PHP', VN: 'VND', IL: 'ILS', AE: 'AED', UA: 'UAH', KZ: 'KZT', CL: 'CLP',
  PE: 'PEN', UY: 'UYU', CR: 'CRC', QA: 'QAR', KW: 'KWD', RO: 'RON', IS: 'ISK', RU: 'RUB',
};

/** The currency of the locale's region (en-GB → GBP, de-DE → EUR); USD when unknown. The app prefers Windows' own answer. */
export function regionCurrency(locale?: string): string {
  const loc = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  let region = '';
  try { region = new Intl.Locale(loc).maximize().region ?? ''; } catch { region = ''; }
  return REGION_CURRENCY[region] ?? (EURO.has(region) ? 'EUR' : 'USD');
}

/** The currencies offered in pickers: the common ones Steam and the rates know, in a stable order. */
export const COMMON_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'INR', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON', 'TRY', 'BRL', 'MXN', 'ARS',
  'CLP', 'COP', 'PEN', 'ZAR', 'SAR', 'AED', 'QAR', 'KWD', 'ILS', 'KRW', 'CNY', 'HKD', 'TWD', 'SGD', 'MYR', 'THB', 'IDR', 'PHP', 'VND',
  'UAH', 'KZT', 'ISK',
];

/** "Indian rupee (INR)" in the user's language, or the code. */
export function currencyName(code: string, locale?: string): string {
  try {
    const name = new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'currency' }).of(code);
    return name && name !== code ? `${name[0].toUpperCase()}${name.slice(1)} (${code})` : code;
  } catch {
    return code;
  }
}

/** The symbol alone: "₹", "$", "€" (or the code). */
export function currencySymbol(code: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find((p) => p.type === 'currency')?.value ?? code;
  } catch {
    return code;
  }
}
