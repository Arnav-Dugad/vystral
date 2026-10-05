/**
 * Track B panels for the Performance view: the GPU thermal alert and the frame-rate section
 * (FPS chart, lows, frame-time histogram). Everything shown is measured; when something
 * wasn't, the panel says why instead of estimating.
 */
import { useMemo } from 'react';
import { motion } from 'motion/react';
import { Activity, Flame, Gauge, Settings2, Thermometer, Timer, TrendingDown, Zap } from 'lucide-react';
import type { InsightSample, PerfSummary } from '../../bridge/types';
import { Button, SectionHead } from '../../components/ui/primitives';
import { spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { StatTile } from './kit';
import { LineChart } from './LineChart';
import { downsampleSegments, formatOffset, niceTicks, seriesStats, splitSegments, type ChartMetric, type Pt } from './series';
import {
  formatFps, formatMs, formatSpan, fpsSeries, hasFps, hasThrottleData, histogramBuckets, thermalAlert, type Band,
} from './insight';
import './insight.css';

/* ------------------------------------------------------------------ thermal */

/**
 * Alert when the GPU was thermally throttled for 30 s or more; a quiet line otherwise when
 * throttling data exists. Nothing when the GPU doesn't report it (non-NVIDIA).
 */
export function ThermalPanel({ summary, samples }: { summary: PerfSummary; samples: InsightSample[] }) {
  const reduce = useReducedMotion();
  const alert = thermalAlert(summary);
  const throttled = summary.throttledSeconds;
  const power = summary.powerLimitedSeconds;

  if (alert) {
    return (
      <motion.section
        className="pf-thermal surface"
        role="note"
        aria-labelledby="pf-thermal-title"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={reduce ? { duration: 0.15 } : spring.panel}
      >
        <span className="pf-thermal__icon" aria-hidden><Flame size={18} /></span>
        <div className="pf-thermal__text">
          <span className="caps">GPU temperature</span>
          <h3 id="pf-thermal-title" className="pf-thermal__title">Thermal throttling for {formatSpan(throttled ?? 0)}</h3>
          <p>{alert}</p>
          <p className="pf-thermal__meta">
            {summary.peakTempC != null && <span><Thermometer size={13} aria-hidden /> Peak <span className="num">{Math.round(summary.peakTempC)} °C</span></span>}
            {power != null && power > 0 && <span><Zap size={13} aria-hidden /> Power-limited <span className="num">{formatSpan(power)}</span></span>}
            <span>Shaded on the charts below. VYSTRAL never changes fan, clock or power settings.</span>
          </p>
        </div>
      </motion.section>
    );
  }

  if (throttled == null && !hasThrottleData(samples)) return null;
  return (
    <p className="pf-thermal-line" role="note">
      <Thermometer size={14} aria-hidden />
      <span>
        {throttled ? <>The GPU throttled for heat for <span className="num">{formatSpan(throttled)}</span> — short enough not to matter.</> : <>No thermal throttling.</>}
        {power ? <> Power-limited for <span className="num">{formatSpan(power)}</span>, which is normal under heavy load.</> : null}
      </span>
    </p>
  );
}

/* ------------------------------------------------------------------ frame rate */

const FPS_METRIC: ChartMetric = { label: 'Frame rate', unit: 'fps', color: 'var(--ok)' };

export function FrameRatePanel({
  summary,
  samples,
  durationMs,
  hoverT,
  onHover,
  animateKey,
  bands,
}: {
  summary: PerfSummary;
  samples: InsightSample[];
  durationMs: number;
  hoverT: number | null;
  onHover: (t: number | null) => void;
  animateKey: string;
  bands: Band[];
}) {
  const series = useMemo(() => {
    const pts = fpsSeries(samples);
    const raw = pts.filter((p): p is Pt => p.v != null);
    const stats = seriesStats(raw.map((p) => p.v));
    return { raw, stats, segments: downsampleSegments(splitSegments(pts), 700), domain: stats ? niceTicks(0, Math.max(stats.max * 1.08, 30), 4) : null };
  }, [samples]);

  if (!hasFps(summary)) {
    return (
      <div className="pf-fps surface" role="note" aria-labelledby="pf-fps-title">
        <span className="pf-fps__icon" aria-hidden><Activity size={16} /></span>
        <div className="pf-fps__text">
          <span className="caps">Frame rate</span>
          <span id="pf-fps-title" className="pf-fps__value">FPS not measured</span>
        </div>
        <p className="pf-fps__body">{summary.fpsStatus} VYSTRAL shows no frame-rate figures rather than estimated ones.</p>
        <Button size="sm" variant="ghost" icon={<Settings2 size={14} />} onClick={() => useStore.getState().navigate({ name: 'settings', section: 'launching' })}>
          Frame-rate capture
        </Button>
      </div>
    );
  }

  return (
    <section className="surface vx-card pf-framerate" aria-labelledby="pf-framerate-title">
      <SectionHead
        title={<span id="pf-framerate-title">Frame rate</span>}
        meta={summary.fpsSource ? `Measured with ${summary.fpsSource}` : undefined}
      />
      <div className="vx-tiles pf-fps-tiles">
        <StatTile icon={<Activity size={13} />} label="Average" value={<span className="num">{formatFps(summary.fpsAvg)} <small>fps</small></span>} />
        <StatTile
          icon={<TrendingDown size={13} />}
          label="1% low"
          value={<span className="num">{formatFps(summary.fps1Low)} <small>fps</small></span>}
          sub={<span title="Average frame rate across the slowest 1% of frames">Slowest 1% of frames</span>}
        />
        <StatTile
          icon={<TrendingDown size={13} />}
          label="0.1% low"
          value={<span className="num">{formatFps(summary.fps01Low)} <small>fps</small></span>}
          sub="Slowest 0.1%"
        />
        <StatTile
          icon={<Timer size={13} />}
          label="Frame time"
          value={<span className="num">{formatMs(summary.frameTimeP50Ms)}</span>}
          sub={<>Median · p99 <span className="num">{formatMs(summary.frameTimeP99Ms)}</span></>}
        />
        <StatTile
          icon={<Gauge size={13} />}
          label="Stutters"
          value={<span className="num">{summary.stutterCount ?? '—'}</span>}
          sub="Frames over twice the recent average"
        />
      </div>

      {series.stats && series.domain ? (
        <div className="pf-chart">
          <div className="pf-chart__head">
            <span className="pf-chart__key" style={{ background: FPS_METRIC.color }} aria-hidden />
            <h3>Frames per second</h3>
            <span className="pf-chart__stats num">
              avg {formatFps(series.stats.avg)} · low {formatFps(series.stats.min)} · high {formatFps(series.stats.max)} (per 2 s)
            </span>
          </div>
          <LineChart
            metric={FPS_METRIC}
            segments={series.segments}
            raw={series.raw}
            durationMs={Math.max(durationMs, 1)}
            domain={series.domain}
            hoverT={hoverT}
            onHover={onHover}
            animateKey={animateKey}
            bands={bands}
            ariaLabel={`Frame rate over ${formatOffset(durationMs)}: average ${formatFps(series.stats.avg)} fps, lowest two-second average ${formatFps(series.stats.min)} fps.`}
          />
        </div>
      ) : (
        <p className="pf-muted">Only the session totals above were stored for this session.</p>
      )}

      <FrameTimeHistogram hist={summary.frameTimeHistogram ?? null} />
    </section>
  );
}

function FrameTimeHistogram({ hist }: { hist: number[] | null }) {
  const reduce = useReducedMotion();
  const buckets = useMemo(() => histogramBuckets(hist), [hist]);
  if (!buckets.length) return null;
  const max = Math.max(...buckets.map((b) => b.share));
  return (
    <figure className="pf-hist" aria-labelledby="pf-hist-title">
      <figcaption id="pf-hist-title" className="pf-hist__title">
        <h3>Frame-time distribution</h3>
        <span className="pf-muted">Share of all frames by frame time in milliseconds · shorter is smoother</span>
      </figcaption>
      <ol className="pf-hist__bars">
        {buckets.map((b, i) => (
          <li key={b.label} className="pf-hist__bar" title={`${b.label} ms (${b.fpsLabel}): ${(b.share * 100).toFixed(1)}% of frames`}>
            <span className="pf-hist__track" aria-hidden>
              <motion.span
                className="pf-hist__fill"
                data-slow={i >= 9 || undefined}
                initial={reduce ? false : { scaleY: 0 }}
                animate={{ scaleY: max > 0 ? Math.max(b.share / max, b.count > 0 ? 0.02 : 0) : 0 }}
                transition={reduce ? { duration: 0 } : { ...spring.panel, delay: i * 0.025 }}
              />
            </span>
            <span className="pf-hist__pct num">{b.share >= 0.001 ? `${(b.share * 100).toFixed(b.share < 0.1 ? 1 : 0)}%` : b.count > 0 ? '<0.1%' : '0%'}</span>
            <span className="pf-hist__label">{b.label}</span>
            <span className="visually-hidden"> ms, {b.fpsLabel}</span>
          </li>
        ))}
      </ol>
    </figure>
  );
}
