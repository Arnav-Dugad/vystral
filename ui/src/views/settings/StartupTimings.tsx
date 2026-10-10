/**
 * Track C2: recent startup timings in Settings › About — the last starts as stacked phases (backend → WebView →
 * first paint → ready), the usual (median) start, and a calm warning when the newest start was much slower.
 * Read from VYSTRAL's own local log only; nothing leaves the PC.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, RefreshCw, Rocket, Table2, BarChart3 } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { StartupHistory, StartupRun } from '../../bridge/types.trackC2';
import { Button, Skeleton } from '../../components/ui/primitives';
import { useReducedMotion } from '../../state/store';
import { useElementWidth } from '../perf/hooks';
import { niceTicks } from '../perf/series';
import { PHASES, formatStartup, phasesOf, regressionText, summarize, totalOf } from '../../lib/startupTimings';
import './startup-timings.css';

const LIMIT = 20;
const H = 200;
const M = { l: 44, r: 86, t: 14, b: 26 };
const GAP = 2;
const fmtWhen = (iso: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso));
const fmtDay = (iso: string) => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(Date.parse(iso));

/** A column segment with rounded data-end (top) corners and a square base. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function StartupTimings() {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; runs: StartupRun[]; error: string | null }>({ status: 'loading', runs: [], error: null });
  const [table, setTable] = useState(false);
  const load = async () => {
    setState((s) => ({ ...s, status: s.runs.length ? 'ready' : 'loading', error: null }));
    try {
      const h = await call<StartupHistory>('diagnostics.startupHistory', { limit: LIMIT });
      const runs = Array.isArray(h?.runs) ? h.runs.filter((r) => r && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at))) : [];
      setState({ status: 'ready', runs, error: null });
    } catch (err) {
      setState((s) => ({ ...s, status: s.runs.length ? 'ready' : 'error', error: errorMessage(err) }));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const summary = useMemo(() => summarize(state.runs), [state.runs]);

  return (
    <section className="st surface" aria-labelledby="st-title">
      <header className="st__head">
        <span className="st__icon" aria-hidden><Rocket size={16} /></span>
        <div className="st__titles">
          <h2 id="st-title" className="st__title">Startup timings</h2>
          <p className="srow__hint">
            {state.runs.length ? `Your last ${state.runs.length === 1 ? 'start' : `${state.runs.length} starts`}, from VYSTRAL’s own log on this PC.` : 'How long VYSTRAL takes to start, from its own log on this PC.'}
          </p>
        </div>
        {state.runs.length > 0 && (
          <Button size="sm" variant="ghost" icon={table ? <BarChart3 size={14} /> : <Table2 size={14} />} aria-pressed={table} onClick={() => setTable((v) => !v)}>
            {table ? 'Show as chart' : 'Show as table'}
          </Button>
        )}
      </header>

      {state.status === 'loading' && <div role="status" aria-label="Loading startup timings"><Skeleton height={236} radius={16} /></div>}

      {state.status === 'error' && (
        <div className="st__empty" role="status">
          <p>Startup timings couldn’t be read: {state.error}</p>
          <Button size="sm" icon={<RefreshCw size={14} />} onClick={() => void load()}>Try again</Button>
        </div>
      )}

      {state.status === 'ready' && !state.runs.length && (
        <div className="st__empty" role="status">
          <p>No startup timings yet. VYSTRAL notes how long each start takes in its local log (kept for a week); they appear here from the next start.</p>
        </div>
      )}

      {state.status === 'ready' && state.runs.length > 0 && (
        <>
          <dl className="st__figures">
            <div>
              <dt>Usual start</dt>
              <dd>{formatStartup(summary.median)}</dd>
              <span className="st__sub">Median of the earlier starts</span>
            </div>
            <div>
              <dt>Last start</dt>
              <dd data-slow={summary.regression ? true : undefined}>
                {summary.regression && <AlertTriangle size={16} aria-hidden className="st__warn-icon" />}
                {formatStartup(summary.latestMs)}
              </dd>
              <span className="st__sub">{summary.latest ? fmtWhen(summary.latest.at) : ''}</span>
            </div>
            <div>
              <dt>Fastest</dt>
              <dd>{formatStartup(summary.fastestMs)}</dd>
              <span className="st__sub">of these {state.runs.length}</span>
            </div>
          </dl>

          {summary.regression && summary.latestMs != null && (
            <p className="st__regression" role="note">
              <AlertTriangle size={15} aria-hidden />
              <span><strong>Slower than usual.</strong> {regressionText(summary.regression, summary.latestMs)}</span>
            </p>
          )}

          <ul className="st__legend" aria-label="Startup phases">
            {PHASES.map((p, i) => (
              <li key={p.key} title={p.detail}>
                <span className="st__swatch" data-phase={i + 1} aria-hidden />
                {p.label}
              </li>
            ))}
          </ul>

          {table ? <StartupTable runs={state.runs} /> : <StartupChart runs={state.runs} median={summary.median} slowLatest={!!summary.regression} />}
        </>
      )}
    </section>
  );
}

function StartupChart({ runs, median, slowLatest }: { runs: StartupRun[]; median: number | null; slowLatest: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 560);
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  const pw = Math.max(40, width - M.l - M.r);
  const ph = H - M.t - M.b;
  const max = Math.max(...runs.map(totalOf), median ?? 0, 500);
  const domain = niceTicks(0, max * 1.06, 3);
  const y = (ms: number) => M.t + ph - (ms / (domain.max || 1)) * ph;
  // Columns sit in equal slots across the full width (a slot for 20 starts even when there are fewer).
  const slots = Math.max(runs.length, Math.min(LIMIT, 12));
  const slot = pw / slots;
  const barW = Math.max(6, Math.min(24, slot * 0.62));
  const colX = (i: number) => M.l + slot * (i + (slots - runs.length)) + (slot - barW) / 2;
  const last = runs.length - 1;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null | undefined;
    const cur = active ?? last;
    if (e.key === 'ArrowRight') next = Math.min(last, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else if (e.key === 'Escape' && active != null) next = null;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const run = active != null ? runs[active] : null;
  const phases = run ? phasesOf(run) : null;
  const readout = run && phases
    ? `${fmtWhen(run.at)}: ready in ${formatStartup(totalOf(run))}. ${phases.map((p, i) => `${PHASES[i].label} ${formatStartup(p.ms)}`).join(', ')}.${run.cachedFirstPaint ? '' : ' Home was drawn without a saved snapshot.'}`
    : '';
  const summaryLabel = `Startup timings for the last ${runs.length} starts. Usual start ${formatStartup(median)}; last start ${formatStartup(totalOf(runs[last]))}${slowLatest ? ', much slower than usual' : ''}.`;
  // Beside the column (never over it): to its left in the right half of the chart, else to its right.
  const tipLeft = run
    ? colX(active!) + barW / 2 > width / 2
      ? Math.max(0, colX(active!) - 14 - 210)
      : Math.min(Math.max(0, width - 210), colX(active!) + barW + 14)
    : 0;

  return (
    <div
      ref={ref}
      className="vx-chart st__chart"
      role="group"
      aria-roledescription="chart"
      aria-label={`${summaryLabel} Use the left and right arrow keys to read each start.`}
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
      onPointerLeave={() => !focused && setActive(null)}
    >
      <svg width={width} height={H} role="img" aria-label={summaryLabel}>
        {domain.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">{v === 0 ? '0' : `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s`}</text>
          </g>
        ))}
        {runs.map((r, i) => {
          const segs = phasesOf(r);
          const top = segs.reduce((k, s, j) => (s.ms > 0 ? j : k), -1);
          const x = colX(i);
          return (
            <motion.g
              key={r.at}
              className="st__col"
              data-active={active === i || undefined}
              data-dim={active != null && active !== i ? true : undefined}
              style={{ originY: 1 }}
              initial={reduce ? false : { scaleY: 0, opacity: 0 }}
              animate={{ scaleY: 1, opacity: 1 }}
              transition={reduce ? { duration: 0 } : { duration: 0.55, delay: 0.05 + i * 0.025, ease: [0.16, 1, 0.3, 1] }}
            >
              {segs.map((s, j) => {
                if (s.ms <= 0) return null;
                const y0 = y(s.from) - (j > 0 ? GAP : 0);
                const y1 = y(s.to);
                const h = Math.max(1, y0 - y1);
                return j === top
                  ? <path key={s.key} className="st__seg" data-phase={j + 1} d={topRounded(x, y1, barW, h, 4)} />
                  : <rect key={s.key} className="st__seg" data-phase={j + 1} x={x} y={y1} width={barW} height={h} />;
              })}
            </motion.g>
          );
        })}
        {median != null && (
          <g className="st__median" aria-hidden>
            <line x1={M.l} x2={M.l + pw} y1={Math.round(y(median)) + 0.5} y2={Math.round(y(median)) + 0.5} />
          </g>
        )}
        {slowLatest && (
          <path className="st__flag" d={`M${colX(last) + barW / 2},${y(totalOf(runs[last])) - 6}l-5,-8h10z`} aria-hidden />
        )}
        <text className="vx-chart__tick" x={colX(0)} y={H - 6} textAnchor="start">{fmtDay(runs[0].at)}</text>
        <text className="vx-chart__tick" x={colX(last) + barW} y={H - 6} textAnchor="end">Latest</text>
        {runs.map((r, i) => (
          <rect
            key={`hit-${r.at}`}
            className="vx-chart__hit st__hit"
            x={M.l + slot * (i + (slots - runs.length))}
            y={M.t}
            width={slot}
            height={ph}
            onPointerMove={() => setActive(i)}
            onPointerDown={() => setActive(i)}
          />
        ))}
      </svg>
      {median != null && (
        <span className="st__median-label num" style={{ top: y(median) - 9, left: M.l + pw + 6 }} aria-hidden>
          usual {formatStartup(median)}
        </span>
      )}
      {run && phases && (
        <div className="vx-tip st__tip" style={{ left: tipLeft }} aria-hidden>
          <strong className="num">{formatStartup(totalOf(run))}</strong>
          <span className="st__tip-when">{fmtWhen(run.at)}{run.cachedFirstPaint ? '' : ' · no saved Home'}</span>
          <ul>
            {phases.map((p, i) => (
              <li key={p.key}>
                <span className="st__swatch st__swatch--sm" data-phase={i + 1} />
                <span className="num">{formatStartup(p.ms)}</span>
                <span>{PHASES[i].label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {focused && (
        <span className="visually-hidden" aria-live="polite">
          {readout}
        </span>
      )}
    </div>
  );
}

function StartupTable({ runs }: { runs: StartupRun[] }) {
  return (
    <div className="st__table-wrap" tabIndex={0} role="region" aria-label="Startup timings table">
      <table className="st__table">
        <thead>
          <tr>
            <th scope="col">Start</th>
            {PHASES.map((p) => <th key={p.key} scope="col">{p.label}</th>)}
            <th scope="col">Total</th>
          </tr>
        </thead>
        <tbody>
          {runs.slice().reverse().map((r) => {
            const phases = phasesOf(r);
            return (
              <tr key={r.at}>
                <th scope="row">{fmtWhen(r.at)}</th>
                {phases.map((p) => <td key={p.key} className="num">{formatStartup(p.ms)}</td>)}
                <td className="num"><strong>{formatStartup(totalOf(r))}</strong></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
