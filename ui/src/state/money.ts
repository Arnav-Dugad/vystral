/**
 * Track D6: the display currency and the day's exchange rates for every price on screen. Loaded on first use, kept in
 * step with the `app.currency` setting and `fx.changed`, and pushed into `lib/money.ts` so pure helpers format with
 * the same context. Components call `useMoney()` (re-render on change) and format through it.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { FxStatus } from '../bridge/types';
import {
  centsText, getMoneyContext, isCurrencyCode, money, moneyLabel, moneyText, onMoneyContext, regionCurrency, setMoneyContext, convertSeries,
  type Money, type MoneyCtx, type MoneyOptions,
} from '../lib/money';
import { useStore } from './store';

interface MoneyState {
  fx: FxStatus | null;
  refreshing: boolean;
  load(): Promise<void>;
  refresh(): Promise<string | null>;
}

let started = false;

export const useMoneyStore = create<MoneyState>((set) => ({
  fx: null,
  refreshing: false,
  async load() {
    try {
      set({ fx: await call<FxStatus>('fx.rates') });
    } catch {
      /* prices simply stay in their own currency */
    }
    apply();
  },
  async refresh() {
    set({ refreshing: true });
    try {
      set({ fx: await call<FxStatus>('fx.refresh', undefined, 30_000) });
      apply();
      return null;
    } catch (err) {
      return errorMessage(err);
    } finally {
      set({ refreshing: false });
    }
  },
}));

/** The currency prices are shown in: the setting, else Windows' region currency, else the browser's. */
export function displayCurrency(setting: string | undefined | null, fx: FxStatus | null): string {
  if (isCurrencyCode(setting)) return setting;
  if (fx && isCurrencyCode(fx.regionCurrency)) return fx.regionCurrency;
  return regionCurrency();
}

function apply() {
  const fx = useMoneyStore.getState().fx;
  const target = displayCurrency(useStore.getState().settings?.['app.currency'], fx);
  const table = fx?.rates && fx.base && fx.date ? { base: fx.base, date: fx.date, rates: fx.rates } : null;
  const cur = getMoneyContext();
  // Keep the same table object when nothing changed, so memoized charts don't recompute.
  const same = cur.fx && table && cur.fx.date === table.date && cur.fx.base === table.base && Object.keys(cur.fx.rates).length === Object.keys(table.rates).length;
  setMoneyContext({ target, fx: same ? cur.fx : table });
}

export function ensureMoney(): void {
  if (started) return;
  started = true;
  void useMoneyStore.getState().load();
  on('fx.changed', (fx) => {
    useMoneyStore.setState({ fx });
    apply();
  });
  let last: string | undefined;
  useStore.subscribe((st) => {
    const c = st.settings?.['app.currency'];
    if (c === last) return;
    last = c;
    apply();
  });
}

/** Re-renders when the display currency or the rates change. */
export function useMoneyContext(): MoneyCtx {
  useEffect(() => ensureMoney(), []);
  return useSyncExternalStore(onMoneyContext, getMoneyContext, getMoneyContext);
}

export interface MoneyApi {
  ctx: MoneyCtx;
  target: string;
  /** Full details (for labels and tooltips). */
  of(amount: number, currency: string | null | undefined, opts?: Omit<MoneyOptions, 'ctx'>): Money;
  /** "₹1,299" / "≈ ₹1,299". */
  text(amount: number, currency: string | null | undefined, opts?: Omit<MoneyOptions, 'ctx'>): string;
  /** Steam-style hundredths. */
  cents(cents: number, currency: string | null | undefined): string;
  /** What a screen reader should hear. */
  label(amount: number, currency: string | null | undefined, opts?: Omit<MoneyOptions, 'ctx'>): string;
  series(values: number[], currency: string | null | undefined): { values: number[]; currency: string | null; approx: boolean };
}

/** The price formatter for components. */
export function useMoney(): MoneyApi {
  const ctx = useMoneyContext();
  return useMemo(() => ({
    ctx,
    target: ctx.target,
    of: (a, c, o) => money(a, c, { ...o, ctx }),
    text: (a, c, o) => moneyText(a, c, { ...o, ctx }),
    cents: (a, c) => centsText(a, c, { ctx }),
    label: (a, c, o) => moneyLabel(money(a, c, { ...o, ctx })),
    series: (v, c) => convertSeries(v, c, ctx),
  }), [ctx]);
}
