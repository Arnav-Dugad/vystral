import '../perf/kit.css';
import { memo, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { formatDuration, plural } from '../../lib/format';
import { useReducedMotion } from '../../state/store';
import { niceTicks } from '../perf/series';
import { useElementWidth } from '../perf/hooks';
import { shortDate } from '../perf/text';
import type { Bucket } from './stats';

const M = { l: 40, r: 6, t: 14, b: 26 };
const HEIGHT = 200;

const hoursLabel = (h: number) => (h === 0 ? '0' : h < 1 ? `${Math.round(h * 60)}m` : `${Number.isInteger(h) ? h : h.toFixed(1)}h`);

function bucketLabel(b: Bucket, unit: 'day' | 'week', withYear: boolean): string {
  if (unit === 'day') return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined }).format(b.start);
  return `Week of ${shortDate(b.start, true)}`;
}

/** Bar path with a rounded data-end and a square baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/**
 * Play time per day (or week) as columns. Each column's slot is its hover/focus target;
 * arrow keys move between columns when the chart has focus.
 */
export const DayChart = memo(function DayChart({ buckets, unit, ariaLabel, animateKey }: { buckets: Bucket[]; unit: 'day' | 'week'; ariaLabel: string; animateKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 800);
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  const n = Math.max(1, buckets.length);
  const pw = Math.max(10, width - M.l - M.r);
  const ph = HEIGHT - M.t - M.b;
  const slot = pw / n;
  const gap = slot >= 8 ? 2 : slot >= 3 ? 1 : 0;
  const barW = Math.max(0.6, Math.min(24, slot - gap));
  const maxHours = Math.max(...buckets.map((b) => b.seconds / 3600), 0);
  const domain = useMemo(() => niceTicks(0, Math.max(maxHours, 0.5), 4), [maxHours]);
  const y = (h: number) => M.t + (1 - h / (domain.max || 1)) * ph;
  const spansYears = buckets.length > 0 && new Date(buckets[0].start).getFullYear() !== new Date(buckets[buckets.length - 1].start).getFullYear();

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(pw / (unit === 'day' && n <= 7 ? 60 : 84)))));
  const xLabels = useMemo(() => {
    const out: { i: number; text: string }[] = [];
    for (let i = n - 1; i >= 0; i -= labelEvery) {
      const b = buckets[i];
      if (!b) continue;
      const text = n <= 7 ? new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(b.start) : shortDate(b.start, spansYears && new Date(b.start).getMonth() === 0);
      out.push({ i, text });
    }
    return out;
  }, [buckets, n, labelEvery, spansYears]);

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

  const a = active != null ? buckets[active] : null;
  const ax = active != null ? M.l + active * slot + slot / 2 : 0;
  const readout = a ? `${bucketLabel(a, unit, true)}: ${a.seconds > 0 ? formatDuration(a.seconds) : 'no play'}, ${plural(a.sessions, 'session')}` : '';

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
          <linearGradient id={`${gid}-bar`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)' }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent-2)', stopOpacity: 0.75 }} />
          </linearGradient>
        </defs>
        {domain.ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">
              {hoursLabel(v)}
            </text>
          </g>
        ))}
        {xLabels.map(({ i, text }) => (
          <text key={i} className="vx-chart__tick" x={M.l + i * slot + slot / 2} y={HEIGHT - 6} textAnchor={i === n - 1 && n > 7 ? 'end' : 'middle'}>
            {text}
          </text>
        ))}
        <motion.g
          key={animateKey}
          initial={reduce ? { opacity: 0 } : { scaleY: 0, opacity: 0 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={reduce ? { duration: 0.15 } : { type: 'spring', visualDuration: 0.5, bounce: 0.08 }}
          style={{ originY: 1 }}
        >
          {buckets.map((b, i) => {
            if (b.seconds <= 0) return null;
            const h = Math.max(1.5, (b.seconds / 3600 / (domain.max || 1)) * ph);
            const bx = M.l + i * slot + (slot - barW) / 2;
            return (
              <path
                key={b.start}
                d={barPath(bx, M.t + ph - h, barW, h)}
                fill={`url(#${gid}-bar)`}
                style={{ opacity: active == null || active === i ? 1 : 0.45, transition: 'opacity 140ms var(--ease-out)' }}
              />
            );
          })}
        </motion.g>
        {active != null && <line className="vx-chart__cross" x1={Math.round(ax) + 0.5} x2={Math.round(ax) + 0.5} y1={M.t} y2={M.t + ph} style={{ opacity: 0.5 }} aria-hidden />}
        {buckets.map((b, i) => (
          <rect key={b.start} className="vx-chart__hit" x={M.l + i * slot} y={M.t} width={slot} height={ph} style={{ cursor: 'default' }} onPointerEnter={() => setActive(i)} />
        ))}
      </svg>
      {a && (
        <div className="vx-tip" style={ax + 180 > width ? { left: ax - 10, transform: 'translateX(-100%)' } : { left: ax + 10 }} aria-hidden>
          <strong className="num">{a.seconds > 0 ? formatDuration(a.seconds) : 'No play'}</strong>
          {bucketLabel(a, unit, spansYears)}
          {a.sessions > 0 && <> · {plural(a.sessions, 'session')}</>}
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
