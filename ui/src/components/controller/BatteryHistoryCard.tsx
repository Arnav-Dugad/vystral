import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { BatteryCharging, BatteryLow, BatteryMedium, Gamepad2, Trash2 } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { BatteryHistory, ControllerBattery } from '../../bridge/types';
import { Badge, SectionHead, Skeleton, Toggle } from '../ui/primitives';
import { HoldToConfirm } from './HoldToConfirm';
import { formatDuration } from '../../lib/format';
import { useReducedMotion, useStore } from '../../state/store';
import { useElementWidth } from '../../views/perf/hooks';
import { usePlayData } from '../../views/perf/usePlayData';
import '../../views/perf/play-data.css';

const HEIGHT = 128;
const M = { l: 34, r: 8, t: 10, b: 22 };
const GAP_MS = 25 * 60_000; // same as BatteryHistory.Gap: a longer silence means the pad was off
const LOW = 20;
const DAY = 86_400_000;
const when = (ms: number) => new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(ms);

export function drainText(p: ControllerBattery): string | null {
  if (p.charging) return 'Charging';
  if (p.minutesLeft == null || p.drainPerHour == null) return null;
  return `About ${formatDuration(p.minutesLeft * 60)} left at your usual rate (${Math.round(p.drainPerHour)}% an hour)`;
}

/** One pad's week: a 2px line with a faint wash, broken where the pad was off; charging marked below. */
function BatteryLine({ pad, days, reduce }: { pad: ControllerBattery; days: number; reduce: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 600);
  const gid = useId().replace(/:/g, '');
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const now = Date.now();
  const t0 = now - days * DAY;
  const pw = Math.max(40, width - M.l - M.r);
  const ph = HEIGHT - M.t - M.b;
  const x = (t: number) => M.l + ((t - t0) / (now - t0)) * pw;
  const y = (v: number) => M.t + (1 - v / 100) * ph;
  const pts = useMemo(() => pad.points.map((p) => ({ t: Date.parse(p.at), v: p.percent, c: p.charging })).filter((p) => Number.isFinite(p.t)), [pad.points]);

  const segments = useMemo(() => {
    const out: (typeof pts)[] = [];
    let cur: typeof pts = [];
    for (const p of pts) {
      if (cur.length && p.t - cur[cur.length - 1].t > GAP_MS) {
        out.push(cur);
        cur = [];
      }
      cur.push(p);
    }
    if (cur.length) out.push(cur);
    return out;
  }, [pts]);
  const charging = useMemo(() => {
    const out: { a: number; b: number }[] = [];
    for (let i = 0; i < pts.length; i++) {
      if (!pts[i].c) continue;
      const a = pts[i].t;
      let b = a;
      while (i + 1 < pts.length && pts[i + 1].c && pts[i + 1].t - b <= GAP_MS) b = pts[++i].t;
      out.push({ a, b: Math.max(b, a + 15 * 60_000) });
    }
    return out;
  }, [pts]);
  const ticks = useMemo(() => {
    const out: number[] = [];
    const d = new Date(t0);
    d.setHours(0, 0, 0, 0);
    for (let t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(); t < now; t = new Date(new Date(t).getFullYear(), new Date(t).getMonth(), new Date(t).getDate() + 1).getTime()) out.push(t);
    return out;
  }, [t0, now]);

  const summary = `${pad.name} battery over the past ${days} days: ${pts.length ? `from ${pts[0].v}% to ${pts[pts.length - 1].v}%, lowest ${Math.min(...pts.map((p) => p.v))}%` : 'no readings'}.${charging.length ? ` Charged ${charging.length} ${charging.length === 1 ? 'time' : 'times'}.` : ''}`;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pts.length) return;
    const cur = active ?? pts.length - 1;
    let next: number | null | undefined;
    if (e.key === 'ArrowRight') next = Math.min(pts.length - 1, cur + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = pts.length - 1;
    else if (e.key === 'Escape' && active != null) next = null;
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setActive(next);
  };
  const a = active != null ? pts[active] : null;
  const ax = a ? x(a.t) : 0;
  const path = (seg: typeof pts) => seg.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  return (
    <div
      ref={ref}
      className="vx-chart bt-chart"
      role="group"
      aria-roledescription="chart"
      tabIndex={0}
      aria-label={`${summary} Use the left and right arrow keys to read each reading.`}
      onKeyDown={onKeyDown}
      onFocus={() => { setFocused(true); setActive((v) => v ?? (pts.length ? pts.length - 1 : null)); }}
      onBlur={() => { setFocused(false); setActive(null); }}
      onPointerLeave={() => !focused && setActive(null)}
      onPointerMove={(e) => {
        if (!pts.length) return;
        const r = e.currentTarget.getBoundingClientRect();
        const t = t0 + ((e.clientX - r.left - M.l) / pw) * (now - t0);
        let best = 0;
        for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
        setActive(best);
      }}
    >
      <svg width={width} height={HEIGHT} role="img" aria-label={summary}>
        <defs>
          <linearGradient id={`${gid}-wash`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.16 }} />
            <stop offset="100%" style={{ stopColor: 'var(--accent)', stopOpacity: 0.02 }} />
          </linearGradient>
        </defs>
        {[0, LOW, 50, 100].map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'vx-chart__baseline' : v === LOW ? 'bt-low' : 'vx-chart__grid'} x1={M.l} x2={M.l + pw} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
            <text className="vx-chart__tick" x={M.l - 6} y={y(v)} dy="0.35em" textAnchor="end">{v === LOW ? 'Low' : `${v}%`}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={t} className="vx-chart__tick" x={x(t)} y={HEIGHT - 5} textAnchor="middle">{new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(t)}</text>
        ))}
        {charging.map((c) => (
          <rect key={c.a} className="bt-charging" x={x(c.a)} y={M.t + ph - 4} width={Math.max(3, x(c.b) - x(c.a))} height={4} rx={2} />
        ))}
        <motion.g initial={reduce ? { opacity: 0 } : { opacity: 0, clipPath: 'inset(0 100% 0 0)' }} animate={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }} transition={reduce ? { duration: 0.15 } : { duration: 0.9, ease: [0.16, 1, 0.3, 1] }}>
          {segments.map((seg) => (
            <g key={seg[0].t}>
              {seg.length > 1 && <path d={`${path(seg)}L${x(seg[seg.length - 1].t).toFixed(1)},${y(0)}L${x(seg[0].t).toFixed(1)},${y(0)}Z`} fill={`url(#${gid}-wash)`} />}
              {seg.length > 1 ? <path className="vx-chart__line bt-line" d={path(seg)} /> : <circle className="bt-line-dot" cx={x(seg[0].t)} cy={y(seg[0].v)} r={2.5} />}
            </g>
          ))}
        </motion.g>
        {a && (
          <>
            <line className="vx-chart__cross" x1={Math.round(ax) + 0.5} x2={Math.round(ax) + 0.5} y1={M.t} y2={M.t + ph} aria-hidden />
            <circle className="vx-chart__dot bt-dot" cx={ax} cy={y(a.v)} r={4.5} aria-hidden />
          </>
        )}
      </svg>
      {a && (
        <div className="vx-tip" style={ax + 170 > width ? { left: ax - 10, transform: 'translateX(-100%)' } : { left: ax + 10 }} aria-hidden>
          <strong className="num">{a.v}%</strong>
          {when(a.t)}{a.c ? ' · charging' : ''}
        </div>
      )}
      {focused && a && <span className="visually-hidden" aria-live="polite">{when(a.t)}: {a.v}%{a.c ? ', charging' : ''}</span>}
    </div>
  );
}

function PadRow({ pad, days, reduce }: { pad: ControllerBattery; days: number; reduce: boolean }) {
  const low = pad.latest != null && pad.latest <= LOW && !pad.charging;
  const Icon = pad.charging ? BatteryCharging : low ? BatteryLow : BatteryMedium;
  const drain = drainText(pad);
  return (
    <div className="bt-pad">
      <div className="bt-pad__head">
        <span className="bt-pad__icon" aria-hidden><Gamepad2 size={16} /></span>
        <span className="bt-pad__name truncate">{pad.name}</span>
        {pad.latest != null && (
          <span className="bt-pad__level" data-low={low || undefined}>
            <Icon size={15} aria-hidden /> <span className="num">{pad.latest}%</span>
            {low && <Badge tone="warn">Low</Badge>}
          </span>
        )}
      </div>
      {drain && <p className="bt-pad__drain">{drain}</p>}
      <BatteryLine pad={pad} days={days} reduce={reduce} />
    </div>
  );
}

/**
 * Track Y: controller battery over the past week, one small chart per pad. `settings` adds the on/off
 * switch, empty states and Clear history; `performance` renders nothing until there are readings.
 */
export function BatteryHistoryCard({ variant }: { variant: 'settings' | 'performance' }) {
  const enabledSetting = useStore((s) => s.settings?.['controller.batteryHistory'] ?? true);
  const set = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const reduce = useReducedMotion();
  const { data, loading, error, set: setData } = usePlayData<BatteryHistory>('controller.batteryHistory', { days: 7 }, `battery|${enabledSetting}`);
  const [clearing, setClearing] = useState(false);

  const clear = async () => {
    setClearing(true);
    try {
      setData(await call<BatteryHistory>('controller.clearBatteryHistory'));
      toast({ tone: 'success', title: 'Battery history cleared', body: 'New readings start with the next connected controller.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Battery history wasn’t cleared', body: errorMessage(err) });
    } finally {
      setClearing(false);
    }
  };

  const pads = data?.pads ?? [];
  if (variant === 'performance') {
    if (!pads.length) return null;
    return (
      <section className="surface vx-card bt-card" aria-labelledby="bt-perf-title">
        <SectionHead title={<span id="bt-perf-title"><Gamepad2 size={16} aria-hidden className="di-title-icon" />Controller battery</span>} meta={`Past ${data?.days ?? 7} days`} />
        <div className="bt-pads">{pads.map((p) => <PadRow key={p.pad} pad={p} days={data?.days ?? 7} reduce={reduce} />)}</div>
      </section>
    );
  }

  return (
    <section className="sgroup">
      <h2 className="sgroup__title">Controller battery</h2>
      <p className="sgroup__desc">
        VYSTRAL notes each wireless controller’s battery about every 10 minutes while it’s connected, and whenever it changes by 5% or starts or stops charging.
        It stays on this PC, is kept for 90 days, and lets the pre-flight card warn you before a long session.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="controller.batteryHistory">Keep battery history</label>
            <div className="srow__hint">Read-only, from Windows. Turning it off keeps what’s already saved until you clear it.</div>
          </div>
          <div className="srow__control">
            <Toggle id="controller.batteryHistory" label="Keep battery history" checked={enabledSetting} onChange={(v) => void set('controller.batteryHistory', v)} />
          </div>
        </div>
        <div className="bt-settings">
          {loading && !data ? (
            <Skeleton height={150} radius={14} />
          ) : !data ? (
            <p className="pf-muted">Battery history couldn’t be loaded: {error}</p>
          ) : pads.length ? (
            <div className="bt-pads">{pads.map((p) => <PadRow key={p.pad} pad={p} days={data.days} reduce={reduce} />)}</div>
          ) : (
            <p className="pf-muted bt-empty">
              <Gamepad2 size={16} aria-hidden />
              {enabledSetting
                ? 'No readings yet. Connect a wireless controller and its battery appears here within a few minutes. Wired controllers don’t report a battery.'
                : 'Battery history is off.'}
            </p>
          )}
        </div>
        {pads.length > 0 && (
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Clear battery history</span>
              <div className="srow__hint">Deletes every saved reading. Your sessions aren’t affected.</div>
            </div>
            <div className="srow__control">
              <HoldToConfirm icon={<Trash2 size={16} />} onConfirm={() => void clear()} loading={clearing}>Clear</HoldToConfirm>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
