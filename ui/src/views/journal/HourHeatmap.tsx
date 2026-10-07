import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Clock, Info } from 'lucide-react';
import { formatDuration, plural } from '../../lib/format';
import { useReducedMotion } from '../../state/store';
import { useElementWidth } from '../perf/hooks';
import { cellIndex, dayPart, DAYS, hourOfWeek, HOURS, moveCell, primeTime, weekdayOrder, type PrimeTime } from './hourOfWeek';
import { levelFor, thresholds, weekStartDay, type Level } from './heatmapLayout';
import type { JSession } from './stats';
import './heatmap.css';
import './play-insights.css';

const LABEL_W = 40;
const GAP = 3;
const weekdayName = (d: number, style: 'short' | 'long') => new Intl.DateTimeFormat(undefined, { weekday: style }).format(new Date(2024, 0, 7 + d));
const hourLabel = (h: number) => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(2024, 0, 7, h));
const PART_WORD: Record<ReturnType<typeof dayPart>, string> = { morning: 'mornings', afternoon: 'afternoons', evening: 'evenings', night: 'nights' };

/** "8 pm – 11 pm" in the user's clock style. */
export function hourSpan(start: number, hours: number): string {
  return `${hourLabel(start % 24)} – ${hourLabel((start + hours) % 24)}`;
}

function primeHeadline(p: PrimeTime): string {
  return `${weekdayName(p.weekday, 'long')} ${PART_WORD[dayPart(p.startHour, p.hours)]}, ${hourSpan(p.startHour, p.hours)}`;
}

function levelText(level: Level, th: readonly [number, number, number]): string {
  const m = (v: number) => (v >= 60 ? formatDuration(v * 60) : `${v}m`);
  switch (level) {
    case 0: return 'No tracked play';
    case 1: return `Up to ${m(th[0])}`;
    case 2: return `${m(th[0])} – ${m(th[1])}`;
    case 3: return `${m(th[1])} – ${m(th[2])}`;
    default: return `More than ${m(th[2])}`;
  }
}

/**
 * Track Y: when you play, as a 7 × 24 grid of local hours (rows follow the locale's week). Sessions are
 * split at every hour boundary. The same five-step accent ramp as the play calendar; every cell has a
 * spoken label and the tooltip shows the same on focus. Arrow keys move between hours and days.
 */
export const HourHeatmap = memo(function HourHeatmap({ sessions, rangeText, weeks }: { sessions: readonly JSession[]; rangeText: string; weeks: number | null }) {
  const reduce = useReducedMotion();
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef, 900);
  const grid = useMemo(() => hourOfWeek(sessions), [sessions]);
  const prime = useMemo(() => primeTime(grid), [grid]);
  const rows = useMemo(() => weekdayOrder(weekStartDay()), []);
  const th = useMemo(() => thresholds(grid.seconds.map((s) => s / 60)), [grid]);
  const [focus, setFocus] = useState<{ row: number; col: number } | null>(null);
  const [tip, setTip] = useState<{ row: number; col: number; left: number; top: number; below: boolean } | null>(null);
  const pending = useRef(false);

  const cellW = Math.max(10, Math.min(46, Math.floor((width - LABEL_W - (HOURS - 1) * GAP) / HOURS)));
  const cell = Math.min(cellW, 30);
  const pitch = cellW + GAP;
  const gridWidth = LABEL_W + HOURS * pitch - GAP;
  const labelEvery = cellW >= 30 ? 2 : cellW >= 16 ? 3 : 6;
  const primeCells = useMemo(() => {
    const set = new Set<number>();
    if (prime) for (let k = 0; k < prime.hours; k++) set.add((cellIndex(prime.weekday, prime.startHour) + k) % (DAYS * HOURS));
    return set;
  }, [prime]);

  // Roving tabindex: the busiest cell, else Monday-ish 8 pm.
  const busiest = useMemo(() => {
    let best = -1;
    let at = { row: 0, col: 20 };
    rows.forEach((wd, r) => {
      for (let h = 0; h < HOURS; h++) if (grid.seconds[cellIndex(wd, h)] > best) {
        best = grid.seconds[cellIndex(wd, h)];
        at = { row: r, col: h };
      }
    });
    return at;
  }, [grid, rows]);
  const tab = focus ?? busiest;

  useEffect(() => {
    if (!pending.current || !focus) return;
    pending.current = false;
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${focus.row}-${focus.col}"]`)?.focus();
  });

  const place = (el: HTMLElement, row: number, col: number) => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    const r = el.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    const below = r.top - w.top < 120;
    return { row, col, left: r.left - w.left + r.width / 2, top: below ? r.bottom - w.top + 8 : r.top - w.top - 8, below };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
    if (!t) return;
    const [row, col] = t.dataset.cell!.split('-').map(Number);
    const next = moveCell(row, col, e.key);
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    pending.current = true;
    setFocus(next);
  };

  const label = (wd: number, h: number) => {
    const secs = grid.seconds[cellIndex(wd, h)];
    const n = grid.sessions[cellIndex(wd, h)];
    const when = `${weekdayName(wd, 'long')}, ${hourSpan(h, 1)}`;
    if (secs <= 0) return `${when}: no tracked play`;
    return `${when}: ${formatDuration(secs)} across ${plural(n, 'session')}${weeks ? `, about ${formatDuration(secs / weeks)} a week` : ''}`;
  };

  if (grid.total <= 0) return <p className="jr-muted">No tracked play in the {rangeText}.</p>;

  const tipWd = tip ? rows[tip.row] : 0;
  const tipSecs = tip ? grid.seconds[cellIndex(tipWd, tip.col)] : 0;

  return (
    <div className="hm how" ref={wrapRef}>
      <div className="how-prime" data-empty={!prime || undefined}>
        <span className="how-prime__icon" aria-hidden><Clock size={16} /></span>
        {prime ? (
          <div className="how-prime__text">
            <span className="caps">Your prime time</span>
            <strong className="how-prime__title">{primeHeadline(prime)}</strong>
            <span className="how-prime__sub">
              <span className="num">{Math.round(prime.share * 100)}%</span> of your play in the {rangeText}
              {weeks && weeks >= 2 ? <> · about <span className="num">{formatDuration(prime.seconds / weeks)}</span> a week in that window</> : null}
            </span>
          </div>
        ) : (
          <div className="how-prime__text">
            <span className="caps">Your prime time</span>
            <span className="how-prime__sub">A few more sessions in this range and VYSTRAL can tell when you usually play.</span>
          </div>
        )}
      </div>

      <div className="hm-scroll">
        <div
          ref={gridRef}
          className="how-grid"
          data-still={reduce || undefined}
          role="grid"
          aria-label={`Play time by hour of the week, ${rangeText}. Arrow keys move between hours and days.`}
          style={{ ['--cell' as string]: `${cell}px`, ['--cellw' as string]: `${cellW}px`, ['--gap' as string]: `${GAP}px`, ['--label' as string]: `${LABEL_W}px`, width: gridWidth } as CSSProperties}
          onKeyDown={onKeyDown}
          onPointerLeave={() => setTip(null)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTip(null);
          }}
        >
          <div className="how-hours" aria-hidden>
            {Array.from({ length: HOURS }, (_, h) => h % labelEvery === 0 && (
              <span key={h} style={{ left: LABEL_W + h * pitch }}>{hourLabel(h)}</span>
            ))}
          </div>
          {rows.map((wd, r) => (
            <div key={wd} className="hm-row" role="row">
              <span className="hm-wd" role="rowheader">
                <span aria-hidden>{weekdayName(wd, 'short')}</span>
                <span className="visually-hidden">{weekdayName(wd, 'long')}</span>
              </span>
              {Array.from({ length: HOURS }, (_, h) => {
                const i = cellIndex(wd, h);
                const level = levelFor(grid.seconds[i], th);
                const isTab = tab.row === r && tab.col === h;
                return (
                  <div
                    key={h}
                    role="gridcell"
                    className="hm-cell how-cell"
                    data-cell={`${r}-${h}`}
                    data-level={level}
                    data-prime={primeCells.has(i) || undefined}
                    aria-label={`${label(wd, h)}${primeCells.has(i) ? '. Part of your prime time' : ''}`}
                    tabIndex={isTab ? 0 : -1}
                    style={{ ['--c' as string]: h + r } as CSSProperties}
                    onFocus={(e) => {
                      setFocus({ row: r, col: h });
                      setTip(place(e.currentTarget, r, h));
                    }}
                    onPointerEnter={(e) => setTip(place(e.currentTarget, r, h))}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {tip && (
        <div className="hm-tip" data-below={tip.below || undefined} data-flip={tip.left > width - 150 || undefined} data-start={tip.left < 140 || undefined} style={{ left: tip.left, top: tip.top }} aria-hidden>
          <span className="hm-tip__date">{weekdayName(tipWd, 'long')} · {hourSpan(tip.col, 1)}</span>
          <strong className="hm-tip__time num">{tipSecs > 0 ? formatDuration(tipSecs) : 'No play'}</strong>
          {tipSecs > 0 && (
            <span className="hm-tip__meta">
              {plural(grid.sessions[cellIndex(tipWd, tip.col)], 'session')}
              {weeks && weeks >= 2 ? ` · ~${formatDuration(tipSecs / weeks)} a week` : ''}
            </span>
          )}
        </div>
      )}

      <div className="hm-foot">
        <p className="hm-caption">
          <Info size={13} aria-hidden />
          <span>Local time on this PC. A session that crosses an hour counts toward each hour it touches, so a 10:40 pm – 1:15 am session lands in four cells.</span>
        </p>
        <div className="hm-legend" aria-label="Colour scale">
          <span>Less</span>
          {([0, 1, 2, 3, 4] as Level[]).map((l) => (
            <span key={l} className="hm-cell hm-legend__cell" data-level={l} title={levelText(l, th)} role="img" aria-label={levelText(l, th)} />
          ))}
          <span>More</span>
        </div>
      </div>
    </div>
  );
});
