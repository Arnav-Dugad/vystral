import { afterEach, describe, expect, it } from 'vitest';
import {
  centsText, convertAmount, convertSeries, formatCurrency, getMoneyContext, money, moneyLabel, moneyText, needsConversion, parseMoneyInput, regionCurrency,
  setMoneyContext, sumInto, type FxTable, type MoneyCtx,
} from './money';
import { formatMoney as dsMoney } from './dataSources';
import { formatMoney as wishMoney } from './wishlist';
import { formatStorePrice } from './discover';
import { formatCost } from '../views/perf/EnergyCard';

// EUR-based, like Frankfurter's answer.
const FX: FxTable = { base: 'EUR', date: '2026-10-09', rates: { EUR: 1, USD: 1.12, INR: 108.4, GBP: 0.85, JPY: 177.3 } };
const INR: MoneyCtx = { target: 'INR', fx: FX, locale: 'en-IN' };
const USD: MoneyCtx = { target: 'USD', fx: FX, locale: 'en-US' };

const before = getMoneyContext();
afterEach(() => setMoneyContext(before));

describe('conversion', () => {
  it('converts through the base and never guesses a missing rate', () => {
    expect(convertAmount(14.99, 'USD', 'INR', FX)).toBeCloseTo((14.99 / 1.12) * 108.4, 6);
    expect(convertAmount(10, 'EUR', 'EUR', null)).toBe(10);
    expect(convertAmount(10, 'USD', 'BRL', FX)).toBeNull();
    expect(convertAmount(10, 'USD', 'INR', null)).toBeNull();
    expect(convertAmount(Number.NaN, 'USD', 'INR', FX)).toBeNull();
    expect(convertAmount(10, 'usd', 'INR', FX)).toBeNull();
  });

  it('knows when a price would be shown converted', () => {
    expect(needsConversion('USD', INR)).toBe(true);
    expect(needsConversion('INR', INR)).toBe(false);
    expect(needsConversion('BRL', INR)).toBe(false); // no rate: shown as it is
    expect(needsConversion(null, INR)).toBe(false);
  });
});

describe('money()', () => {
  it('shows the store’s own price exactly when it is already in the chosen currency', () => {
    const m = money(1299, 'INR', { ctx: INR });
    expect(m.approx).toBe(false);
    expect(m.text).toBe('₹1,299.00');
    expect(m.note).toBeNull();
  });

  it('labels a converted price as approximate and keeps the original', () => {
    const m = money(14.99, 'USD', { ctx: INR });
    expect(m.approx).toBe(true);
    expect(m.text).toBe('≈ ₹1,451');
    expect(m.original).toBe('$14.99');
    expect(m.currency).toBe('INR');
    expect(m.note).toBe('About ₹1,451, converted from $14.99 at 9 Oct rates');
    expect(moneyLabel(m)).toBe('about ₹1,451, converted from $14.99');
  });

  it('keeps cents for small converted amounts and whole units from 100 up', () => {
    expect(money(1, 'EUR', { ctx: USD }).text).toBe('≈ $1.12');
    expect(money(200, 'EUR', { ctx: USD }).text).toBe('≈ $224');
  });

  it('reads Steam hundredths, including currencies without minor units', () => {
    expect(centsText(198000, 'JPY', { ctx: { ...USD, target: 'JPY' } })).toBe('¥1,980');
    expect(money(1999, 'USD', { ctx: USD, minor: true }).text).toBe('$19.99');
  });

  it('shows the original price when it can’t be converted (no rates, unknown currency)', () => {
    expect(money(14.99, 'USD', { ctx: { target: 'INR', fx: null, locale: 'en-US' } }).text).toBe('$14.99');
    expect(money(10, 'BRL', { ctx: INR }).approx).toBe(false);
    expect(moneyText(5, null, { ctx: USD })).toBe('5.00');
    expect(moneyText(Number.NaN, 'USD', { ctx: USD })).toBe('—');
  });

  it('formats exactly with formatCurrency and survives odd codes', () => {
    expect(formatCurrency(2.4, 'GBP', { locale: 'en-GB' })).toBe('£2.40');
    expect(formatCurrency(1980, 'JPY', { locale: 'en-US', digits: 2 })).toBe('¥1,980');
    expect(formatCurrency(3, '<b>', { locale: 'en-US' })).toBe('3.00');
  });
});

describe('charts and totals', () => {
  it('converts a whole series with one rate, or leaves it all in its own currency', () => {
    const s = convertSeries([1000, 1500, 2000], 'USD', INR);
    expect(s.currency).toBe('INR');
    expect(s.approx).toBe(true);
    expect(s.values[1] / s.values[0]).toBeCloseTo(1.5, 9);
    expect(convertSeries([1, 2], 'INR', INR)).toEqual({ values: [1, 2], currency: 'INR', approx: false });
    expect(convertSeries([1, 2], 'BRL', INR)).toEqual({ values: [1, 2], currency: 'BRL', approx: false });
  });

  it('adds totals across currencies only through rates; the rest stay apart', () => {
    const r = sumInto([{ currency: 'USD', total: 11.2, games: 2 }, { currency: 'EUR', total: 10, games: 1 }, { currency: 'BRL', total: 50, games: 1 }], USD)!;
    expect(r.currency).toBe('USD');
    expect(r.total).toBeCloseTo(11.2 + 11.2, 9);
    expect(r.games).toBe(3);
    expect(r.approx).toBe(true);
    expect(r.apart.map((a) => a.currency)).toEqual(['BRL']);
    const none = sumInto([{ currency: 'BRL', total: 5, games: 1 }], USD)!;
    expect(none).toMatchObject({ currency: 'BRL', total: 5, approx: false, apart: [] });
    expect(sumInto([], USD)).toBeNull();
  });
});

describe('the older helpers go through the same formatter', () => {
  it('converts in data sources, wishlist, Discover and the energy estimate', () => {
    setMoneyContext(INR);
    expect(dsMoney(14.99, 'USD')).toBe('≈ ₹1,451');
    expect(wishMoney(1499, 'USD')).toBe('≈ ₹1,451');
    expect(formatStorePrice({ finalCents: 1499, initialCents: 2999, currency: 'USD' })).toEqual({ now: '≈ ₹1,451', was: '≈ ₹2,903', cut: 50 });
    // An explicit locale still formats exactly (as the existing tests expect).
    expect(formatStorePrice({ finalCents: 199, initialCents: 999, currency: 'USD' }, 'en-US')!.now).toBe('$1.99');
    // Energy: a price per kWh in another currency is converted; '' means the display currency.
    expect(formatCost(10, 0.3, 'EUR', INR)).toBe('≈ ₹325');
    expect(formatCost(2, 4, '', INR)).toBe('₹8.00');
    expect(formatCost(2, null, 'EUR', INR)).toBeNull();
  });
});

describe('typed prices', () => {
  it.each([
    ['12.99', 12.99], ['12,99', 12.99], ['1,299', 1299], ['1,299.00', 1299], ['1.299,00', 1299], ['1 299', 1299], ['₹1,299', 1299],
    ['$ 9.5', 9.5], ['0,5', 0.5], ['1.234.567', 1234567], ['  42  ', 42], ['10.000', 10000], ['0.999', 0.999],
  ])('reads %s as %s', (text, value) => expect(parseMoneyInput(text)).toBeCloseTo(value, 9));

  it.each(['', 'abc', '-5', '1.2.3,4,5', '.', ','])('refuses %j', (text) => expect(parseMoneyInput(text)).toBeNull());
});

describe('region currency', () => {
  it('maps locales to their currency, USD when unknown', () => {
    expect(regionCurrency('en-IN')).toBe('INR');
    expect(regionCurrency('de-DE')).toBe('EUR');
    expect(regionCurrency('ja-JP')).toBe('JPY');
    expect(regionCurrency('xx')).toBe('USD');
  });
});
