import '../perf/kit.css';
import { memo, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { motion } from 'motion/react';
import { plural } from '../../lib/format';
import { useReducedMotion } from '../../state/store';
import { niceTicks } from '../perf/series';
import { useElementWidth } from '../perf/hooks';
import { shortDate } from '../perf/text';
import type { BacklogPoint } from './backlog';

const M = { l: 34, r: 8, t: 14, b: 26 };
const HEIGHT = 180;

function pointLabel(p: BacklogPoint, unit: 'day' | 'week'): string {
  return unit === 'week' ? `Week of ${shortDate(p.start, true)}` : new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(p.start);
}

/**
 * Backlog size over time as a single-series area (step-after, since the count only changes
 * when you change a status). Crosshair + tooltip on hover; arrow keys read each point.
 */
export const BacklogChart = memo(function BacklogChart({ points, unit, ariaLabel }: { points: BacklogPoint[]; unit: 'day' | 'week'; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 640);
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  const n = points.length;
  const pw = Math.max(10, width - M.l - M.r);
  const ph = HEIGHT - M.t - M.b;
  const max = Math.max(...points.map((p) => p.backlog), 1);
  const domain = useMemo(() => niceTicks(0, Math.max(max, 4), 4), [max]);
  const step = n > 1 ? pw / (n - 1) : 0;
  const x = (i: number) => M.l + (n > 1 ? i * step : pw / 2);
  const y = (v: number) => M.t + (1 - v / (domain.max || 1)) * ph;

  const { line, area } = useMemo(() => {
    if (!n) return { line: '', area: '' };
    let d = `M${x(0)},${y(points[0].backlog)}`;
    for (let i = 1; i < n; i++) d += `H${x(i)}V${y(points[i].backlog)}`;
    if (n === 1) d += `H${x(0) + 1}`;
    const base = y(0);
    return { line: d, area: `${d}V${base}H${x(0)}Z` };
  }, [points, n, width, domain.max]); // eslint-disable-line react-hooks/exhaustive-deps

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / 90))));
  const xLabels: number[] = [];
  for (let i = n - 1; i >= 0; i -= labelEvery) xLabels.push(i);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = active ?? n - 1;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + (e.shiftKey ? 7 : 1));
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - (e.shiftKey ? 7 : 1));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else if (e.key === 'Escape' && active != null) next = null;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
  };

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement ?? e.currentTarget).getBoundingClientRect();
    const i = n > 1 ? Math.round((e.clientX - r.left - M.l) / step) : 0;
    setActive(Math.max(0, Math.min(n - 1, i)));
  };

  const a = active != null ? points[active] : null;
  const ax = active != null ? x(active) : 0;
  const readout = a ? `${pointLabel(a, unit)}: ${plural(a.backlog, 'game')} in the backlog, ${a.playing} playing, ${a.finished} finished so far` : '';

  return (
    <div
      ref={ref}
      className="vx-chart"
      role="group"
      aria-roledescription="chart"
      tabIndex={0}
      aria-label={`${ariaLabel} Use the left and right arrow keys to read each ${unit}.`}
      onKeyDown={onKeyDown}
      onFocus={() => {
        setFocused(true);
        setActive((v) => v ?? n - 1);
      }}
      onBlur={() => {
        setFocused(false);
        setActive(null);
      }}
      onPointerLeave={() => !focused && setActive(null)}
    >
      <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.32 }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        {domain.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">{v}</text>
          </g>
        ))}
        {xLabels.map((i) => (
          <text key={i} className="vx-chart__tick" x={x(i)} y={HEIGHT - 6} textAnchor={i === n - 1 && n > 2 ? 'end' : i === 0 && n > 2 ? 'start' : 'middle'}>
            {shortDate(points[i].start, unit === 'week' && new Date(points[i].start).getMonth() === 0)}
          </text>
        ))}
        <motion.g
          initial={reduce ? { opacity: 0 } : { opacity: 0, scaleY: 0.6 }}
          animate={{ opacity: 1, scaleY: 1 }}
          transition={reduce ? { duration: 0.15 } : { type: 'spring', visualDuration: 0.6, bounce: 0 }}
          style={{ originY: 1 }}
        >
          <path d={area} fill={`url(#${gid}-fill)`} />
          <path d={line} className="vx-chart__line" style={{ stroke: 'var(--accent)' }} />
        </motion.g>
        {a && (
          <>
            <line className="vx-chart__cross" x1={Math.round(ax) + 0.5} x2={Math.round(ax) + 0.5} y1={M.t} y2={M.t + ph} style={{ opacity: 0.5 }} aria-hidden />
            <circle className="vx-chart__dot" cx={ax} cy={y(a.backlog)} r={4.5} style={{ fill: 'var(--accent)' }} aria-hidden />
          </>
        )}
        <rect className="vx-chart__hit" x={M.l} y={M.t} width={pw} height={ph} onPointerMove={onPointerMove} onPointerDown={onPointerMove} />
      </svg>
      {a && (
        <div className="vx-tip" style={ax + 200 > width ? { left: ax - 10, transform: 'translateX(-100%)' } : { left: ax + 10 }} aria-hidden>
          <strong className="num">{plural(a.backlog, 'game')} in backlog</strong>
          {pointLabel(a, unit)}
          <br />
          {a.playing} playing · {a.finished} finished
        </div>
      )}
      {focused && (
        <span className="visually-hidden" aria-live="polite">
          {readout}
        </span>
      )}
    </div>
  );
});
