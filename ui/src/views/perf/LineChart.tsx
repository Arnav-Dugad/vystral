import './kit.css';
import './viz-tokens.css';
import { memo, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { motion } from 'motion/react';
import { useReducedMotion } from '../../state/store';
import { formatMetric, formatOffset, nearest, timeTicks, type ChartMetric, type Pt } from './series';
import type { Band } from './insight';
import { useElementWidth } from './hooks';

const M = { l: 46, r: 14, t: 12, b: 24 };

/**
 * Single-series time chart with a crosshair that can be shared between charts (hoverT is
 * controlled by the parent). Pointer and keyboard (←/→, Shift for bigger steps, Home/End,
 * Esc) both move the crosshair; the readout is announced only for the focused chart.
 */
export const LineChart = memo(function LineChart({
  metric,
  segments,
  raw,
  durationMs,
  domain,
  hoverT,
  onHover,
  height = 150,
  ariaLabel,
  animateKey,
  bands,
  markers,
}: {
  metric: ChartMetric;
  segments: Pt[][];
  raw: Pt[];
  durationMs: number;
  domain: { min: number; max: number; ticks: number[] };
  hoverT: number | null;
  onHover: (t: number | null) => void;
  height?: number;
  ariaLabel: string;
  animateKey: string;
  /** Shaded time ranges, e.g. when the GPU was thermally throttled. Purely decorative: the text says the same. */
  bands?: Band[];
  /** Track C2: moments marked on the baseline (stutters). Shape plus the chart's own text, never colour alone. */
  markers?: { t: number; label: string }[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const reduce = useReducedMotion();
  const gid = useId().replace(/:/g, '');
  const [focused, setFocused] = useState(false);

  const pw = Math.max(10, width - M.l - M.r);
  const ph = Math.max(10, height - M.t - M.b);
  const span = Math.max(1, durationMs);
  const x = (t: number) => M.l + (Math.min(span, Math.max(0, t)) / span) * pw;
  const y = (v: number) => M.t + (1 - (v - domain.min) / (domain.max - domain.min || 1)) * ph;
  const base = M.t + ph;

  const { line, area, dots } = useMemo(() => {
    let line = '';
    let area = '';
    const dots: Pt[] = [];
    for (const seg of segments) {
      if (seg.length === 1) {
        dots.push(seg[0]);
        continue;
      }
      const pts = seg.map((p) => `${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`);
      line += `M${pts.join('L')}`;
      area += `M${x(seg[0].t).toFixed(1)},${base}L${pts.join('L')}L${x(seg[seg.length - 1].t).toFixed(1)},${base}Z`;
    }
    return { line, area, dots };
    // x/y are derived from the values listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, pw, ph, span, domain.min, domain.max]);

  const xTicks = useMemo(() => timeTicks(span, Math.max(2, Math.floor(pw / 110))), [span, pw]);

  const gapTolerance = useMemo(() => {
    const step = raw.length > 1 ? (raw[raw.length - 1].t - raw[0].t) / (raw.length - 1) : span;
    return Math.max(step * 3, 5000);
  }, [raw, span]);
  const hovered = hoverT != null ? nearest(raw, hoverT) : null;
  const hasValue = hovered != null && hoverT != null && Math.abs(hovered.t - hoverT) <= gapTolerance;
  const marker = hoverT != null && markers?.length ? nearest(markers, hasValue ? hovered!.t : hoverT) : null;
  const nearMarker = marker != null && hoverT != null && Math.abs(marker.t - (hasValue ? hovered!.t : hoverT)) <= Math.max(2500, span / 200) ? marker : null;
  const readout = (hoverT == null ? '' : hasValue ? `${formatMetric(hovered!.v, metric.unit)} at ${formatOffset(hovered!.t)}` : `No data at ${formatOffset(hoverT)}`) + (nearMarker ? `. ${nearMarker.label}` : '');

  const fromPointer = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - rect.left) / rect.width;
    onHover(Math.min(1, Math.max(0, f)) * span);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = span / (e.shiftKey ? 10 : 100);
    const cur = hoverT ?? 0;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(span, cur + step);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - step);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = span;
    else if (e.key === 'Escape' && hoverT != null) next = null;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onHover(next);
  };

  const cx = hoverT != null ? x(hasValue ? hovered!.t : hoverT) : 0;
  const tipLeft = Math.min(Math.max(cx + 12, M.l), width - 150);
  const flip = cx + 160 > width;

  const fmtTick = (v: number) => (metric.unit === 'GB' ? (Number.isInteger(v) ? `${v}` : v.toFixed(1)) : `${Math.round(v)}`);

  return (
    <div
      ref={ref}
      className="vx-chart"
      role="group"
      aria-roledescription="chart"
      tabIndex={0}
      aria-label={`${metric.label} chart. Use the left and right arrow keys to inspect values.`}
      onKeyDown={onKeyDown}
      onFocus={() => {
        setFocused(true);
        if (hoverT == null) onHover(0);
      }}
      onBlur={() => {
        setFocused(false);
        onHover(null);
      }}
    >
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: metric.color, stopOpacity: 0.14 }} />
            <stop offset="100%" style={{ stopColor: metric.color, stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        {bands?.map((b) => (
          <rect key={`b-${b.start}`} className="vx-chart__band" x={x(b.start)} y={M.t} width={Math.max(1.5, x(b.end) - x(b.start))} height={ph} aria-hidden />
        ))}
        {domain.ticks.map((v) => (
          <g key={v}>
            <line className={v === domain.min ? 'vx-chart__baseline' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 8} y={y(v)} dy="0.35em" textAnchor="end">
              {fmtTick(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={t} className="vx-chart__tick" x={x(t)} y={height - 6} textAnchor={i === 0 ? 'start' : t >= span - 1 ? 'end' : 'middle'}>
            {formatOffset(t)}
          </text>
        ))}
        <motion.path
          key={`a-${animateKey}`}
          d={area}
          fill={`url(#${gid}-fill)`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.6, delay: 0.25 }}
        />
        <motion.path
          key={`l-${animateKey}`}
          className="vx-chart__line"
          d={line}
          style={{ stroke: metric.color }}
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        />
        {dots.map((p) => (
          <circle key={p.t} cx={x(p.t)} cy={y(p.v)} r={2.5} style={{ fill: metric.color }} />
        ))}
        {markers?.map((m) => (
          <path key={`m-${m.t}`} className="vx-chart__marker" data-active={nearMarker?.t === m.t || undefined} d={`M${x(m.t).toFixed(1)},${base - 9}l4.5,8h-9z`} aria-hidden />
        ))}
        {hoverT != null && (
          <g aria-hidden>
            <line className="vx-chart__cross" x1={Math.round(cx) + 0.5} x2={Math.round(cx) + 0.5} y1={M.t} y2={base} />
            {hasValue && <circle className="vx-chart__dot" cx={cx} cy={y(hovered!.v)} r={4.5} style={{ fill: metric.color }} />}
          </g>
        )}
        <rect
          className="vx-chart__hit"
          x={M.l}
          y={M.t}
          width={pw}
          height={ph}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={() => !focused && onHover(null)}
        />
      </svg>
      {hoverT != null && (
        <div className="vx-tip" style={flip ? { left: Math.max(0, cx - 12), transform: 'translateX(-100%)' } : { left: tipLeft }} aria-hidden>
          <strong className="num">{hasValue ? formatMetric(hovered!.v, metric.unit) : 'No data'}</strong>
          <span className="vx-tip__key" style={{ background: metric.color }} />
          {metric.label} · <span className="num">{formatOffset(hasValue ? hovered!.t : hoverT)}</span>
          {nearMarker && <span className="vx-tip__note">▲ {nearMarker.label}</span>}
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
