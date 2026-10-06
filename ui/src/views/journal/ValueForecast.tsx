import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { CalendarRange, ExternalLink, Info, PiggyBank, Tag } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { BacklogSavings, SaleForecast } from '../../bridge/types';
import { formatMoney } from '../../lib/dataSources';
import { formatDate, formatRelative, plural } from '../../lib/format';
import { daysText, formatDay, mainTotal, oldestPrice, providersLabel, saleHeadline, saleRange } from '../../lib/forecast';
import { useReducedMotion, useStore } from '../../state/store';
import { Button, SectionHead, Skeleton } from '../../components/ui/primitives';
import './value-forecast.css';

/**
 * Track M: Journal → Library value → forecast. The next Steam seasonal sale (dates Valve announced,
 * shipped with VYSTRAL) and an estimate of what your unplayed games have cost at their lowest.
 */
export function ValueForecast() {
  return (
    <div className="vf">
      <NextSale />
      <BacklogSavingsCard />
    </div>
  );
}

function NextSale() {
  const [f, setF] = useState<SaleForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    call<SaleForecast>('forecast.sales').then(setF).catch((e) => setError(errorMessage(e)));
  }, []);
  const h = f ? saleHeadline(f) : null;
  return (
    <section className="surface vx-card vf-sale" aria-labelledby="vf-sale-title">
      <SectionHead title={<span id="vf-sale-title">Next big sale</span>} meta="Steam seasonal sales" />
      {error && <p className="lv-muted">{error}</p>}
      {!f && !error && <Skeleton height={96} />}
      {f && h && (
        <>
          {h.kind === 'onNow' && (
            <div className="vf-sale__hero">
              <motion.span className="vf-sale__badge" initial={reduce ? false : { scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}><Tag size={13} aria-hidden /> On now</motion.span>
              <strong className="vf-sale__name">{h.sale.name}</strong>
              <span className="vf-sale__when">{saleRange(h.sale)} · {h.daysLeft === 0 ? 'last day' : `${plural(h.daysLeft, 'day')} left`}</span>
              {h.next && h.daysUntilNext != null && <span className="vf-sale__then">Then {h.next.name}, {saleRange(h.next)} ({daysText(h.daysUntilNext)})</span>}
            </div>
          )}
          {h.kind === 'upcoming' && (
            <div className="vf-sale__hero">
              <span className="vf-sale__count num" aria-hidden>{h.days}</span>
              <span className="vf-sale__count-unit" aria-hidden>{h.days === 1 ? 'day' : 'days'}</span>
              <strong className="vf-sale__name">{h.sale.name}</strong>
              <span className="vf-sale__when">{saleRange(h.sale)} · starts {daysText(h.days)}</span>
              <span className="visually-hidden">{h.sale.name} starts {daysText(h.days)}, {saleRange(h.sale)}.</span>
            </div>
          )}
          {h.kind === 'notAnnounced' && (
            <p className="vf-sale__none">Valve hasn’t announced the next seasonal sale in the dates VYSTRAL ships with, so none is shown — VYSTRAL doesn’t guess sale dates.</p>
          )}
          <p className="vf-src">
            <CalendarRange size={12} aria-hidden />
            {f.source.startsWith('Preview')
              ? <span><strong>Fictional preview dates</strong> — the app uses the dates Valve announced on Steamworks.</span>
              : <span><strong>Announced by Valve</strong> · {f.source} (checked {formatDay(f.retrieved, { dateStyle: 'medium' })}). Dates as published; Valve doesn’t list a start time there.</span>}
            <button className="vf-link" onClick={() => void call('forecast.openSource').catch(() => {})}>Source <ExternalLink size={11} aria-hidden /></button>
          </p>
        </>
      )}
    </section>
  );
}

function BacklogSavingsCard() {
  const [s, setS] = useState<BacklogSavings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const navigate = useStore((st) => st.navigate);
  useEffect(() => {
    call<BacklogSavings>('forecast.backlogSavings').then(setS).catch((e) => setError(errorMessage(e)));
  }, []);
  const main = s ? mainTotal(s) : null;
  const others = s ? s.totals.slice(1) : [];
  const shown = s ? (all ? s.games : s.games.slice(0, 6)) : [];
  const asOf = s ? oldestPrice(s) : null;

  return (
    <section className="surface vx-card vf-save" aria-labelledby="vf-save-title">
      <SectionHead title={<span id="vf-save-title">Estimated savings on your backlog</span>} meta="Based on past lows" />
      {error && <p className="lv-muted">{error}</p>}
      {!s && !error && <Skeleton height={140} />}
      {s && (
        <>
          <div className="vf-save__hero">
            <PiggyBank size={20} aria-hidden />
            <div>
              <strong className="vf-save__total num">{main ? formatMoney(main.total, main.currency) : '—'}</strong>
              <span className="vf-save__sub">
                {main ? `across ${plural(main.games, 'game')} with price data` : s.reason === 'noBacklog' ? 'No backlog or never-played games' : 'No price data yet'}
                {others.map((o) => ` · ${formatMoney(o.total, o.currency)} (${plural(o.games, 'game')})`).join('')}
              </span>
            </div>
          </div>
          <p className="vf-honest" role="note">
            <Info size={14} aria-hidden />
            <span>
              <strong>An estimate based on past lows</strong>, not a prediction: for backlog and never-played games, today’s best price minus the lowest price ever
              recorded. Prices aren’t converted between currencies, and this isn’t what you paid.
            </span>
          </p>
          {shown.length > 0 && (
            <ul className="vf-save__list">
              {shown.map((g) => (
                <li key={g.gameId}>
                  <button className="lv-top__title" onClick={() => navigate({ name: 'game', id: g.gameId })}>{g.title}</button>
                  <span className="vf-save__detail">
                    now {formatMoney(g.current, g.currency)}{g.shop ? ` at ${g.shop}` : ''} · lowest {formatMoney(g.low, g.currency)}{g.lowAt ? ` (${formatDate(g.lowAt, { month: 'short', year: 'numeric' })})` : ''}
                    {g.stale ? ' · older price' : ''}
                  </span>
                  <span className="vf-save__saving num">{g.saving > 0 ? formatMoney(g.saving, g.currency) : <span className="lv-muted">at its low</span>}</span>
                </li>
              ))}
            </ul>
          )}
          {s.games.length > 6 && <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${s.games.length}`}</Button>}
          <p className="vf-src">
            <span>
              {s.withoutData > 0 && <>{plural(s.withoutData, 'game')} without price data{s.withoutSteamId > 0 ? ` (${s.withoutSteamId} not on Steam)` : ''}. </>}
              {s.reason === 'disabled'
                ? 'CheapShark is off and IsThereAnyDeal isn’t connected, so no prices are used.'
                : 'Prices are only looked up when you open a game’s page, so open a game to include it.'}
              {providersLabel(s) && <> {providersLabel(s)}{asOf ? `, oldest from ${formatRelative(asOf).toLowerCase()}` : ''}.</>}
            </span>
            {s.reason === 'disabled' && <button className="vf-link" onClick={() => navigate({ name: 'settings', section: 'library' })}>Open settings</button>}
          </p>
        </>
      )}
    </section>
  );
}
