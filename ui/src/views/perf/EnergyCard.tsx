import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { Info, Plug, Settings2, Zap } from 'lucide-react';
import type { EnergyMethod, EnergyReport, Game } from '../../bridge/types';
import { Badge, Button, SectionHead, Skeleton } from '../../components/ui/primitives';
import { formatDuration, plural } from '../../lib/format';
import { useReducedMotion, useStore } from '../../state/store';
import { DeviceName } from '../../components/ui/ServiceLogo';
import { GameThumb, StatTile } from './kit';
import { useElementWidth } from './hooks';
import { niceTicks } from './series';
import { gameTitle } from './text';
import { usePlayData } from './usePlayData';
import './play-data.css';

const HEIGHT = 170;
const M = { l: 44, r: 6, t: 12, b: 24 };

/** "0.42 kWh", "12.3 kWh", "180 Wh" for small amounts. */
export function formatKWh(kWh: number): string {
  if (!Number.isFinite(kWh) || kWh <= 0) return '0 kWh';
  if (kWh < 0.1) return `${Math.round(kWh * 1000)} Wh`;
  return `${kWh < 10 ? kWh.toFixed(2) : kWh < 100 ? kWh.toFixed(1) : Math.round(kWh).toLocaleString()} kWh`;
}

/** Cost in the chosen currency, or a plain number when none was chosen. */
export function formatCost(kWh: number, price: number | null, currency: string | null): string | null {
  if (price == null || price <= 0) return null;
  const v = kWh * price;
  try {
    if (currency) return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: v < 10 ? 2 : 0 }).format(v);
  } catch {
    // An unknown currency code: fall back to a number.
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: v < 10 ? 2 : 0 });
}

function useEnergy(gameId: string | null) {
  const s = useStore((x) => x.settings);
  const key = `${gameId ?? 'all'}|${s?.['energy.enabled']}|${s?.['energy.watts']}|${s?.['energy.price']}|${s?.['energy.currency']}`;
  return usePlayData<EnergyReport>('energy.report', { gameId }, key);
}

/** The method, in words: shown in a popover next to every energy figure. */
export function EnergyMethodPopover({ method, price, currency }: { method: EnergyMethod; price: number | null; currency: string | null }) {
  const id = useId().replace(/:/g, '');
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    const p = pop.current;
    if (!b || !p) return;
    const w = Math.min(380, window.innerWidth - 24);
    p.style.width = `${w}px`;
    p.style.left = `${Math.max(12, Math.min(window.innerWidth - w - 12, b.right - w))}px`;
    // Below the button when it fits, else above it, else as high as the window allows.
    const h = p.offsetHeight;
    const below = b.bottom + 8;
    const above = b.top - 8 - h;
    p.style.top = `${below + h <= window.innerHeight - 12 ? below : above >= 12 ? above : Math.max(12, window.innerHeight - h - 12)}px`;
  };
  return (
    <>
      <Button ref={btn} size="sm" variant="ghost" icon={<Info size={14} />} {...{ popoverTarget: `energy-method-${id}` }} onClick={() => requestAnimationFrame(place)}>
        How it’s estimated
      </Button>
      <div ref={pop} id={`energy-method-${id}`} {...{ popover: 'auto' }} className="en-pop" role="dialog" aria-label="How the energy estimate works" onToggle={place}>
        <h3 className="en-pop__title">How the energy estimate works</h3>
        {method.source === 'manual' ? (
          <p>
            You entered <strong className="num">{method.manualWatts} W</strong> as your PC’s draw at a full gaming load. Each session uses
            <span className="en-formula"> {method.manualWatts} W × (0.3 + 0.7 × load)</span>, where load is 75% GPU and 25% CPU, from the samples VYSTRAL recorded.
          </p>
        ) : (
          <>
            <p>Whole-PC power while a game runs, from the GPU and CPU load VYSTRAL recorded during the session and typical power figures for your hardware:</p>
            <p className="en-formula">
              {method.baseWatts} W base + {method.gpuWatts} W × (0.2 + 0.8 × GPU load) + {method.cpuWatts} W × (0.25 + 0.75 × CPU load)
            </p>
            <ul className="en-pop__list">
              <li><span className="caps">Graphics</span> {method.gpuName ? <DeviceName name={method.gpuName} /> : 'Unknown'} · {method.gpuKnown ? `typical board power ${method.gpuWatts} W` : `not recognised, so a typical ${method.gpuWatts} W`}</li>
              <li><span className="caps">Processor</span> {method.cpuName ?? 'Unknown'} · {method.cpuKnown ? `about ${method.cpuWatts} W` : `not recognised, so ${method.cpuWatts} W`}</li>
              <li><span className="caps">Rest of the PC</span> {method.baseWatts} W ({method.laptop ? 'laptop' : 'desktop'}: board, memory, storage, fans, power-supply losses)</li>
            </ul>
          </>
        )}
        <p>
          The formula is linear in load, so a session’s average load gives exactly the same total as adding up every sample. Sessions recorded without load
          samples aren’t counted; where only one of GPU or CPU load was recorded, a typical {Math.round(method.typicalLoad * 100)}% stands in for the other.
          Monitors and speakers aren’t included.
        </p>
        <p>
          It’s an estimate, typically within ±30% of a wall meter. For a real figure, measure your PC at the wall and enter that wattage in Settings › Launching &amp; sessions.
          {price != null ? ` Cost uses your price of ${price.toLocaleString(undefined, { maximumFractionDigits: 4 })}${currency ? ` ${currency}` : ''} per kWh.` : ''}
        </p>
      </div>
    </>
  );
}

/**
 * Track Y: the opt-in energy estimate for the Performance view — kWh per month (and per game), with
 * cost at the user's price. Off: a short invitation. Always labelled as an estimate, with its method.
 */
export function EnergyCard({ gameId }: { gameId: string | null }) {
  const { data, loading, error } = useEnergy(gameId);
  const set = useStore((s) => s.setSetting);
  const navigate = useStore((s) => s.navigate);
  const gamesById = useStore((s) => s.gamesById);
  const reduce = useReducedMotion();

  if (loading && !data) return <Skeleton height={260} radius={22} />;
  if (!data) return <section className="surface vx-card en-card"><p className="pf-muted">The energy estimate couldn’t be loaded: {error}</p></section>;

  const head = (
    <SectionHead
      title={<span id="en-title"><Zap size={16} aria-hidden className="di-title-icon" />Energy</span>}
      meta={data.enabled ? <Badge tone="glass">Estimate</Badge> : 'Off'}
      action={data.enabled && data.method ? <EnergyMethodPopover method={data.method} price={data.price} currency={data.currency} /> : undefined}
    />
  );

  if (!data.enabled)
    return (
      <section className="surface vx-card en-card" aria-labelledby="en-title">
        {head}
        <p className="pf-muted">
          Estimate how much electricity your gaming uses — per session, per game and per month, and what it costs at your price — from the GPU and CPU load VYSTRAL
          already records. It’s calculated on this PC and clearly labelled as an estimate.
        </p>
        <div className="en-actions">
          <Button variant="primary" size="sm" icon={<Plug size={14} />} onClick={() => void set('energy.enabled', true)}>Turn on energy estimate</Button>
          <Button size="sm" variant="ghost" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'launching' })}>Wattage and price</Button>
        </div>
      </section>
    );

  return (
    <section className="surface vx-card en-card" aria-labelledby="en-title">
      {head}
      {data.sessions === 0 ? (
        <p className="pf-muted">
          No sessions with load samples yet{data.excluded > 0 ? ` (${plural(data.excluded, 'session')} were recorded with metrics off)` : ''}. Your next session with performance metrics on will appear here.
        </p>
      ) : (
        <EnergyBody data={data} gameId={gameId} gamesById={gamesById} reduce={reduce} />
      )}
    </section>
  );
}

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function EnergyBody({ data, gameId, gamesById, reduce }: { data: EnergyReport; gameId: string | null; gamesById: Map<string, Game>; reduce: boolean }) {
  const now = new Date();
  const months = useMemo(() => {
    const byKey = new Map(data.months.map((m) => [m.month, m]));
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 11 + i, 1);
      const m = byKey.get(monthKey(d));
      return { start: d.getTime(), kWh: m?.kWh ?? 0, sessions: m?.sessions ?? 0, hours: m?.hours ?? 0 };
    });
  }, [data.months]); // eslint-disable-line react-hooks/exhaustive-deps
  const thisMonth = months[11];
  const avgWatts = useMemo(() => {
    const hours = data.months.reduce((a, m) => a + m.hours, 0);
    return hours > 0 ? Math.round((data.totalKWh * 1000) / hours) : null;
  }, [data]);
  const cost = (k: number) => formatCost(k, data.price, data.currency);

  return (
    <div className="en-body">
      <div className="vx-tiles en-tiles">
        <StatTile icon={<Zap size={13} />} label="This month" value={formatKWh(thisMonth.kWh)} sub={cost(thisMonth.kWh) ?? `${plural(thisMonth.sessions, 'session')}`} />
        <StatTile label={gameId ? 'All sessions' : 'All tracked'} value={formatKWh(data.totalKWh)} sub={cost(data.totalKWh) ?? plural(data.sessions, 'session')} />
        {avgWatts != null && <StatTile label="Average draw" value={`${avgWatts} W`} sub="While playing" />}
      </div>
      <p className="en-chart-cap" aria-hidden>kWh per month · estimate</p>
      <MonthChart months={months} price={data.price} currency={data.currency} reduce={reduce} />
      {!gameId && data.games.length > 0 && (
        <ol className="en-games" aria-label="Energy by game">
          {data.games.slice(0, 5).map((g) => (
            <li key={g.gameId} className="en-game">
              <GameThumb game={gamesById.get(g.gameId)} size={26} />
              <span className="en-game__title truncate">{gameTitle(gamesById.get(g.gameId))}</span>
              <span className="en-game__meta num">{formatDuration(g.hours * 3600)}</span>
              <span className="en-game__value num">{formatKWh(g.kWh)}{cost(g.kWh) ? <span className="en-game__cost"> · {cost(g.kWh)}</span> : null}</span>
            </li>
          ))}
        </ol>
      )}
      {(data.excluded > 0 || data.partial > 0) && (
        <p className="di-foot">
          <Info size={13} aria-hidden />
          <span>
            {data.excluded > 0 ? `${plural(data.excluded, 'session')} without load samples ${data.excluded === 1 ? 'isn’t' : 'aren’t'} counted. ` : ''}
            {data.partial > 0 ? `${plural(data.partial, 'session')} recorded only one of GPU or CPU load; a typical load stands in for the other.` : ''}
          </span>
        </p>
      )}
    </div>
  );
}

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function MonthChart({ months, price, currency, reduce }: { months: { start: number; kWh: number; sessions: number; hours: number }[]; price: number | null; currency: string | null; reduce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 600);
  const gid = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const n = months.length;
  const pw = Math.max(40, width - M.l - M.r);
  const ph = HEIGHT - M.t - M.b;
  const slot = pw / n;
  const barW = Math.min(24, slot - 6);
  const max = Math.max(...months.map((m) => m.kWh), 0.05);
  const domain = useMemo(() => niceTicks(0, max, 3), [max]);
  const y = (v: number) => M.t + (1 - v / (domain.max || 1)) * ph;
  const label = (ms: number, long = false) => new Intl.DateTimeFormat(undefined, { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined }).format(ms);
  const tick = (v: number) => (v === 0 ? '0' : `${Number.isInteger(v) ? v : v < 0.1 ? v.toFixed(2) : v.toFixed(1)}`);
  const summary = `Estimated energy per month, last 12 months: ${months.filter((m) => m.kWh > 0).map((m) => `${label(m.start, true)} ${formatKWh(m.kWh)}`).join(', ') || 'none'}.`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape' && active != null) next = null;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
  };
  const a = active != null ? months[active] : null;
  const ax = active != null ? M.l + active * slot + slot / 2 : 0;
  const costA = a ? formatCost(a.kWh, price, currency) : null;

  return (
    <div
      ref={ref}
      className="vx-chart"
      role="group"
      aria-roledescription="chart"
      tabIndex={0}
      aria-label={`${summary} Use the left and right arrow keys to read each month.`}
      onKeyDown={onKeyDown}
      onFocus={() => { setFocused(true); setActive((v) => v ?? n - 1); }}
      onBlur={() => { setFocused(false); setActive(null); }}
      onPointerLeave={() => !focused && setActive(null)}
    >
      <svg width={width} height={HEIGHT} role="img" aria-label={summary}>
        <defs>
          <linearGradient id={`${gid}-bar`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent-2)', stopOpacity: 0.75 }} />
          </linearGradient>
        </defs>
        {domain.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">{tick(v)}</text>
          </g>
        ))}
        {months.map((m, i) => (slot >= 34 || i % 2 === (n - 1) % 2) && (
          <text key={m.start} className="vx-chart__tick" x={M.l + i * slot + slot / 2} y={HEIGHT - 6} textAnchor="middle">{label(m.start)}</text>
        ))}
        <motion.g
          initial={reduce ? { opacity: 0 } : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={reduce ? { duration: 0.15 } : { type: 'spring', visualDuration: 0.5, bounce: 0.08 }}
          style={{ originY: 1 }}
        >
          {months.map((m, i) => {
            if (m.kWh <= 0) return null;
            const h = Math.max(1.5, (m.kWh / (domain.max || 1)) * ph);
            return (
              <path key={m.start} d={barPath(M.l + i * slot + (slot - barW) / 2, M.t + ph - h, barW, h)} fill={`url(#${gid}-bar)`}
                style={{ opacity: active == null || active === i ? 1 : 0.45, transition: 'opacity 140ms var(--ease-out)' }} />
            );
          })}
        </motion.g>
        {months.map((m, i) => (
          <rect key={m.start} className="vx-chart__hit" x={M.l + i * slot} y={M.t} width={slot} height={ph} style={{ cursor: 'default' }} onPointerEnter={() => setActive(i)} />
        ))}
      </svg>
      {a && (
        <div className="vx-tip" style={ax + 180 > width ? { left: ax - 10, transform: 'translateX(-100%)' } : { left: ax + 10 }} aria-hidden>
          <strong className="num">{a.kWh > 0 ? formatKWh(a.kWh) : 'Nothing measured'}</strong>
          {label(a.start, true)}
          {a.sessions > 0 && <> · {plural(a.sessions, 'session')} · {formatDuration(a.hours * 3600)}{costA ? ` · ${costA}` : ''}</>}
        </div>
      )}
      {focused && a && (
        <span className="visually-hidden" aria-live="polite">
          {label(a.start, true)}: {a.kWh > 0 ? `${formatKWh(a.kWh)}, ${plural(a.sessions, 'session')}${costA ? `, ${costA}` : ''}` : 'nothing measured'}
        </span>
      )}
    </div>
  );
}

/** A stat tile for one session in the Performance detail, when the estimate is on and has that session. */
export function SessionEnergyTile({ sessionId }: { sessionId: string }) {
  const { data } = useEnergy(null);
  const s = data?.enabled ? data.sessionList.find((x) => x.sessionId === sessionId) : undefined;
  if (!s || !data) return null;
  const cost = formatCost(s.kWh, data.price, data.currency);
  return <StatTile icon={<Zap size={13} />} label="Energy (est.)" value={formatKWh(s.kWh)} sub={<>~<span className="num">{s.avgWatts} W</span>{cost ? ` · ${cost}` : ''}{s.partial ? ' · partly assumed' : ''}</>} />;
}
