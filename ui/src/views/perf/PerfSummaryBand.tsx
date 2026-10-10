/**
 * Track C2: the Performance page's top summary — your rig (graphics card and processor with their makers' marks, the
 * driver), how your recent sessions played, and the frame-rate trend. Every figure is measured; what isn't known says so.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Activity, AlertTriangle, Check, Cpu, Minus, MonitorCog, Settings2, TrendingDown, TrendingUp } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Game } from '../../bridge/types';
import type { Rig } from '../../bridge/types.trackC2';
import { Button } from '../../components/ui/primitives';
import { ServiceLogo } from '../../components/ui/ServiceLogo';
import { hardwareVendor } from '../../lib/serviceMarks';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { useElementWidth } from './hooks';
import { gameTitle, shortDate } from './text';
import { HEALTH_LABEL, fpsTrend, recentHealth, trendDelta, type HealthLevel, type PerfEntry } from './overview';

let rigCache: Rig | null = null;
let rigPromise: Promise<Rig | null> | null = null;

/** This PC's rig, asked once per app session (the backend re-reads it every 10 minutes anyway). */
export function useRig(): { rig: Rig | null; loading: boolean } {
  const [rig, setRig] = useState<Rig | null>(rigCache);
  const [loading, setLoading] = useState(!rigCache);
  useEffect(() => {
    if (rigCache) return;
    let alive = true;
    rigPromise ??= call<Rig>('performance.rig').then((r) => (rigCache = r && typeof r === 'object' ? r : null)).catch(() => {
      rigPromise = null;
      return null;
    });
    void rigPromise.then((r) => {
      if (!alive) return;
      setRig(r);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);
  return { rig, loading };
}

export const HEALTH_ICON: Record<HealthLevel, typeof Check> = { smooth: Check, uneven: Minus, rough: AlertTriangle, unmeasured: Activity };

export function HealthPip({ level, size = 12 }: { level: HealthLevel; size?: number }) {
  const Icon = HEALTH_ICON[level];
  return (
    <span className="pf-pip" data-level={level} aria-hidden>
      <Icon size={size} strokeWidth={2.4} />
    </span>
  );
}

export function PerfSummaryBand({ entries, gamesById, onOpen }: { entries: PerfEntry[]; gamesById: Map<string, Game>; onOpen: (id: string) => void }) {
  const reduce = useReducedMotion();
  const card = (i: number) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: reduce ? { duration: 0.15 } : { ...spring.panel, delay: 0.04 * i },
  });
  return (
    <div className="pf-band" role="region" aria-label="Summary">
      <motion.div className="pf-band__card surface" {...card(0)}>
        <RigCard />
      </motion.div>
      <motion.div className="pf-band__card surface" {...card(1)}>
        <HealthCard entries={entries} gamesById={gamesById} onOpen={onOpen} />
      </motion.div>
      <motion.div className="pf-band__card surface" {...card(2)}>
        <TrendCard entries={entries} />
      </motion.div>
    </div>
  );
}

/* ------------------------------------------------------------------ rig */

function Device({ kind, name, detail }: { kind: 'gpu' | 'cpu'; name: string | null; detail: string | null }) {
  const vendor = hardwareVendor(name);
  return (
    <div className="pf-rig__row">
      <span className="pf-rig__mark" data-vendor={vendor ?? undefined}>
        {vendor ? <ServiceLogo service={vendor} size={20} decorative brand /> : kind === 'gpu' ? <MonitorCog size={18} aria-hidden /> : <Cpu size={18} aria-hidden />}
      </span>
      <span className="pf-rig__text">
        <span className="pf-rig__kind">{kind === 'gpu' ? 'Graphics' : 'Processor'}</span>
        <span className="pf-rig__name" title={name ?? undefined}>{name ?? (kind === 'gpu' ? 'Graphics card not reported' : 'Processor not reported')}</span>
        {detail && <span className="pf-rig__detail num">{detail}</span>}
      </span>
    </div>
  );
}

function RigCard() {
  const { rig, loading } = useRig();
  return (
    <section className="pf-rig" aria-labelledby="pf-rig-title">
      <h2 id="pf-rig-title" className="pf-band__title caps">Your rig</h2>
      {loading ? (
        <div className="pf-rig__loading" aria-hidden><span /><span /></div>
      ) : (
        <>
          <Device kind="gpu" name={rig?.gpuName ?? null} detail={rig?.driver ? `Driver ${rig.driver}` : null} />
          <Device
            kind="cpu"
            name={rig?.cpuName ?? null}
            detail={[rig?.threads ? `${rig.threads} threads` : null, rig?.memoryGb ? `${Math.round(rig.memoryGb)} GB memory` : null].filter(Boolean).join(' · ') || null}
          />
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ recent health */

const COUNT_LABEL: Record<HealthLevel, string> = { smooth: 'smooth', uneven: 'with hitches', rough: 'rough', unmeasured: 'not measured' };

function HealthCard({ entries, gamesById, onOpen }: { entries: PerfEntry[]; gamesById: Map<string, Game>; onOpen: (id: string) => void }) {
  const r = useMemo(() => recentHealth(entries, 10), [entries]);
  const latest = r.latest;
  const parts = (['smooth', 'uneven', 'rough', 'unmeasured'] as const).filter((k) => r.counts[k] > 0);
  return (
    <section className="pf-health" aria-labelledby="pf-health-title">
      <h2 id="pf-health-title" className="pf-band__title caps">Recent sessions</h2>
      {latest && (
        <p className="pf-health__headline">
          <HealthPip level={latest.health.level} size={13} />
          <span>
            <strong>{latest.health.level === 'unmeasured' ? 'Last session' : `Last session: ${HEALTH_LABEL[latest.health.level].toLowerCase()}`}</strong>
            <span className="pf-health__why">
              {latest.health.level === 'unmeasured'
                ? ` — ${gameTitle(gamesById.get(latest.entry.gameId))}; frame rate wasn’t captured.`
                : latest.health.reasons[0]
                  ? ` — ${latest.health.reasons[0]}.`
                  : ` — ${gameTitle(gamesById.get(latest.entry.gameId))} held a steady frame rate.`}
            </span>
          </span>
        </p>
      )}
      <ol className="pf-health__pips" aria-label={`Last ${r.items.length} sessions, oldest first`}>
        {r.items.map(({ entry, health }) => {
          const label = `${gameTitle(gamesById.get(entry.gameId))}, ${shortDate(entry.startMs)}: ${HEALTH_LABEL[health.level]}`;
          return (
            <li key={entry.id}>
              <button type="button" className="pf-health__pip" data-level={health.level} aria-label={`${label}. Open session`} title={label} onClick={() => onOpen(entry.id)}>
                <HealthPip level={health.level} size={11} />
              </button>
            </li>
          );
        })}
      </ol>
      <p className="pf-health__counts">
        {parts.map((k, i) => (
          <span key={k}>
            {i > 0 && <span aria-hidden> · </span>}
            <span className="num">{r.counts[k]}</span> {COUNT_LABEL[k]}
          </span>
        ))}
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ frame-rate trend */

function TrendCard({ entries }: { entries: PerfEntry[] }) {
  const points = useMemo(() => fpsTrend(entries, 12), [entries]);
  const fpsOn = useStore((s) => s.settings?.['fps.captureEnabled'] ?? false);
  const navigate = useStore((s) => s.navigate);
  const last = points[points.length - 1];
  const dAvg = trendDelta(points, 'avg');
  const dLow = trendDelta(points, 'low');

  if (!last) {
    return (
      <section className="pf-trend" aria-labelledby="pf-trend-title">
        <h2 id="pf-trend-title" className="pf-band__title caps">Frame rate</h2>
        <p className="pf-trend__empty">
          {fpsOn ? 'Frame-rate capture is on — your next session will show its average and 1% lows here.' : 'Frame rate isn’t measured yet. With capture on, VYSTRAL shows each session’s average and 1% lows.'}
        </p>
        {!fpsOn && (
          <Button size="sm" variant="ghost" icon={<Settings2 size={14} />} onClick={() => navigate({ name: 'settings', section: 'launching' })}>
            Frame-rate capture
          </Button>
        )}
      </section>
    );
  }
  return (
    <section className="pf-trend" aria-labelledby="pf-trend-title">
      <h2 id="pf-trend-title" className="pf-band__title caps">Frame rate</h2>
      <div className="pf-trend__figures">
        <div>
          <span className="pf-trend__value">{Math.round(last.avg)}<small> fps</small></span>
          <span className="pf-trend__label"><span className="pf-key pf-key--avg" aria-hidden />Average <Delta pct={dAvg} /></span>
        </div>
        <div>
          <span className="pf-trend__value">{last.low == null ? '—' : Math.round(last.low)}<small> fps</small></span>
          <span className="pf-trend__label"><span className="pf-key pf-key--low" aria-hidden />1% low <Delta pct={dLow} /></span>
        </div>
      </div>
      <Sparkline points={points} />
      <p className="pf-trend__foot">Last {points.length === 1 ? 'session' : `${points.length} sessions`} with frame rate · latest on the right</p>
    </section>
  );
}

function Delta({ pct }: { pct: number | null }) {
  if (pct == null) return null;
  const same = Math.abs(pct) < 5;
  const Icon = same ? Minus : pct > 0 ? TrendingUp : TrendingDown;
  const text = same ? 'about usual' : `${pct > 0 ? '+' : '−'}${Math.round(Math.abs(pct))}% vs usual`;
  return (
    <span className="pf-delta-chip" data-dir={same ? 'same' : pct > 0 ? 'up' : 'down'}>
      <Icon size={11} aria-hidden />
      {text}
    </span>
  );
}

function Sparkline({ points }: { points: ReturnType<typeof fpsTrend> }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref, 260);
  const reduce = useReducedMotion();
  const h = 54;
  const pad = 6;
  const max = Math.max(...points.map((p) => p.avg), 30) * 1.08;
  const x = (i: number) => (points.length === 1 ? width / 2 : pad + (i / (points.length - 1)) * (width - pad * 2));
  const y = (v: number) => pad + (1 - v / max) * (h - pad * 2);
  const path = (key: 'avg' | 'low') => {
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const last = points[points.length - 1];
  const label = `Frame rate over the last ${points.length} sessions: average from ${Math.round(points[0].avg)} to ${Math.round(last.avg)} fps${last.low != null ? `, 1% lows ending at ${Math.round(last.low)} fps` : ''}.`;
  return (
    <div className="pf-spark" ref={ref}>
      <svg width={width} height={h} role="img" aria-label={label}>
        {(['low', 'avg'] as const).map((k) => (
          <motion.path
            key={k}
            className={`pf-spark__line pf-spark__line--${k}`}
            d={path(k)}
            initial={reduce ? false : { pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          />
        ))}
        <circle className="pf-spark__dot pf-spark__dot--avg" cx={x(points.length - 1)} cy={y(last.avg)} r={4} />
        {last.low != null && <circle className="pf-spark__dot pf-spark__dot--low" cx={x(points.length - 1)} cy={y(last.low)} r={4} />}
      </svg>
    </div>
  );
}
