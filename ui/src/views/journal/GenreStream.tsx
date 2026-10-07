import { memo, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { Table2 } from 'lucide-react';
import { Button } from '../../components/ui/primitives';
import { formatDuration } from '../../lib/format';
import { useReducedMotion } from '../../state/store';
import { useElementWidth } from '../perf/hooks';
import { areaPath, insideOutOrder, OTHER, streamLayout, type GenreDrift } from './genreDrift';
import './play-insights.css';

const HEIGHT = 240;
const M = { l: 8, r: 8, t: 10, b: 26 };
const monthLabel = (ms: number, style: 'short' | 'long' = 'short', year = false) =>
  new Intl.DateTimeFormat(undefined, { month: style, year: year ? 'numeric' : undefined }).format(ms);
const hrs = (h: number) => formatDuration(h * 3600);

/** Colour slot per genre: legend order, "Other" always the neutral one. */
const slot = (genre: string, i: number) => (genre === OTHER ? 'other' : String(i + 1));

/**
 * Track Y: the genre mix of your tracked hours over the past 12 months as a stream graph (wiggle
 * baseline, inside-out order, monotone curves). Thickness at each month is that genre's hours. A legend
 * is always shown, wide ribbons carry direct labels, the crosshair readout lists every genre at the
 * month, and the same numbers are one click away as a table.
 */
export const GenreStream = memo(function GenreStream({ drift }: { drift: GenreDrift }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 800);
  const reduce = useReducedMotion();
  const tableId = useId();
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [table, setTable] = useState(false);
  const [hoverLayer, setHoverLayer] = useState<number | null>(null);

  const n = drift.months.length;
  const pw = Math.max(40, width - M.l - M.r);
  const ph = HEIGHT - M.t - M.b;
  // Named genres inside-out; "Other" always rides the bottom edge, where it reads as background.
  const layout = useMemo(() => {
    const other = drift.genres.indexOf(OTHER);
    const named = drift.hours.map((_, i) => i).filter((i) => i !== other);
    const inner = insideOutOrder(named.map((i) => drift.hours[i])).map((k) => named[k]);
    return streamLayout(drift.hours, other >= 0 ? [other, ...inner] : inner);
  }, [drift]);
  const span = Math.max(layout.max - layout.min, 0.5);
  const x = (j: number) => M.l + (n <= 1 ? pw / 2 : (j / (n - 1)) * pw);
  const y = (v: number) => M.t + ph / 2 - (v / span) * ph * 0.96;
  const xs = drift.months.map((_, j) => x(j));
  const labelEvery = pw / n < 46 ? 2 : 1;
  const spansYears = n > 0 && new Date(drift.months[0]).getFullYear() !== new Date(drift.months[n - 1]).getFullYear();

  // Direct labels: on a ribbon's widest month, only where the text clearly fits inside it.
  const labels = useMemo(() => layout.layers.flatMap((l) => {
    let best = -1;
    let at = 0;
    for (let j = 1; j < n - 1; j++) {
      const th = l.upper[j] - l.lower[j];
      if (th > best) { best = th; at = j; }
    }
    const px = (best / span) * ph * 0.96;
    const name = drift.genres[l.key];
    const textW = name.length * 6.8 + 10;
    if (px < 20 || textW > (pw / Math.max(1, n - 1)) * 2.2) return [];
    return [{ key: l.key, x: x(at), y: y((l.upper[at] + l.lower[at]) / 2), name }];
  }), [layout, n, span, ph, pw, drift.genres]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const summary = useMemo(() => {
    const first = drift.genres.map((g, i) => ({ g, v: drift.hours[i].slice(0, 3).reduce((a, b) => a + b, 0) })).sort((a, b) => b.v - a.v)[0];
    const last = drift.genres.map((g, i) => ({ g, v: drift.hours[i].slice(-3).reduce((a, b) => a + b, 0) })).sort((a, b) => b.v - a.v)[0];
    const totals = drift.genres.map((g, i) => `${g} ${hrs(drift.hours[i].reduce((a, b) => a + b, 0))}`).join(', ');
    return `Genre mix of tracked hours per month, ${monthLabel(drift.months[0], 'long', true)} to ${monthLabel(drift.months[n - 1], 'long', true)}. Totals: ${totals}.${first && last && first.g !== last.g ? ` Mostly ${first.g} at the start, mostly ${last.g} in the last three months.` : ''}`;
  }, [drift, n]);

  const a = active;
  const ax = a != null ? x(a) : 0;
  const readout = a != null
    ? `${monthLabel(drift.months[a], 'long', true)}: ${drift.monthTotals[a] > 0 ? drift.genres.map((g, i) => drift.hours[i][a] > 0.01 ? `${g} ${hrs(drift.hours[i][a])}` : null).filter(Boolean).join(', ') : 'no tracked play'}`
    : '';

  return (
    <div className="gs">
      <div
        ref={ref}
        className="vx-chart gs-chart"
        role="group"
        aria-roledescription="chart"
        tabIndex={0}
        aria-label={`${summary} Use the left and right arrow keys to read each month.`}
        onKeyDown={onKeyDown}
        onFocus={() => { setFocused(true); setActive((v) => v ?? n - 1); }}
        onBlur={() => { setFocused(false); setActive(null); }}
        onPointerLeave={() => { if (!focused) setActive(null); setHoverLayer(null); }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - r.left - M.l;
          setActive(Math.max(0, Math.min(n - 1, Math.round((px / pw) * (n - 1)))));
        }}
      >
        <svg width={width} height={HEIGHT} role="img" aria-label={summary}>
          <line className="vx-chart__baseline" x1={M.l} x2={M.l + pw} y1={HEIGHT - M.b + 0.5} y2={HEIGHT - M.b + 0.5} />
          {drift.months.map((m, j) => (j % labelEvery === (n - 1) % labelEvery) && (
            <text key={m} className="vx-chart__tick" x={x(j)} y={HEIGHT - 8} textAnchor={j === 0 ? 'start' : j === n - 1 ? 'end' : 'middle'}>
              {monthLabel(m)}{spansYears && new Date(m).getMonth() === 0 ? ` ${String(new Date(m).getFullYear()).slice(2)}` : ''}
            </text>
          ))}
          <motion.g
            initial={reduce ? { opacity: 0 } : { opacity: 0, scaleY: 0.2 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={reduce ? { duration: 0.15 } : { type: 'spring', visualDuration: 0.7, bounce: 0.05 }}
            style={{ originY: 0.5 }}
          >
            {layout.layers.map((l) => (
              <path
                key={l.key}
                className="gs-layer"
                data-slot={slot(drift.genres[l.key], l.key)}
                data-dim={(hoverLayer != null && hoverLayer !== l.key) || undefined}
                d={areaPath(xs, l.upper.map(y), l.lower.map(y))}
                onPointerEnter={() => setHoverLayer(l.key)}
              />
            ))}
            {labels.map((t) => (
              <text key={t.key} className="gs-label" data-slot={slot(drift.genres[t.key], t.key)} x={t.x} y={t.y} dy="0.35em" textAnchor="middle" aria-hidden>
                {t.name}
              </text>
            ))}
          </motion.g>
          {a != null && <line className="vx-chart__cross" x1={Math.round(ax) + 0.5} x2={Math.round(ax) + 0.5} y1={M.t} y2={HEIGHT - M.b} aria-hidden />}
        </svg>
        {a != null && (
          <div className="vx-tip gs-tip" style={ax + 220 > width ? { left: ax - 12, transform: 'translateX(-100%)' } : { left: ax + 12 }} aria-hidden>
            <strong className="num">{drift.monthTotals[a] > 0 ? hrs(drift.monthTotals[a]) : 'No play'}</strong>
            <span>{monthLabel(drift.months[a], 'long', true)}</span>
            {drift.monthTotals[a] > 0 && (
              <ul className="gs-tip__rows">
                {drift.genres.map((g, i) => ({ g, i, v: drift.hours[i][a] })).filter((r) => r.v > 0.01).sort((p, q) => q.v - p.v).map((r) => (
                  <li key={r.g}>
                    <span className="gs-key" data-slot={slot(r.g, r.i)} />
                    <span className="gs-tip__name">{r.g}</span>
                    <span className="num">{hrs(r.v)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {focused && <span className="visually-hidden" aria-live="polite">{readout}</span>}
      </div>

      <div className="gs-foot">
        <ul className="gs-legend" aria-label="Genres">
          {drift.genres.map((g, i) => (
            <li key={g} onPointerEnter={() => setHoverLayer(i)} onPointerLeave={() => setHoverLayer(null)}>
              <span className="gs-swatch" data-slot={slot(g, i)} aria-hidden />
              <span>{g}</span>
              <span className="num gs-legend__v">{hrs(drift.hours[i].reduce((p, q) => p + q, 0))}</span>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" icon={<Table2 size={14} />} aria-expanded={table} aria-controls={tableId} onClick={() => setTable((v) => !v)}>
          {table ? 'Hide table' : 'Show as table'}
        </Button>
      </div>

      <div id={tableId} hidden={!table} className="gs-table-wrap" tabIndex={table ? 0 : -1} role="region" aria-label="Genre hours per month">
        {table && (
          <table className="gs-table">
            <caption className="visually-hidden">Tracked hours per genre per month</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {drift.genres.map((g) => <th key={g} scope="col">{g}</th>)}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {drift.months.map((m, j) => (
                <tr key={m}>
                  <th scope="row">{monthLabel(m, 'short', true)}</th>
                  {drift.genres.map((g, i) => <td key={g} className="num">{drift.hours[i][j] > 0.01 ? hrs(drift.hours[i][j]) : '—'}</td>)}
                  <td className="num">{drift.monthTotals[j] > 0.01 ? hrs(drift.monthTotals[j]) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
});
