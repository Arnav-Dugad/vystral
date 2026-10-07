import { useMemo, useRef, useState, type ReactNode } from 'react';
import { CircuitBoard, GitCompareArrows, Monitor, MonitorCog, SunMedium } from 'lucide-react';
import type { HardwareChange, HardwareHistory, HardwareSession, HardwareSpan } from '../../bridge/types';
import { Button, SectionHead, Skeleton } from '../../components/ui/primitives';
import { formatDuration, plural } from '../../lib/format';
import { useReducedMotion, useStore } from '../../state/store';
import { useElementWidth } from './hooks';
import { gameTitle, shortDate } from './text';
import { usePlayData } from './usePlayData';
import './play-data.css';

const LABEL_W = 78;
const PAD_R = 10;
const LANES = { pins: 12, driver: 34, display: 64, sessions: 98, axis: 124 };
const HEIGHT = 132;
const BAR_H = 20;
const fmtDate = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);

const KIND: Record<HardwareChange['kind'], { label: string; icon: ReactNode }> = {
  driver: { label: 'Graphics driver', icon: <MonitorCog size={14} /> },
  gpu: { label: 'Graphics card', icon: <CircuitBoard size={14} /> },
  display: { label: 'Display mode', icon: <Monitor size={14} /> },
  hdr: { label: 'HDR', icon: <SunMedium size={14} /> },
};

function displayText(s: HardwareSession): string | null {
  const res = s.width && s.height ? `${s.width} × ${s.height}` : null;
  const hz = s.refreshHz ? `${s.refreshHz} Hz` : null;
  const mode = [res, hz].filter(Boolean).join(' · ') || null;
  if (s.hdr == null) return mode;
  return [mode, s.hdr ? 'HDR on' : 'HDR off'].filter(Boolean).join(' · ');
}

/** Pin shapes by kind, so markers never rely on colour: circle, square, diamond, triangle. */
function Pin({ kind, x, y }: { kind: HardwareChange['kind']; x: number; y: number }) {
  const r = 4.5;
  switch (kind) {
    case 'driver': return <circle className="hw-pin" cx={x} cy={y} r={r} />;
    case 'display': return <rect className="hw-pin" x={x - r} y={y - r} width={r * 2} height={r * 2} rx={1.5} />;
    case 'hdr': return <path className="hw-pin" d={`M${x},${y - r - 1}L${x + r + 1},${y}L${x},${y + r + 1}L${x - r - 1},${y}Z`} />;
    default: return <path className="hw-pin" d={`M${x},${y - r - 1}L${x + r + 1},${y + r}L${x - r - 1},${y + r}Z`} />;
  }
}

/**
 * Track Y: the hardware each session started on, as a timeline — the graphics driver and the main
 * display's mode (resolution, refresh rate, HDR) as lanes of stretches, every session as a dot, and a
 * marker wherever something changed. Driver changes link to the frame-rate before/after comparison.
 */
export function HardwareTimeline({ gameId, hideWhenEmpty }: { gameId: string | null; hideWhenEmpty?: boolean }) {
  const { data, error, loading } = usePlayData<HardwareHistory>('insights.hardwareHistory', { gameId }, gameId ?? 'all');
  if (loading && !data) return hideWhenEmpty ? null : <Skeleton height={220} radius={22} />;
  if (!data) return hideWhenEmpty ? null : <section className="surface vx-card"><p className="pf-muted">Hardware history couldn’t be loaded: {error}</p></section>;
  const empty = data.withDriver === 0 && data.withDisplay === 0;
  if (empty && hideWhenEmpty) return null;
  const id = `hw-${gameId ?? 'all'}`;
  return (
    <section className="surface vx-card hw-card" aria-labelledby={id}>
      <SectionHead
        title={<span id={id}><MonitorCog size={16} aria-hidden className="di-title-icon" />Hardware history</span>}
        meta={empty ? undefined : `${plural(data.sessions.length, 'session')} · driver and display at each session start`}
      />
      {empty ? (
        <p className="pf-muted">
          With performance metrics on, VYSTRAL notes the graphics driver and your main display’s resolution, refresh rate and HDR at the start of each session
          (read-only). When one changes, it’s marked here and linked to the frame-rate comparison.
        </p>
      ) : (
        <TimelineBody data={data} gameId={gameId} />
      )}
    </section>
  );
}

function TimelineBody({ data, gameId }: { data: HardwareHistory; gameId: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 800);
  const reduce = useReducedMotion();
  const gamesById = useStore((s) => s.gamesById);
  const navigate = useStore((s) => s.navigate);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);

  const times = data.sessions.map((s) => Date.parse(s.start));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times.map((t, i) => t + data.sessions[i].durationSeconds * 1000), t0 + 86_400_000);
  const pw = Math.max(60, width - LABEL_W - PAD_R);
  const x = (t: number) => LABEL_W + ((t - t0) / (t1 - t0)) * pw;

  const ticks = useMemo(() => {
    const out: number[] = [];
    const span = t1 - t0;
    const d = new Date(t0);
    d.setHours(0, 0, 0, 0);
    if (span > 75 * 86_400_000) {
      d.setDate(1);
      const step = Math.max(1, Math.ceil(span / 30 / 86_400_000 / Math.max(2, Math.floor(pw / 90))));
      for (let m = new Date(d.getFullYear(), d.getMonth() + 1, 1); m.getTime() < t1; m = new Date(m.getFullYear(), m.getMonth() + step, 1)) out.push(m.getTime());
    } else {
      const step = Math.max(1, Math.ceil(span / 86_400_000 / Math.max(2, Math.floor(pw / 80))));
      for (let t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1); t.getTime() < t1; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + step)) out.push(t.getTime());
    }
    return out;
  }, [t0, t1, pw]);

  const span = (s: HardwareSpan, i: number, lane: 'driver' | 'display') => {
    const a = x(Date.parse(s.from));
    const end = data.sessions.find((r) => r.start === s.to);
    const b = Math.max(a + 8, x(Date.parse(s.to) + (end?.durationSeconds ?? 0) * 1000));
    const y = LANES[lane] - BAR_H / 2;
    const w = Math.max(8, b - a - 2);
    const fits = s.value.length * 6.4 + 14 < w;
    return (
      <g key={`${lane}-${s.from}`}>
        <rect className="hw-span" data-alt={i % 2 === 1 || undefined} x={a} y={y} width={w} height={BAR_H} rx={4}
          onPointerEnter={() => setTip({ x: a + w / 2, y, title: s.value, lines: [`${fmtDate(Date.parse(s.from))} – ${fmtDate(Date.parse(s.to))}`, plural(s.sessions, 'session')] })}
          onPointerLeave={() => setTip(null)} />
        {fits && <text className="hw-span__label" x={a + 8} y={LANES[lane]} dy="0.35em">{s.value}</text>}
      </g>
    );
  };

  const driverSpans = data.spans.filter((s) => s.lane === 'driver');
  const displaySpans = data.spans.filter((s) => s.lane === 'display');
  const summary = `Hardware history from ${fmtDate(t0)} to ${fmtDate(t1)}: ${plural(data.changes.length, 'change')}. ${data.changes.map((c) => `${KIND[c.kind].label} ${c.from} to ${c.to} on ${fmtDate(Date.parse(c.at))}`).join('. ')}`;

  const compare = () => {
    // The before/after card sits on the same page (game Sessions tab, Performance); else open Performance.
    const el = document.getElementById(`di-driver-${gameId ?? 'all'}`)?.closest('section') ?? document.querySelector<HTMLElement>('.di-card');
    if (el) {
      el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      el.classList.add('hw-flash');
      window.setTimeout(() => el.classList.remove('hw-flash'), 1400);
    } else navigate({ name: 'performance' });
  };

  return (
    <div className="hw" ref={ref}>
      <div className="vx-chart hw-chart">
        <svg width={width} height={HEIGHT} role="img" aria-label={summary}>
          <text className="hw-lane" x={0} y={LANES.driver} dy="0.35em">Driver</text>
          <text className="hw-lane" x={0} y={LANES.display} dy="0.35em">Display</text>
          <text className="hw-lane" x={0} y={LANES.sessions} dy="0.35em">Sessions</text>
          <line className="vx-chart__baseline" x1={LABEL_W} x2={LABEL_W + pw} y1={LANES.axis - 12.5} y2={LANES.axis - 12.5} />
          {ticks.map((t) => (
            <text key={t} className="vx-chart__tick" x={x(t)} y={LANES.axis + 4} textAnchor="middle">{shortDate(t)}</text>
          ))}
          {data.changes.map((c) => (
            <line key={`l-${c.kind}-${c.sessionId}`} className="hw-change" x1={Math.round(x(Date.parse(c.at))) + 0.5} x2={Math.round(x(Date.parse(c.at))) + 0.5} y1={LANES.pins + 6} y2={LANES.sessions + 8} />
          ))}
          {driverSpans.map((s, i) => span(s, i, 'driver'))}
          {displaySpans.map((s, i) => span(s, i, 'display'))}
          {data.sessions.map((s) => {
            const cx = x(Date.parse(s.start));
            return (
              <g key={s.sessionId}>
                <circle className="hw-dot" cx={cx} cy={LANES.sessions} r={4} />
                <circle
                  className="vx-chart__hit"
                  cx={cx}
                  cy={LANES.sessions}
                  r={11}
                  onPointerEnter={() => setTip({
                    x: cx, y: LANES.sessions - 10,
                    title: `${gameId ? '' : `${gameTitle(gamesById.get(s.gameId))} · `}${fmtDate(Date.parse(s.start))}`,
                    lines: [formatDuration(s.durationSeconds), s.driver ? `Driver ${s.driver}` : 'Driver not recorded', displayText(s) ?? 'Display not recorded'],
                  })}
                  onPointerLeave={() => setTip(null)}
                />
              </g>
            );
          })}
          {data.changes.map((c, i) => {
            // Changes that land within a pin's width of each other fan out side by side.
            const near = data.changes.map((o, j) => ({ j, d: Math.abs(x(Date.parse(o.at)) - x(Date.parse(c.at))) })).filter((o) => o.d < 12).map((o) => o.j);
            const cx = x(Date.parse(c.at)) + (near.indexOf(i) - (near.length - 1) / 2) * 13;
            return (
              <g key={`p-${c.kind}-${c.sessionId}`}>
                <Pin kind={c.kind} x={cx} y={LANES.pins} />
                <circle className="vx-chart__hit" cx={cx} cy={LANES.pins} r={11}
                  onPointerEnter={() => setTip({ x: cx, y: LANES.pins, title: `${KIND[c.kind].label} changed`, lines: [`${c.from} → ${c.to}`, fmtDate(Date.parse(c.at))] })}
                  onPointerLeave={() => setTip(null)} />
              </g>
            );
          })}
        </svg>
        {tip && (
          <div className="vx-tip hw-tip" style={tip.x + 200 > width ? { left: tip.x - 10, top: tip.y + 14, transform: 'translateX(-100%)' } : { left: tip.x + 10, top: tip.y + 14 }} aria-hidden>
            <strong>{tip.title}</strong>
            {tip.lines.map((l) => <span key={l} className="hw-tip__line">{l}</span>)}
          </div>
        )}
      </div>

      {data.changes.length > 0 ? (
        <ol className="hw-changes" aria-label="Changes">
          {[...data.changes].reverse().map((c) => (
            <li key={`${c.kind}-${c.sessionId}`} className="hw-change-row">
              <span className="hw-change-row__icon" data-kind={c.kind} aria-hidden>{KIND[c.kind].icon}</span>
              <span className="hw-change-row__text">
                <span className="hw-change-row__what">{KIND[c.kind].label}</span>{' '}
                {c.kind === 'hdr'
                  ? <>turned <span className="hw-change-row__to">{c.to === 'HDR on' ? 'on' : 'off'}</span></>
                  : <><span className="num">{c.from}</span> → <span className="num hw-change-row__to">{c.to}</span></>}
              </span>
              <time className="hw-change-row__date" dateTime={c.at}>{fmtDate(Date.parse(c.at))}</time>
              {c.kind === 'driver' && (
                <Button size="sm" variant="ghost" icon={<GitCompareArrows size={14} />} onClick={compare}>Frame rate before/after</Button>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="pf-muted">No changes yet: every recorded session ran on the same driver and display mode.</p>
      )}
      <p className="di-foot">
        Read-only, at the start of each session: the driver version (NVIDIA’s own numbering when available) and the main display’s current mode.
        {data.sessions.length - Math.max(data.withDriver, data.withDisplay) > 0 ? ` ${plural(data.sessions.length - Math.max(data.withDriver, data.withDisplay), 'older session')} didn’t record it.` : ''}
      </p>
    </div>
  );
}
