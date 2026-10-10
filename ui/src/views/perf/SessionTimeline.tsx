/**
 * Track C2: the session picker — every measured session on a time line, its height by length and its colour and icon
 * by how it played. Pick one with the pointer (the nearest session wins) or the arrow keys.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import type { Game } from '../../bridge/types';
import { formatDuration } from '../../lib/format';
import { useReducedMotion } from '../../state/store';
import { useElementWidth } from './hooks';
import { gameTitle, shortDate } from './text';
import { HealthPip } from './PerfSummaryBand';
import { HEALTH_LABEL, healthOf, type HealthLevel, type PerfEntry } from './overview';

const H = 112;
const PAD = { l: 14, r: 14, t: 30, b: 22 };
const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

export function SessionTimeline({
  entries,
  selectedId,
  gamesById,
  onSelect,
}: {
  /** Newest first, already filtered. */
  entries: PerfEntry[];
  selectedId: string | null;
  gamesById: Map<string, Game>;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 900);
  const reduce = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  // Oldest first, with health worked out once.
  const items = useMemo(() => entries.slice().reverse().map((e) => ({ e, level: healthOf(e).level })), [entries]);
  const t0 = items[0]?.e.startMs ?? 0;
  const t1 = items[items.length - 1]?.e.startMs ?? 1;
  const span = Math.max(1, t1 - t0);
  const pw = Math.max(40, width - PAD.l - PAD.r);
  const x = (t: number) => PAD.l + (items.length === 1 ? pw / 2 : ((t - t0) / span) * pw);
  const base = H - PAD.b;
  const maxDur = Math.max(1, ...items.map((i) => i.e.session.durationSeconds || 0));
  const barH = (d: number) => 10 + Math.sqrt(Math.max(0, d) / maxDur) * (base - PAD.t - 10);
  const barW = Math.max(3, Math.min(8, (pw / Math.max(1, items.length)) * 0.7));
  const sel = items.findIndex((i) => i.e.id === selectedId);
  const counts = useMemo(() => {
    const c: Record<HealthLevel, number> = { smooth: 0, uneven: 0, rough: 0, unmeasured: 0 };
    for (const i of items) c[i.level]++;
    return c;
  }, [items]);

  const ticks = useMemo(() => {
    const n = Math.max(2, Math.min(7, Math.floor(pw / 120)));
    return items.length < 2 ? [t0] : Array.from({ length: n }, (_, i) => t0 + (span * i) / (n - 1));
  }, [items.length, pw, t0, span]);

  const nearestIndex = (px: number) => {
    let best = 0;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const d = Math.abs(x(it.e.startMs) - px);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = sel >= 0 ? sel : items.length - 1;
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = Math.min(items.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'PageUp') next = Math.max(0, cur - 10);
    else if (e.key === 'PageDown') next = Math.min(items.length - 1, cur + 10);
    if (next === undefined || !items[next]) return;
    e.preventDefault();
    onSelect(items[next].e.id);
  };

  if (!items.length) return null;
  const show = hover ?? (sel >= 0 ? sel : null);
  const shown = show != null ? items[show] : null;
  const labelX = shown ? Math.min(Math.max(x(shown.e.startMs), PAD.l + 90), PAD.l + pw - 90) : 0;
  const selected = sel >= 0 ? items[sel] : null;
  const summary = `${items.length} sessions from ${shortDate(t0, true)} to ${shortDate(t1, true)}: ${counts.smooth} smooth, ${counts.uneven} with hitches, ${counts.rough} rough, ${counts.unmeasured} without frame-rate data.`;
  const readout = selected ? `${gameTitle(gamesById.get(selected.e.gameId))}, ${fmtDateTime(selected.e.startMs)}, ${formatDuration(selected.e.session.durationSeconds)}: ${HEALTH_LABEL[selected.level]}. Session ${sel + 1} of ${items.length}.` : '';

  return (
    <section className="pf-timeline surface" aria-labelledby="pf-timeline-title">
      <div className="pf-timeline__head">
        <h2 id="pf-timeline-title" className="pf-band__title caps">Session timeline</h2>
        <ul className="pf-timeline__legend" aria-label="How each session played">
          {(['smooth', 'uneven', 'rough', 'unmeasured'] as const).filter((k) => counts[k] > 0).map((k) => (
            <li key={k}><HealthPip level={k} size={9} />{HEALTH_LABEL[k]} <span className="num pf-muted">{counts[k]}</span></li>
          ))}
          <li className="pf-muted">Height: session length</li>
        </ul>
      </div>
      <div
        ref={ref}
        className="vx-chart pf-timeline__chart"
        role="slider"
        tabIndex={0}
        aria-label="Pick a session"
        aria-valuemin={1}
        aria-valuemax={items.length}
        aria-valuenow={sel >= 0 ? sel + 1 : items.length}
        aria-valuetext={readout || undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        <svg width={width} height={H} role="img" aria-label={summary}>
          <line className="vx-chart__baseline" x1={PAD.l} x2={PAD.l + pw} y1={base + 0.5} y2={base + 0.5} />
          {ticks.map((t, i) => (
            <text key={i} className="vx-chart__tick" x={x(t)} y={H - 6} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}>
              {shortDate(t, ticks.length > 1 && new Date(t0).getFullYear() !== new Date(t1).getFullYear())}
            </text>
          ))}
          {items.map((it, i) => {
            const h = barH(it.e.session.durationSeconds);
            const bx = x(it.e.startMs) - barW / 2;
            return (
              <motion.rect
                key={it.e.id}
                className="pf-timeline__bar"
                data-level={it.level}
                data-selected={i === sel || undefined}
                data-hover={i === hover || undefined}
                x={bx}
                y={base - h}
                width={barW}
                height={h}
                rx={Math.min(3, barW / 2)}
                style={{ originY: 1 }}
                initial={reduce ? false : { scaleY: 0 }}
                animate={{ scaleY: 1 }}
                transition={reduce ? { duration: 0 } : { duration: 0.5, delay: Math.min(0.6, i * 0.006), ease: [0.16, 1, 0.3, 1] }}
              />
            );
          })}
          {selected && (
            <rect
              className="pf-timeline__ring"
              x={x(selected.e.startMs) - barW / 2 - 3}
              y={base - barH(selected.e.session.durationSeconds) - 3}
              width={barW + 6}
              height={barH(selected.e.session.durationSeconds) + 3}
              rx={Math.min(5, barW / 2 + 3)}
              aria-hidden
            />
          )}
          <rect
            className="vx-chart__hit"
            x={0}
            y={0}
            width={width}
            height={H}
            onPointerMove={(e) => setHover(nearestIndex(e.clientX - e.currentTarget.getBoundingClientRect().left))}
            onPointerLeave={() => setHover(null)}
            onClick={(e) => onSelect(items[nearestIndex(e.clientX - e.currentTarget.getBoundingClientRect().left)].e.id)}
          />
        </svg>
        {shown && (
          <div className="pf-timeline__label" style={{ left: labelX }} aria-hidden>
            <HealthPip level={shown.level} size={9} />
            <strong className="truncate">{gameTitle(gamesById.get(shown.e.gameId))}</strong>
            <span className="num">{shortDate(shown.e.startMs)} · {formatDuration(shown.e.session.durationSeconds)}</span>
          </div>
        )}
        {focused && <span className="visually-hidden" aria-live="polite">{readout}</span>}
      </div>
    </section>
  );
}
