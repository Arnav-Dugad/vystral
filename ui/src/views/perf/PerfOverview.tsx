/**
 * Track C2: the Performance page's Overview tab — headline figures, frame rate and 1% lows across sessions (one axis,
 * both in fps), and a few sessions worth a look.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { Activity, ArrowRight, BarChart3, Flame, Gauge, MonitorCog, MousePointerClick, Sparkles, Table2, Thermometer, TrendingDown, Zap } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { Button, SectionHead } from '../../components/ui/primitives';
import { formatDuration, plural } from '../../lib/format';
import { spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { GameThumb, StatTile } from './kit';
import { useElementWidth } from './hooks';
import { niceTicks } from './series';
import { formatSpan } from './insight';
import { gameTitle, shortDate } from './text';
import { HealthPip } from './PerfSummaryBand';
import { HEALTH_LABEL, fpsTrend, healthOf, highlights, kpis, type Highlight, type PerfEntry, type TrendPoint } from './overview';

const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

export function PerfOverview({ entries, gamesById, onOpen }: { entries: PerfEntry[]; gamesById: Map<string, Game>; onOpen: (id: string) => void }) {
  const k = useMemo(() => kpis(entries), [entries]);
  const trend = useMemo(() => fpsTrend(entries, 30), [entries]);
  const notable = useMemo(() => highlights(entries), [entries]);
  return (
    <div className="pf-stack">
      <div className="vx-tiles pf-kpis">
        <StatTile icon={<Gauge size={13} />} label="Sessions" value={k.sessions.toLocaleString()} sub={<>{formatDuration(k.hours * 3600)} measured</>} />
        <StatTile
          icon={<Activity size={13} />}
          label="Typical frame rate"
          unavailable={k.medianFps == null}
          value={k.medianFps == null ? 'Not measured' : <>{Math.round(k.medianFps)}<small>fps</small></>}
          sub={k.medianFps == null ? 'Turn on frame-rate capture' : <>Median of {plural(k.withFps, 'session')}</>}
        />
        <StatTile
          icon={<TrendingDown size={13} />}
          label="Typical 1% low"
          unavailable={k.medianLow == null}
          value={k.medianLow == null ? 'Not measured' : <>{Math.round(k.medianLow)}<small>fps</small></>}
          sub="The slowest 1% of frames"
        />
        <StatTile icon={<MonitorCog size={13} />} label="GPU load" unavailable={k.gpuLoad == null} value={k.gpuLoad == null ? 'Unavailable' : `${Math.round(k.gpuLoad)}%`} sub="Average across sessions" />
        <StatTile icon={<Thermometer size={13} />} label="Hottest GPU" unavailable={k.hottestC == null} value={k.hottestC == null ? 'Unavailable' : `${Math.round(k.hottestC)} °C`} sub={k.hottestC == null ? 'Needs an NVIDIA driver' : 'Peak in any session'} />
        <StatTile
          icon={<Zap size={13} />}
          label="Held back"
          value={k.throttledSeconds + k.powerLimitedSeconds > 0 ? formatSpan(k.throttledSeconds + k.powerLimitedSeconds) : 'Never'}
          sub={<>Heat <span className="num">{formatSpan(k.throttledSeconds)}</span> · power <span className="num">{formatSpan(k.powerLimitedSeconds)}</span></>}
        />
      </div>

      <section className="surface vx-card" aria-labelledby="pf-fpstrend-title">
        {trend.length >= 2 ? (
          <FpsTrendChart points={trend} gamesById={gamesById} onOpen={onOpen} />
        ) : (
          <>
            <SectionHead title={<span id="pf-fpstrend-title">Frame rate across sessions</span>} />
            <p className="pf-muted">
              {trend.length === 1
                ? 'One session has frame-rate data so far. After the next one, this chart compares them.'
                : 'No session has frame-rate data yet. With frame-rate capture on (Settings › Launching & sessions), every session’s average and 1% lows land here.'}
            </p>
          </>
        )}
      </section>

      {notable.length > 0 && (
        <section className="pf-notable" aria-labelledby="pf-notable-title">
          <SectionHead title={<span id="pf-notable-title">Worth a look</span>} meta="Sessions that stand out — open one for the details" />
          <ul className="pf-notable__list">
            {notable.map((h, i) => (
              <NotableCard key={h.entry.id} h={h} i={i} game={gamesById.get(h.entry.gameId)} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const NOTABLE_ICON: Record<Highlight['kind'], typeof Flame> = { roughest: TrendingDown, hottest: Flame, power: Zap, smoothest: Sparkles };

function NotableCard({ h, i, game, onOpen }: { h: Highlight; i: number; game: Game | undefined; onOpen: (id: string) => void }) {
  const reduce = useReducedMotion();
  const Icon = NOTABLE_ICON[h.kind];
  const health = healthOf(h.entry);
  return (
    <motion.li
      className="pf-notable__item surface"
      data-kind={h.kind}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.15 } : { ...spring.panel, delay: 0.05 * i }}
    >
      <GameThumb game={game} size={40} />
      <div className="pf-notable__body">
        <span className="pf-notable__kind"><Icon size={13} aria-hidden />{h.title}</span>
        <span className="pf-notable__game truncate">{gameTitle(game)}</span>
        <span className="pf-notable__text">{h.body}</span>
        <span className="pf-notable__meta">
          <HealthPip level={health.level} size={10} />
          {HEALTH_LABEL[health.level]} · {fmtDateTime(h.entry.startMs)}
        </span>
      </div>
      <Button size="sm" variant="ghost" icon={<ArrowRight size={14} />} onClick={() => onOpen(h.entry.id)} aria-label={`Open the ${gameTitle(game)} session from ${fmtDateTime(h.entry.startMs)}`}>
        Open
      </Button>
    </motion.li>
  );
}

/* ------------------------------------------------------------------ trend chart */

const H = 220;
const M = { l: 40, r: 40, t: 14, b: 28 };

function FpsTrendChart({ points, gamesById, onOpen }: { points: TrendPoint[]; gamesById: Map<string, Game>; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 900);
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [table, setTable] = useState(false);

  const pw = Math.max(40, width - M.l - M.r);
  const ph = H - M.t - M.b;
  const domain = niceTicks(0, Math.max(...points.map((p) => p.avg), 30) * 1.08, 4);
  const x = (i: number) => M.l + (points.length === 1 ? pw / 2 : (i / (points.length - 1)) * pw);
  const y = (v: number) => M.t + (1 - v / (domain.max || 1)) * ph;
  const base = M.t + ph;
  const last = points.length - 1;

  const line = (key: 'avg' | 'low') => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const avgLine = line('avg');
  const area = `${avgLine}L${x(last).toFixed(1)},${base}L${x(0).toFixed(1)},${base}Z`;

  const fromPointer = (clientX: number, rect: DOMRect) => {
    const f = (clientX - rect.left - M.l) / pw;
    setActive(Math.min(last, Math.max(0, Math.round(f * last))));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? last;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(last, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape' && active != null) next = null;
    else if ((e.key === 'Enter' || e.key === ' ') && active != null) {
      e.preventDefault();
      onOpen(points[active].id);
      return;
    }
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const p = active != null ? points[active] : null;
  const readout = p ? `${gameTitle(gamesById.get(p.gameId))}, ${fmtDateTime(p.startMs)}: average ${Math.round(p.avg)} fps, 1% low ${p.low == null ? 'not measured' : `${Math.round(p.low)} fps`}. Press Enter to open it.` : '';
  const lastP = points[last];
  // Direct labels at the right end, only when they don't collide.
  const endLabels = lastP.low == null || Math.abs(y(lastP.avg) - y(lastP.low)) >= 14;
  const cx = active != null ? x(active) : 0;
  const flip = cx > width - 230;
  const summary = `Frame rate across your last ${points.length} measured sessions, from ${shortDate(points[0].startMs)} to ${shortDate(lastP.startMs)}. Latest: average ${Math.round(lastP.avg)} fps${lastP.low != null ? `, 1% low ${Math.round(lastP.low)} fps` : ''}.`;

  return (
    <>
      <SectionHead
        title={<span id="pf-fpstrend-title">Frame rate across sessions</span>}
        meta="Each point is one session · select one to open it"
        action={
          <Button size="sm" variant="ghost" icon={table ? <BarChart3 size={14} /> : <Table2 size={14} />} aria-pressed={table} onClick={() => setTable((v) => !v)}>
            {table ? 'Show as chart' : 'Show as table'}
          </Button>
        }
      />
      <ul className="pf-legend" aria-label="Lines">
        <li><span className="pf-key pf-key--avg" aria-hidden />Average</li>
        <li><span className="pf-key pf-key--low" aria-hidden />1% low</li>
      </ul>
      {table ? (
        <div className="pf-table-wrap" tabIndex={0} role="region" aria-label="Frame rate across sessions, as a table">
          <table className="pf-table">
            <thead>
              <tr><th scope="col">Session</th><th scope="col">Game</th><th scope="col">Average</th><th scope="col">1% low</th><th scope="col"><span className="visually-hidden">Open</span></th></tr>
            </thead>
            <tbody>
              {points.slice().reverse().map((q) => (
                <tr key={q.id}>
                  <th scope="row">{fmtDateTime(q.startMs)}</th>
                  <td>{gameTitle(gamesById.get(q.gameId))}</td>
                  <td className="num">{Math.round(q.avg)} fps</td>
                  <td className="num">{q.low == null ? '—' : `${Math.round(q.low)} fps`}</td>
                  <td><Button size="sm" variant="ghost" onClick={() => onOpen(q.id)}>Open</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div
          ref={ref}
          className="vx-chart pf-trendchart"
          role="group"
          aria-roledescription="chart"
          aria-label={`${summary} Use the left and right arrow keys to move between sessions and Enter to open one.`}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            if (active == null) setActive(last);
          }}
          onBlur={() => {
            setFocused(false);
            setActive(null);
          }}
        >
          <svg width={width} height={H} role="img" aria-label={summary}>
            <defs>
              <linearGradient id="pf-trend-wash" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: 'var(--viz-1)', stopOpacity: 0.12 }} />
                <stop offset="100%" style={{ stopColor: 'var(--viz-1)', stopOpacity: 0 }} />
              </linearGradient>
            </defs>
            {domain.ticks.map((v) => (
              <g key={v}>
                <line className={v === domain.min ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
                <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">{v}</text>
              </g>
            ))}
            <text className="vx-chart__tick" x={M.l} y={H - 8} textAnchor="start">{shortDate(points[0].startMs)}</text>
            <text className="vx-chart__tick" x={M.l + pw} y={H - 8} textAnchor="end">{shortDate(lastP.startMs)}</text>
            <motion.path d={area} fill="url(#pf-trend-wash)" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduce ? { duration: 0 } : { duration: 0.6, delay: 0.3 }} />
            {(['low', 'avg'] as const).map((key) => (
              <motion.path
                key={key}
                className={`vx-chart__line pf-trendchart__line--${key}`}
                d={line(key)}
                initial={reduce ? false : { pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
              />
            ))}
            {points.map((q, i) => (
              <g key={q.id} className="pf-trendchart__pts" data-active={active === i || undefined}>
                <circle className="pf-trendchart__dot pf-trendchart__dot--avg" cx={x(i)} cy={y(q.avg)} r={active === i ? 5.5 : 4} />
                {q.low != null && <circle className="pf-trendchart__dot pf-trendchart__dot--low" cx={x(i)} cy={y(q.low)} r={active === i ? 5.5 : 4} />}
              </g>
            ))}
            {endLabels && (
              <g className="pf-trendchart__end" aria-hidden>
                <text x={x(last) + 9} y={y(lastP.avg)} dy="0.35em">{Math.round(lastP.avg)}</text>
                {lastP.low != null && <text x={x(last) + 9} y={y(lastP.low)} dy="0.35em">{Math.round(lastP.low)}</text>}
              </g>
            )}
            {active != null && <line className="vx-chart__cross" x1={Math.round(cx) + 0.5} x2={Math.round(cx) + 0.5} y1={M.t} y2={base} aria-hidden />}
            <rect
              className="vx-chart__hit pf-trendchart__hit"
              x={M.l - 12}
              y={M.t}
              width={pw + 24}
              height={ph}
              onPointerMove={(e) => fromPointer(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect())}
              onPointerDown={(e) => fromPointer(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect())}
              onPointerLeave={() => !focused && setActive(null)}
              onClick={() => active != null && onOpen(points[active].id)}
            />
          </svg>
          {p && (
            <div className="vx-tip pf-trendchart__tip" style={flip ? { left: Math.max(0, cx - 14), transform: 'translateX(-100%)' } : { left: cx + 14 }} aria-hidden>
              <span className="pf-trendchart__tip-game">{gameTitle(gamesById.get(p.gameId))}</span>
              <span className="pf-trendchart__tip-when">{fmtDateTime(p.startMs)}</span>
              <span className="pf-trendchart__tip-row"><span className="vx-tip__key pf-key--avg" /><strong className="num">{Math.round(p.avg)} fps</strong> average</span>
              <span className="pf-trendchart__tip-row"><span className="vx-tip__key pf-key--low" /><strong className="num">{p.low == null ? '—' : `${Math.round(p.low)} fps`}</strong> 1% low</span>
              <span className="pf-trendchart__tip-hint"><MousePointerClick size={11} aria-hidden /> Click to open</span>
            </div>
          )}
          {focused && <span className="visually-hidden" aria-live="polite">{readout}</span>}
        </div>
      )}
    </>
  );
}
