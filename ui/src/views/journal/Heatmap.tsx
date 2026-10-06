import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { CalendarDays, Flame, Info, Trophy, X } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { Button, Segmented } from '../../components/ui/primitives';
import { formatDuration, plural } from '../../lib/format';
import { useReducedMotion } from '../../state/store';
import { GameThumb } from '../perf/kit';
import { useElementWidth } from '../perf/hooks';
import { gameTitle } from '../perf/text';
import { startOfDay, type JSession } from './stats';
import {
  dayStats, layout, levelFor, moveDay, rangeBounds, rangeStreaks, thresholds, weekStartDay, yearsWithData, type HeatDay, type HeatRange, type Level,
} from './heatmapLayout';
import './heatmap.css';

const LABEL_W = 34;
const GAP = 3;
const fullDate = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(ms);
const monthShort = (m: number, y: number) => new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date(y, m, 1));
const weekdayName = (d: number, style: 'short' | 'long') => new Intl.DateTimeFormat(undefined, { weekday: style }).format(new Date(2024, 0, 7 + d));

function levelRange(level: Level, th: readonly [number, number, number]): string {
  const m = (v: number) => (v >= 60 ? formatDuration(v * 60) : `${v}m`);
  switch (level) {
    case 0: return 'No tracked play';
    case 1: return `Up to ${m(th[0])}`;
    case 2: return `${m(th[0])} – ${m(th[1])}`;
    case 3: return `${m(th[1])} – ${m(th[2])}`;
    default: return `More than ${m(th[2])}`;
  }
}

function cellLabel(day: number, info: HeatDay | undefined, gamesById: Map<string, Game>): string {
  if (!info || info.seconds <= 0) return `${fullDate(day)}: no tracked play`;
  const names = info.games.slice(0, 3).map((g) => gameTitle(gamesById.get(g.gameId)));
  const more = info.games.length - names.length;
  return `${fullDate(day)}: ${formatDuration(info.seconds)} played, ${plural(info.games.length, 'game')}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

interface TipAnchor {
  day: number;
  left: number;
  top: number;
  below: boolean;
  flip: boolean;
  start: boolean;
}

/** Positions the tooltip next to a cell, relative to the calendar's wrapper. */
function useAnchor(wrapRef: RefObject<HTMLDivElement | null>) {
  return useCallback(
    (el: HTMLElement, day: number): TipAnchor | null => {
      const wrap = wrapRef.current;
      if (!wrap) return null;
      const r = el.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      const left = r.left - w.left + r.width / 2;
      const below = r.top - w.top < 150;
      const flip = left > w.width - 150;
      return { day, left, top: below ? r.bottom - w.top + 8 : r.top - w.top - 8, below, flip, start: !flip && left < 140 };
    },
    [wrapRef],
  );
}

/**
 * GitHub-style year of play. Each cell is a day; colour intensity is tracked minutes (five levels).
 * Arrow keys move between days (roving tabindex), Enter/Space or a click filters the Journal timeline.
 */
export const Heatmap = memo(function Heatmap({
  sessions,
  now,
  gamesById,
  selectedDay,
  onSelectDay,
}: {
  sessions: readonly JSession[];
  now: number;
  gamesById: Map<string, Game>;
  selectedDay: number | null;
  onSelectDay: (day: number | null) => void;
}) {
  const reduce = useReducedMotion();
  const id = useId().replace(/:/g, '');
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef, 900);
  const days = useMemo(() => dayStats(sessions), [sessions]);
  const years = useMemo(() => yearsWithData(days.keys()).slice(0, 4), [days]);
  const [range, setRange] = useState<HeatRange>('past');
  const weekStart = useMemo(() => weekStartDay(), []);
  const grid = useMemo(() => layout(range, now, weekStart), [range, now, weekStart]);
  const { start, end } = useMemo(() => rangeBounds(range, now), [range, now]);
  const today = startOfDay(now);
  const lastFocusable = Math.min(end, today);

  const th = useMemo(() => {
    const mins: number[] = [];
    for (const [d, info] of days) if (d >= start && d <= end) mins.push(info.seconds / 60);
    return thresholds(mins);
  }, [days, start, end]);
  const streaks = useMemo(() => rangeStreaks(days, start, end, now), [days, start, end, now]);

  // Roving tabindex: one focusable day (the selected one, else the latest played, else the last day in range).
  const defaultFocus = useMemo(() => {
    if (selectedDay != null && selectedDay >= start && selectedDay <= lastFocusable) return selectedDay;
    let latest: number | null = null;
    for (const d of days.keys()) if (d >= start && d <= lastFocusable && (latest == null || d > latest)) latest = d;
    return latest ?? lastFocusable;
  }, [selectedDay, start, lastFocusable, days]);
  const [focusDay, setFocusDay] = useState<number | null>(null);
  const tabDay = focusDay != null && focusDay >= start && focusDay <= lastFocusable ? focusDay : defaultFocus;
  // The tooltip lives outside the scrolling grid so it is never clipped; it is placed from the cell's box.
  const [hoverTip, setHoverTip] = useState<TipAnchor | null>(null);
  const [focusTip, setFocusTip] = useState<TipAnchor | null>(null);
  const anchor = useAnchor(wrapRef);
  const tipAt = hoverTip ?? focusTip;

  const cell = Math.max(9, Math.min(24, Math.floor((width - LABEL_W - (grid.cols - 1) * GAP) / grid.cols)));
  const pitch = cell + GAP;
  const gridWidth = LABEL_W + grid.cols * pitch - GAP;

  const pending = useRef<number | null>(null);
  useEffect(() => {
    if (pending.current == null) return;
    gridRef.current?.querySelector<HTMLElement>(`[data-day="${pending.current}"]`)?.focus();
    pending.current = null;
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-day]');
    if (!target) return;
    const day = Number(target.dataset.day);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectDay(selectedDay === day ? null : day);
      return;
    }
    if (e.key === 'Escape' && selectedDay != null) {
      e.preventDefault();
      onSelectDay(null);
      return;
    }
    const next = moveDay(day, e.key, start, lastFocusable);
    if (next == null) return;
    e.preventDefault();
    e.stopPropagation();
    pending.current = next;
    setFocusDay(next);
  };

  const rangeOptions = useMemo(
    () => [{ value: 'past' as const, label: 'Past year' }, ...years.map((y) => ({ value: String(y), label: String(y) }))],
    [years],
  );
  const tipInfo = tipAt ? days.get(tipAt.day) : undefined;
  const rangeText = range === 'past' ? 'the past year' : String(range);

  return (
    <div className="hm" ref={wrapRef}>
      <div className="hm-head">
        <div className="hm-stats" aria-label={`Play calendar summary for ${rangeText}`}>
          <span className="hm-stat"><CalendarDays size={14} aria-hidden /><strong className="num">{streaks.daysPlayed.toLocaleString()}</strong> {streaks.daysPlayed === 1 ? 'day' : 'days'} played</span>
          <span className="hm-stat"><Trophy size={14} aria-hidden />Longest streak <strong className="num">{plural(streaks.longest, 'day')}</strong></span>
          {streaks.current != null && (
            <span className="hm-stat" data-hot={streaks.current >= 3 || undefined}>
              <Flame size={14} aria-hidden />Current streak <strong className="num">{plural(streaks.current, 'day')}</strong>
            </span>
          )}
          {streaks.seconds > 0 && <span className="hm-stat hm-stat--muted"><strong className="num">{formatDuration(streaks.seconds)}</strong> tracked</span>}
        </div>
        {rangeOptions.length > 1 && (
          <Segmented
            label="Calendar range"
            value={String(range)}
            options={rangeOptions}
            onChange={(v) => {
              setRange(v === 'past' ? 'past' : Number(v));
              setFocusDay(null);
              setHoverTip(null);
              setFocusTip(null);
            }}
          />
        )}
      </div>

      <div className="hm-scroll">
        <div
          ref={gridRef}
          key={String(range)}
          className="hm-grid"
          data-still={reduce || undefined}
          role="grid"
          aria-label={`Play calendar for ${rangeText}. Arrow keys move between days, Enter shows that day in the timeline.`}
          aria-describedby={`${id}-caption`}
          style={{ ['--cell' as string]: `${cell}px`, ['--gap' as string]: `${GAP}px`, ['--label' as string]: `${LABEL_W}px`, width: gridWidth } as CSSProperties}
          onKeyDown={onKeyDown}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusTip(null);
          }}
          onPointerLeave={() => setHoverTip(null)}
        >
          <div className="hm-months" aria-hidden>
            {grid.months.map((m) => (
              <span key={`${m.year}-${m.month}`} style={{ left: LABEL_W + m.col * pitch }}>
                {monthShort(m.month, m.year)}
                {m.month === 0 && range === 'past' ? ` ${String(m.year).slice(2)}` : ''}
              </span>
            ))}
          </div>
          {grid.rows.map((row, r) => (
            <div key={r} className="hm-row" role="row">
              <span className="hm-wd" role="rowheader">
                <span aria-hidden>{r % 2 === 0 ? weekdayName(grid.weekdays[r], 'short') : ''}</span>
                <span className="visually-hidden">{weekdayName(grid.weekdays[r], 'long')}</span>
              </span>
              {/* Pad columns before this weekday's first day so every row lines up. */}
              {row.length > 0 && row[0].col > 0 && <span className="hm-pad" style={{ width: row[0].col * pitch }} aria-hidden />}
              {row.map((c) => {
                if (!c.inRange) return <span key={c.day} className="hm-cell hm-cell--out" aria-hidden />;
                const info = days.get(c.day);
                const level = levelFor(info?.seconds ?? 0, th);
                if (c.future) return <span key={c.day} className="hm-cell hm-cell--future" aria-hidden style={{ ['--c' as string]: c.col } as CSSProperties} />;
                const selected = selectedDay === c.day;
                return (
                  <div
                    key={c.day}
                    role="gridcell"
                    className="hm-cell"
                    data-day={c.day}
                    data-level={level}
                    data-today={c.day === today || undefined}
                    aria-selected={selected}
                    aria-label={cellLabel(c.day, info, gamesById)}
                    tabIndex={c.day === tabDay ? 0 : -1}
                    style={{ ['--c' as string]: c.col } as CSSProperties}
                    onClick={() => {
                      setFocusDay(c.day);
                      onSelectDay(selected ? null : c.day);
                    }}
                    onFocus={(e) => {
                      setFocusDay(c.day);
                      setFocusTip(anchor(e.currentTarget, c.day));
                    }}
                    onPointerEnter={(e) => setHoverTip(anchor(e.currentTarget, c.day))}
                  />
                );
              })}
            </div>
          ))}

        </div>
      </div>

          {tipAt && (
            <div
              className="hm-tip"
              data-flip={tipAt.flip || undefined}
              data-start={tipAt.start || undefined}
              data-below={tipAt.below || undefined}
              style={{ left: tipAt.left, top: tipAt.top }}
              aria-hidden
            >
              <span className="hm-tip__date">{fullDate(tipAt.day)}</span>
              {tipInfo && tipInfo.seconds > 0 ? (
                <>
                  <strong className="hm-tip__time num">{formatDuration(tipInfo.seconds)}</strong>
                  <span className="hm-tip__meta">{plural(tipInfo.sessions || 1, 'session')} · {plural(tipInfo.games.length, 'game')}</span>
                  <span className="hm-tip__games">
                    {tipInfo.games.slice(0, 4).map((g) => (
                      <span key={g.gameId} className="hm-tip__game">
                        <GameThumb game={gamesById.get(g.gameId)} size={18} />
                        <span className="truncate">{gameTitle(gamesById.get(g.gameId))}</span>
                        <span className="num hm-tip__gt">{formatDuration(g.seconds)}</span>
                      </span>
                    ))}
                    {tipInfo.games.length > 4 && <span className="hm-tip__more">+{tipInfo.games.length - 4} more</span>}
                  </span>
                </>
              ) : (
                <span className="hm-tip__meta">No tracked play</span>
              )}
            </div>
          )}

      <div className="hm-foot">
        <p id={`${id}-caption`} className="hm-caption">
          <Info size={13} aria-hidden />
          <span>Only sessions VYSTRAL recorded (launched or detected) have dates, so only they appear here. Playtime reported by Steam and other stores has no day-by-day history.</span>
        </p>
        <div className="hm-legend" aria-label="Colour scale">
          <span>Less</span>
          {([0, 1, 2, 3, 4] as Level[]).map((l) => (
            <span key={l} className="hm-cell hm-legend__cell" data-level={l} title={levelRange(l, th)} role="img" aria-label={`${levelRange(l, th)}`} />
          ))}
          <span>More</span>
        </div>
      </div>

      {selectedDay != null && (
        <div className="hm-selected" role="status">
          <span>
            Timeline filtered to <strong>{fullDate(selectedDay)}</strong>
          </span>
          <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => onSelectDay(null)}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
});
