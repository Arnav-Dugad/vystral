import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CloudOff, RefreshCw } from 'lucide-react';
import { COMMON_CURRENCIES, currencyName, currencySymbol, isCurrencyCode, money } from '../../lib/money';
import { formatRelative } from '../../lib/format';
import { displayCurrency, useMoney, useMoneyStore } from '../../state/money';
import { useStore } from '../../state/store';
import { Button } from '../../components/ui/primitives';
import './currency-settings.css';

/** The sample conversions shown under the picker: a typical game price in a few common currencies. */
const SAMPLES: [number, string][] = [[14.99, 'USD'], [59.99, 'EUR'], [4.49, 'GBP']];

/**
 * Track D6: Settings › Appearance › Currency. Every price VYSTRAL shows (deals, price history, wishlist, Discover,
 * library value, subscriptions, the energy estimate) appears in this currency. Prices in another currency are converted
 * with the day's exchange rates and marked "≈"; a store's own price in this currency is always shown as it is.
 */
export function CurrencySettings() {
  const setting = useStore((s) => s.settings?.['app.currency'] ?? '');
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const set = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const m = useMoney();
  const fx = useMoneyStore((s) => s.fx);
  const refreshing = useMoneyStore((s) => s.refreshing);
  const region = fx?.regionCurrency && isCurrencyCode(fx.regionCurrency) ? fx.regionCurrency : displayCurrency('', null);
  const [busy, setBusy] = useState(false);

  // Common currencies first, then anything else today's rates know, alphabetically.
  const options = useMemo(() => {
    const extra = Object.keys(fx?.rates ?? {}).filter((c) => isCurrencyCode(c) && !COMMON_CURRENCIES.includes(c)).sort();
    const all = [...COMMON_CURRENCIES, ...extra];
    if (isCurrencyCode(setting) && !all.includes(setting)) all.push(setting);
    return all.filter((c) => c !== region);
  }, [fx?.rates, setting, region]);

  const refresh = async () => {
    setBusy(true);
    const err = await useMoneyStore.getState().refresh();
    setBusy(false);
    toast(err ? { tone: 'warning', title: 'Exchange rates weren’t updated', body: err } : { tone: 'success', title: 'Exchange rates are up to date' });
  };

  const known = (c: string) => !fx?.rates || c in fx.rates;
  const rateLine = fx?.date
    ? `${fx.state === 'stale' ? 'Rates from' : 'Rates of'} ${new Date(`${fx.date}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
    : fx?.state === 'offline' ? 'No exchange rates yet' : 'Exchange rates not downloaded yet';

  return (
    <section className="sgroup" aria-labelledby="currency-title" data-testid="currency-settings">
      <h2 className="sgroup__title" id="currency-title">Currency</h2>
      <p className="sgroup__desc">
        Every price in VYSTRAL is shown in this currency: deals, price history, your wishlist, Discover, library value, subscriptions and the energy
        estimate. When a store already prices a game in it, that exact price is shown. Anything else is converted and marked “≈”.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow" data-row="currency">
          <div className="srow__text">
            <label className="srow__label" htmlFor="app.currency">Show prices in</label>
            <div className="srow__hint">“Windows region” follows the region set in Windows: {currencyName(region)}.</div>
          </div>
          <div className="srow__control">
            <select id="app.currency" className="input cur-select" value={isCurrencyCode(setting) ? setting : ''} onChange={(e) => void set('app.currency', e.target.value)}>
              <option value="">{`${region} · Windows region`}</option>
              {options.map((c) => (
                <option key={c} value={c} disabled={!known(c) && c !== setting}>{`${c} · ${currencyName(c).replace(/ \([A-Z]{3}\)$/, '')}`}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="srow cur-rates" data-row="exchange-rates">
          <div className="srow__text" aria-live="polite">
            <div className="srow__label">{rateLine}</div>
            <div className="srow__hint">
              {fx?.state === 'offline'
                ? <><CloudOff size={12} aria-hidden /> Offline mode is on: VYSTRAL keeps using the last rates it downloaded.</>
                : fx?.state === 'error' || (fx?.error && fx.state !== 'ok')
                  ? <><AlertTriangle size={12} aria-hidden /> {fx?.error ?? 'Couldn’t download the rates.'} Prices stay in their own currency until it works.</>
                  : <>From Frankfurter, which publishes the European Central Bank’s and other central banks’ daily reference rates. Downloaded at most once a day{fx?.fetchedAt ? ` (last ${formatRelative(fx.fetchedAt).toLowerCase()})` : ''}; no account or key, and nothing about you is sent.</>}
            </div>
          </div>
          <div className="srow__control">
            <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} loading={busy || refreshing} disabled={offline} onClick={() => void refresh()}>Update rates</Button>
          </div>
        </div>

        <div className="cur-samples" aria-label="Examples">
          {SAMPLES.filter(([, c]) => c !== m.target).slice(0, 2).map(([amount, c]) => {
            const v = money(amount, c, { ctx: m.ctx });
            return (
              <div key={c} className="cur-sample">
                <span className="num">{money(amount, c, { ctx: { ...m.ctx, target: c } }).text}</span>
                <ArrowRight size={13} aria-hidden />
                <span className="num cur-sample__to" data-approx={v.approx || undefined}>{v.approx ? v.text : `${v.text} (no rate yet)`}</span>
              </div>
            );
          })}
          <span className="cur-samples__note">Converted prices are approximate: stores set their own regional prices, which can differ.</span>
          <span className="cur-samples__sym" aria-hidden>{currencySymbol(m.target)}</span>
        </div>
      </div>
    </section>
  );
}
