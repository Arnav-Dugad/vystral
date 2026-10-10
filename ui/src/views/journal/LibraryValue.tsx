import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { motion } from 'motion/react';
import { CalendarClock, Coins, Gem, Info, Library, RefreshCw } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { PlatformKey, ValueTimeline } from '../../bridge/types';
import { formatRelative, PLATFORM_NAMES } from '../../lib/format';
import { cumulativeValue, formatCents, SINCE_LABEL, storesIn, topValue, yearMarkers, type ValuePoint } from '../../lib/dataSources';
import { useReducedMotion, useStore } from '../../state/store';
import { useMoney } from '../../state/money'; // Track D6
import { Price } from '../../components/ui/Price';
import { Button, EmptyState, SectionHead, Segmented, Skeleton } from '../../components/ui/primitives';
import { StoreLogo } from '../../components/ui/StoreLogo';
import { StatTile } from '../perf/kit';
import { ValueForecast } from './ValueForecast';
import { useElementWidth } from '../perf/hooks';
import '../perf/kit.css';
import './library-value.css';

/**
 * Journal → Library value. When each game entered the library (the earliest honest evidence,
 * labelled) and what it costs on the store today — never what was paid.
 */
export function LibraryValue() {
  const [data, setData] = useState<ValueTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pricing, setPricing] = useState(false);
  const [store, setStore] = useState<PlatformKey | 'all'>('all');
  const toast = useStore((s) => s.toast);
  const navigate = useStore((s) => s.navigate);
  const triedAuto = useRef(false);

  const refreshPrices = useCallback(async (quiet = false) => {
    setPricing(true);
    try {
      setData(await call<ValueTimeline>('value.refreshPrices', undefined, 300_000));
    } catch (err) {
      if (!quiet) toast({ tone: 'danger', title: 'Couldn’t fetch prices', body: errorMessage(err) });
    } finally {
      setPricing(false);
    }
  }, [toast]);

  useEffect(() => {
    let alive = true;
    call<ValueTimeline>('value.timeline')
      .then((d) => {
        if (!alive) return;
        setData(d);
        // First visit (or prices a day old): fetch current prices once, quietly.
        const stale = !d.lastPriced || Date.now() - Date.parse(d.lastPriced) > 24 * 3600_000;
        if (!triedAuto.current && d.pricesEnabled && !d.reason && stale && d.games.some((g) => g.platforms.includes('steam'))) {
          triedAuto.current = true;
          void refreshPrices(true);
        }
      })
      .catch((err) => alive && setError(errorMessage(err)));
    return () => { alive = false; };
  }, [refreshPrices]);

  const stores = useMemo(() => (data ? storesIn(data.games) : []), [data]);
  const points = useMemo(() => (data ? cumulativeValue(data.games, data.currency, store) : []), [data, store]);
  const top = useMemo(() => (data ? topValue(data.games, data.currency, 5, store) : []), [data, store]);
  const gamesById = useStore((s) => s.gamesById);
  // Track D6: the whole chart in the chosen currency (one rate for the whole series, never a mix).
  const money = useMoney();
  const conv = useMemo(() => {
    const r = money.series([1], data?.currency ?? null);
    return { rate: r.values[0], currency: r.currency, approx: r.approx };
  }, [money, data?.currency]);
  const shownPoints = useMemo(() => (conv.approx ? points.map((p) => ({ ...p, cents: Math.round(p.cents * conv.rate) })) : points), [points, conv]);

  if (error) return <EmptyState icon={<Library size={32} />} title="Library value couldn’t be loaded" body={error} />;
  if (!data) return <div className="lv"><div className="vx-tiles"><Skeleton height={92} /><Skeleton height={92} /><Skeleton height={92} /></div><Skeleton height={300} /></div>;
  if (!data.games.length) return <EmptyState icon={<Library size={32} />} title="No games yet" body="Once your library has games, this shows when each one arrived and what it costs today." />;

  const scoped = store === 'all' ? data.games : data.games.filter((g) => g.platforms.includes(store));
  const scopedTotal = points.length ? points[points.length - 1].cents : 0;
  const priced = scoped.filter((g) => g.priceCents != null && g.currency === data.currency).length;
  const oldest = scoped[0];

  return (
    <div className="lv">
      <div className="lv-honest surface" role="note">
        <Info size={16} aria-hidden />
        <p>
          <strong>Current price, not what you paid.</strong> Values are today’s Steam store prices{data.currency ? ` in ${data.currency}` : ''} ({data.country}){conv.approx ? `, shown in ${conv.currency} at the day’s exchange rate (approximate)` : ''}.
          Steam doesn’t share purchase dates, so each game is placed at the <em>earliest evidence</em> VYSTRAL has — its first tracked session, first Steam achievement,
          a last-played date from the store, or when VYSTRAL first saw it — and every date says which.
        </p>
      </div>

      <div className="lv-toolbar">
        {stores.length > 1 && (
          <Segmented label="Store" value={store} onChange={(v) => setStore(v)}
            options={[{ value: 'all', label: 'All stores' }, ...stores.map((p) => ({ value: p, label: PLATFORM_NAMES[p], icon: <StoreLogo platform={p} size={14} decorative motion /> }))]} />
        )}
        <span className="lv-toolbar__meta">
          {data.reason === 'disabled' ? 'Store prices are off in Settings' : data.reason === 'offline' ? 'Offline mode is on' : data.lastPriced ? `Prices as of ${formatRelative(data.lastPriced).toLowerCase()}` : 'No prices yet'}
        </span>
        {data.reason === 'disabled'
          ? <Button size="sm" onClick={() => navigate({ name: 'settings', section: 'library' })}>Open settings</Button>
          : <Button size="sm" icon={<RefreshCw size={14} />} loading={pricing} disabled={!!data.reason} onClick={() => void refreshPrices()}>Refresh prices</Button>}
      </div>

      <div className="vx-tiles lv-tiles">
        <StatTile icon={<Coins size={13} />} label="Current value" value={data.currency ? <Price amount={scopedTotal} currency={data.currency} minor /> : <span className="num">—</span>}
          sub={pricing ? 'Fetching current Steam prices…' : `${priced} of ${scoped.length} games priced`} unavailable={!data.currency} />
        <StatTile icon={<Library size={13} />} label="Games" value={<span className="num">{scoped.length.toLocaleString()}</span>} sub={store === 'all' ? 'Hidden games are left out' : PLATFORM_NAMES[store]} />
        <StatTile icon={<CalendarClock size={13} />} label="Earliest" value={<span>{oldest ? new Date(oldest.since).getFullYear() : '—'}</span>}
          sub={oldest ? `${oldest.title} · ${SINCE_LABEL[oldest.sinceSource].toLowerCase()}` : undefined} />
        <StatTile icon={<Gem size={13} />} label="Most valuable" value={top[0] ? <Price amount={top[0].priceCents!} currency={data.currency} minor /> : <span className="num">—</span>} sub={top[0]?.title ?? 'No prices yet'} />
      </div>

      <section className="surface vx-card" aria-labelledby="lv-chart-title">
        <SectionHead title={<span id="lv-chart-title">Library over time</span>} meta={data.currency ? `Cumulative current value · ${conv.currency ?? data.currency}${conv.approx ? ` (converted from ${data.currency}, approximate)` : ''}` : 'Games over time (no prices yet)'} />
        {points.length >= 2
          ? <ValueChart points={shownPoints} currency={conv.currency ?? data.currency} titleOf={(id) => scoped.find((g) => g.gameId === id)?.title ?? gamesById.get(id)?.title ?? ''} />
          : <p className="lv-muted">Not enough history to draw yet.</p>}
      </section>

      <div className="lv-grid">
        <section className="surface vx-card" aria-labelledby="lv-top-title">
          <SectionHead title={<span id="lv-top-title">Top value</span>} meta="Today’s store price" />
          {top.length ? (
            <ol className="lv-top">
              {top.map((g, i) => (
                <li key={g.gameId}>
                  <span className="lv-top__rank num" aria-hidden>{i + 1}</span>
                  <button className="lv-top__title" onClick={() => navigate({ name: 'game', id: g.gameId })}>{g.title}</button>
                  {g.formatted && g.currency === money.target ? <span className="num lv-top__price">{g.formatted}</span> : <Price className="lv-top__price" amount={g.priceCents!} currency={g.currency} minor />}
                  {g.regularCents != null && g.priceCents != null && g.regularCents > g.priceCents && (
                    <span className="lv-top__sale">on sale (usually {formatCents(g.regularCents, g.currency)})</span>
                  )}
                </li>
              ))}
            </ol>
          ) : <p className="lv-muted">{data.pricesEnabled ? 'Prices appear after the first refresh. Only Steam games can be priced.' : 'Turn on store prices in Settings → Library & stores → Data sources.'}</p>}
        </section>

        <section className="surface vx-card" aria-labelledby="lv-list-title">
          <SectionHead title={<span id="lv-list-title">Recent arrivals</span>} meta="Newest first, with where each date comes from" />
          <ul className="lv-list">
            {[...scoped].reverse().slice(0, 8).map((g) => (
              <li key={g.gameId}>
                <div>
                  <button className="lv-top__title" onClick={() => navigate({ name: 'game', id: g.gameId })}>{g.title}</button>
                  <span className="lv-list__src">{new Date(g.since).toLocaleDateString(undefined, { dateStyle: 'medium' })} · {SINCE_LABEL[g.sinceSource]}</span>
                </div>
                <span className="num lv-list__price">
                  {g.priceCents != null ? formatCents(g.priceCents, g.currency) : g.notSold ? <span className="lv-muted">Free or not sold</span> : <span className="lv-muted">No price{g.platforms.includes('steam') ? '' : ' (not on Steam)'}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {/* Track M: next Steam sale (dates announced by Valve) and an estimate of backlog savings from past lows. */}
      <ValueForecast />
      <p className="lv-foot"><StoreLogo platform="steam" size={14} decorative /> Prices come from the Steam store’s public price data for {data.country}; games from other stores are counted but not priced.</p>
    </div>
  );
}

const M = { l: 64, r: 16, t: 14, b: 28 };

function niceStep(max: number, target = 4): number {
  const raw = max / target;
  const pow = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function ValueChart({ points, currency, titleOf }: { points: ValuePoint[]; currency: string | null; titleOf: (id: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const [hover, setHover] = useState<number | null>(null);
  const height = 260;
  const byValue = currency != null;
  const value = (p: ValuePoint) => (byValue ? p.cents : p.count);
  const t0 = points[0].t;
  const t1 = Math.max(points[points.length - 1].t, t0 + 86400000);
  const max = Math.max(1, ...points.map(value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const pw = Math.max(10, width - M.l - M.r);
  const ph = height - M.t - M.b;
  const x = (t: number) => M.l + ((t - t0) / (t1 - t0)) * pw;
  const y = (v: number) => M.t + (1 - v / top) * ph;
  const base = M.t + ph;

  const { line, area } = useMemo(() => {
    // Step-after: the value holds until the next game arrives.
    let d = `M${x(points[0].t).toFixed(1)},${y(value(points[0])).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) {
      d += `H${x(points[i].t).toFixed(1)}V${y(value(points[i])).toFixed(1)}`;
    }
    const end = x(t1).toFixed(1);
    d += `H${end}`;
    return { line: d, area: `${d}V${base}H${x(points[0].t).toFixed(1)}Z` };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, pw, top, byValue]);

  const years = yearMarkers(points);
  const fmt = (v: number) => (byValue ? formatCents(v, currency) : `${v}`);
  // Thousands get one decimal when whole thousands would repeat a label ("1.5k, 2k, 2.5k", never "2k, 2k").
  const kDecimals = byValue && new Set(ticks.map((v) => Math.round(v / 100000))).size < ticks.length ? 1 : 0;
  const tickLabel = (v: number) => (byValue ? (v >= 100000 ? `${Number((v / 100000).toFixed(kDecimals))}k` : `${Math.round(v / 100)}`) : `${v}`);
  const hp = hover != null ? points[hover] : null;

  const fromPointer = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = t0 + ((e.clientX - rect.left) / rect.width) * (t1 - t0);
    let idx = 0;
    for (let i = 0; i < points.length; i++) if (points[i].t <= t) idx = i;
    setHover(idx);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = hover ?? -1;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(points.length - 1, cur + (e.shiftKey ? 10 : 1));
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - (e.shiftKey ? 10 : 1));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = points.length - 1;
    else if (e.key === 'Escape') next = null;
    if (next === undefined) return;
    e.preventDefault();
    setHover(next);
  };
  const cx = hp ? x(hp.t) : 0;
  const flip = cx + 220 > width;
  const summary = `Library ${byValue ? 'value' : 'size'} over time: from ${fmt(value(points[0]))} on ${new Date(t0).toLocaleDateString()} to ${fmt(value(points[points.length - 1]))} today, across ${points.length} games.`;

  return (
    <div ref={ref} className="vx-chart lv-chart" role="group" aria-roledescription="chart" tabIndex={0} onKeyDown={onKey} onBlur={() => setHover(null)}
      aria-label={`${summary} Use the left and right arrow keys to step through games.`}>
      <svg width={width} height={height} role="img" aria-label={summary}>
        <defs>
          <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.32 }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">{tickLabel(v)}</text>
          </g>
        ))}
        {years.map((m) => (
          <g key={m.year} aria-hidden>
            <line className="lv-chart__year" x1={Math.round(x(m.t)) + 0.5} x2={Math.round(x(m.t)) + 0.5} y1={M.t} y2={base} />
            <text className="vx-chart__tick" x={x(m.t)} y={height - 8} textAnchor="middle">{m.year}</text>
          </g>
        ))}
        {years.length === 0 && (
          <text className="vx-chart__tick" x={M.l} y={height - 8}>{new Date(t0).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</text>
        )}
        <motion.path d={area} fill={`url(#${gid}-fill)`} initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.7, delay: 0.2 }} />
        <motion.path className="vx-chart__line" d={line} style={{ stroke: 'var(--accent)' }} initial={reduce ? false : { pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }} />
        {hp && (
          <g aria-hidden>
            <line className="vx-chart__cross" x1={Math.round(cx) + 0.5} x2={Math.round(cx) + 0.5} y1={M.t} y2={base} />
            <circle className="vx-chart__dot" cx={cx} cy={y(value(hp))} r={4.5} style={{ fill: 'var(--accent)' }} />
          </g>
        )}
        <rect className="vx-chart__hit" x={M.l} y={M.t} width={pw} height={ph} onPointerMove={fromPointer} onPointerDown={fromPointer} onPointerLeave={() => setHover(null)} />
      </svg>
      {byValue && <span className="lv-chart__unit" aria-hidden>{currency}</span>}
      {hp && (
        <div className="vx-tip lv-tip" style={flip ? { left: Math.max(0, cx - 12), transform: 'translateX(-100%)' } : { left: Math.max(M.l, cx + 12) }} aria-hidden>
          <strong className="num">{fmt(value(hp))}</strong>
          <span>{hp.count} {hp.count === 1 ? 'game' : 'games'} by {new Date(hp.t).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>
          <span className="lv-tip__game">+ {titleOf(hp.gameId)}</span>
        </div>
      )}
      <span className="visually-hidden" aria-live="polite">{hp ? `${titleOf(hp.gameId)}, ${new Date(hp.t).toLocaleDateString()}: ${fmt(value(hp))}, ${hp.count} games` : ''}</span>
    </div>
  );
}
