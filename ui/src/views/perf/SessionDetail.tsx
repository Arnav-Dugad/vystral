/**
 * One session in depth (the Performance page's Sessions tab): the hero with Replay, headline tiles, the thermal note,
 * frame rate with its frame-time histogram and stutter markers, and CPU / GPU / temperature / memory over the session
 * on one shared crosshair. Moved here from Performance.tsx by Track C2.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Clapperboard, Cpu, Gamepad2, MemoryStick, MonitorCog, Thermometer } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game, PerfSample } from '../../bridge/types';
import { Badge, Button, SectionHead, Skeleton } from '../../components/ui/primitives';
import { GameCover } from '../../components/game/GameCover';
import { SessionOriginChip } from '../../components/game/SessionOriginChip';
import { formatDuration, plural } from '../../lib/format';
import { useStore } from '../../state/store';
import { openReplay } from '../../state/recap';
import { StatTile } from './kit';
import { gameTitle } from './text';
import { LineChart } from './LineChart';
import { FrameRatePanel, ThermalPanel } from './InsightPanels';
import { useInsightSamples, useThrottleBands } from './insightData';
import { SessionEnergyTile } from './EnergyCard';
import { HealthPip } from './PerfSummaryBand';
import { HEALTH_LABEL, healthOf, stutterMarks, type PerfEntry } from './overview';
import { METRICS, domainFor, downsampleSegments, extractSeries, formatMetric, seriesStats, splitSegments, summaryValue, type MetricKey, type Pt } from './series';

const ICONS: Record<MetricKey, ReactNode> = {
  cpu: <Cpu size={13} />,
  gpu: <MonitorCog size={13} />,
  gpuTempC: <Thermometer size={13} />,
  gpuMemMb: <MemoryStick size={13} />,
  ramMb: <MemoryStick size={13} />,
};

const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);

const sampleCache = new Map<string, PerfSample[]>();

function useSamples(id: string | null): { status: 'idle' | 'loading' | 'ready' | 'error'; samples: PerfSample[]; error: string | null } {
  const [loaded, setLoaded] = useState<{ id: string; samples: PerfSample[]; error: string | null } | null>(null);
  const cached = id ? sampleCache.get(id) : undefined;
  useEffect(() => {
    if (!id || sampleCache.has(id)) return;
    let alive = true;
    call<PerfSample[]>('sessions.samples', { sessionId: id })
      .then((list) => {
        const samples = Array.isArray(list) ? list : [];
        if (sampleCache.size > 24) sampleCache.delete(sampleCache.keys().next().value as string);
        sampleCache.set(id, samples);
        if (alive) setLoaded({ id, samples, error: null });
      })
      .catch((err) => {
        if (alive) setLoaded({ id, samples: [], error: errorMessage(err) });
      });
    return () => {
      alive = false;
    };
  }, [id]);
  if (!id) return { status: 'idle', samples: [], error: null };
  if (cached) return { status: 'ready', samples: cached, error: null };
  if (loaded?.id === id) return loaded.error ? { status: 'error', samples: [], error: loaded.error } : { status: 'ready', samples: loaded.samples, error: null };
  return { status: 'loading', samples: [], error: null };
}

export function SessionDetail({ entry, game }: { entry: PerfEntry; game: Game | undefined }) {
  const samples = useSamples(entry.id);
  const insight = useInsightSamples(entry.id);
  const bands = useThrottleBands(insight.samples);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const { summary, session } = entry;
  const health = useMemo(() => healthOf(entry), [entry]);
  const markers = useMemo(() => stutterMarks(insight.samples).map((m) => ({ t: m.t, label: `Sharp drop to ${Math.round(m.fps)} fps` })), [insight.samples]);

  const series = useMemo(
    () =>
      METRICS.map((m) => {
        const pts = extractSeries(samples.samples, m.key, m.scale);
        const raw = pts.filter((p): p is Pt => p.v != null);
        const stats = seriesStats(raw.map((p) => p.v));
        return {
          m,
          raw,
          stats,
          segments: downsampleSegments(splitSegments(pts), 700),
          domain: stats ? domainFor(m.kind, stats.min, stats.max) : null,
        };
      }),
    [samples.samples],
  );
  const durationMs = useMemo(() => samples.samples.reduce((mx, s) => Math.max(mx, s.t), 0), [samples.samples]);
  const interval = useMemo(() => {
    const s = samples.samples;
    return s.length > 1 ? (s[s.length - 1].t - s[0].t) / (s.length - 1) / 1000 : null;
  }, [samples.samples]);

  return (
    <div className="pf-stack">
      <section className="pf-hero surface" aria-label="Session">
        <div className="pf-hero__art" aria-hidden>
          {game ? <GameCover game={game} kind="hero" /> : null}
        </div>
        <div className="pf-hero__shade" aria-hidden />
        <div className="pf-hero__content">
          <span className="caps">Session</span>
          <h2 className="pf-hero__title">{gameTitle(game)}</h2>
          <p className="pf-hero__meta">
            {fmtDateTime(entry.startMs)} · <span className="num">{formatDuration(session.durationSeconds)}</span> · {plural(summary.samples, 'sample')}
            {interval ? <> every ~{Math.round(interval)} s</> : null}{' '}
            <SessionOriginChip source={session.source} />
          </p>
          <p className="pf-hero__health" data-level={health.level}>
            <HealthPip level={health.level} size={11} />
            <strong>{HEALTH_LABEL[health.level]}</strong>
            {health.reasons.length > 0 && <span> · {health.reasons.slice(0, 2).join(' · ')}</span>}
          </p>
        </div>
        <div className="pf-hero__action">
          {/* Track M: ~10 s animated summary of this session, saveable as an image. */}
          <Button size="sm" icon={<Clapperboard size={14} />} onClick={() => openReplay(entry.id)}>Replay</Button>
          {game && (
            <Button size="sm" icon={<Gamepad2 size={14} />} onClick={() => useStore.getState().navigate({ name: 'game', id: game.id })}>
              Open game
            </Button>
          )}
        </div>
      </section>

      <div className="vx-tiles pf-tiles">
        {METRICS.map((m) => {
          const avg = summaryValue(summary, m, 'avg');
          const max = summaryValue(summary, m, 'max');
          if (avg == null && max == null)
            return <StatTile key={m.key} icon={ICONS[m.key]} label={m.short} unavailable value="Unavailable" sub={<span title={m.unavailable}>{m.unavailableShort}</span>} />;
          return (
            <StatTile
              key={m.key}
              icon={ICONS[m.key]}
              label={m.short}
              value={<span title={`${m.label}, session average`}>{formatMetric(avg, m.unit)}</span>}
              sub={<>Avg · peak <span className="num">{formatMetric(max, m.unit)}</span></>}
            />
          );
        })}
        <SessionEnergyTile sessionId={entry.id} />
      </div>

      <ThermalPanel summary={summary} samples={insight.samples} />

      <FrameRatePanel
        summary={summary}
        samples={insight.samples}
        durationMs={Math.max(durationMs, insight.samples.reduce((mx, s) => Math.max(mx, s.t), 0))}
        hoverT={hoverT}
        onHover={setHoverT}
        animateKey={entry.id}
        bands={bands}
        markers={markers}
      />

      <section className="surface vx-card" aria-labelledby="pf-charts-title">
        <SectionHead
          title={<span id="pf-charts-title">Over the session</span>}
          meta={
            samples.status === 'ready' && samples.samples.length
              ? bands.length
                ? 'Shaded: GPU slowed down for heat · hover, or focus a chart and use the arrow keys'
                : 'Hover, or focus a chart and use the arrow keys'
              : undefined
          }
        />
        {samples.status === 'loading' && (
          <div className="pf-charts">
            {METRICS.slice(0, 3).map((m) => (
              <Skeleton key={m.key} height={150} radius={12} />
            ))}
          </div>
        )}
        {samples.status === 'error' && <p className="pf-muted">Samples couldn’t be loaded: {samples.error}</p>}
        {samples.status === 'ready' && !samples.samples.length && (
          <p className="pf-muted">No individual samples are stored for this session — only the averages and peaks above.</p>
        )}
        {samples.status === 'ready' && samples.samples.length > 0 && (
          <div className="pf-charts">
            {series.map(({ m, raw, stats, segments, domain }) =>
              stats && domain ? (
                <div key={m.key} className="pf-chart">
                  <div className="pf-chart__head">
                    <span className="pf-chart__key" style={{ background: m.color }} aria-hidden />
                    <h3>{m.label}</h3>
                    <span className="pf-muted">{m.unit === '%' ? 'percent' : m.unit}</span>
                    <span className="pf-chart__stats num">
                      avg {formatMetric(stats.avg, m.unit)} · p95 {formatMetric(stats.p95, m.unit)} · peak {formatMetric(stats.max, m.unit)}
                    </span>
                  </div>
                  <LineChart
                    metric={m}
                    segments={segments}
                    raw={raw}
                    durationMs={Math.max(durationMs, 1)}
                    domain={domain}
                    hoverT={hoverT}
                    onHover={setHoverT}
                    animateKey={entry.id}
                    bands={bands}
                    height={m.key === 'cpu' || m.key === 'gpu' ? 150 : 120}
                    ariaLabel={`${m.label} over ${formatDuration(durationMs / 1000)}: average ${formatMetric(stats.avg, m.unit)}, lowest ${formatMetric(stats.min, m.unit)}, peak ${formatMetric(stats.max, m.unit)}.`}
                  />
                </div>
              ) : (
                <div key={m.key} className="pf-unavailable">
                  <span className="pf-chart__key pf-chart__key--off" aria-hidden />
                  <h3>{m.label}</h3>
                  <Badge>Unavailable</Badge>
                  <span className="pf-muted">{m.unavailable}</span>
                </div>
              ),
            )}
          </div>
        )}
      </section>
    </div>
  );
}
