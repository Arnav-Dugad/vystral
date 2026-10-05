import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowDown, ArrowUp, Cpu, Equal, Gamepad2, Gauge, GitCompareArrows, Info, MemoryStick, MonitorCog, RefreshCw, Thermometer, X,
} from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { Game, PerfSample, PerfSummary, Session } from '../bridge/types';
import { Badge, Button, EmptyState, SectionHead, Skeleton } from '../components/ui/primitives';
import { GameCover } from '../components/game/GameCover';
import { formatDuration, plural } from '../lib/format';
import { spring } from '../lib/motion';
import { useReducedMotion, useStore } from '../state/store';
import { GameThumb, StatTile } from './perf/kit';
import { useTrackedSessions } from './perf/hooks';
import { gameTitle, timeOfDay } from './perf/text';
import { LineChart } from './perf/LineChart';
import { FrameRatePanel, ThermalPanel } from './perf/InsightPanels';
import { useInsightSamples, useThrottleBands } from './perf/insightData';
import {
  METRICS, NOISE_PCT, compareCandidates, compareValues, domainFor, downsampleSegments, extractSeries, formatMetric, parsePerfSummary,
  seriesStats, splitSegments, summaryValue, type MetricDef, type MetricKey, type Pt,
} from './perf/series';
import './performance.css';

interface PerfEntry {
  id: string;
  gameId: string;
  startMs: number;
  session: Session;
  summary: PerfSummary;
}

const ICONS: Record<MetricKey, ReactNode> = {
  cpu: <Cpu size={13} />,
  gpu: <MonitorCog size={13} />,
  gpuTempC: <Thermometer size={13} />,
  gpuMemMb: <MemoryStick size={13} />,
  ramMb: <MemoryStick size={13} />,
};

const LIST_PAGE = 60;
const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
const fmtDate = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);

/* ------------------------------------------------------------------ samples */

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

/* ------------------------------------------------------------------ view */

export function PerformanceView({ sessionId }: { sessionId?: string }) {
  const { status, sessions, error, reload } = useTrackedSessions();
  const gamesById = useStore((s) => s.gamesById);
  const collecting = useStore((s) => s.settings?.['performance.collectMetrics'] ?? true);
  const reduce = useReducedMotion();
  const [gameFilter, setGameFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(sessionId ?? null);
  const [compareOn, setCompareOn] = useState(false);
  const [compareId, setCompareId] = useState<string | null>(null);
  const [listLimit, setListLimit] = useState(LIST_PAGE);

  // A new deep link (route prop) selects that session and clears the game filter.
  const [linkedId, setLinkedId] = useState(sessionId);
  if (sessionId !== linkedId) {
    setLinkedId(sessionId);
    if (sessionId) {
      setSelectedId(sessionId);
      setGameFilter('all');
    }
  }

  const entries = useMemo<PerfEntry[]>(() => {
    const out: PerfEntry[] = [];
    for (const s of sessions) {
      const summary = parsePerfSummary(s.perfSummary);
      const startMs = Date.parse(s.start);
      if (summary && Number.isFinite(startMs)) out.push({ id: s.id, gameId: s.gameId, startMs, session: s, summary });
    }
    return out.sort((a, b) => b.startMs - a.startMs);
  }, [sessions]);

  const gameOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.gameId, (counts.get(e.gameId) ?? 0) + 1);
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count, title: gameTitle(gamesById.get(id)) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [entries, gamesById]);

  const filtered = useMemo(() => (gameFilter === 'all' ? entries : entries.filter((e) => e.gameId === gameFilter)), [entries, gameFilter]);
  const current = filtered.find((e) => e.id === selectedId) ?? filtered[0] ?? null;
  const candidates = useMemo(() => (current ? compareCandidates(entries, current) : []), [entries, current]);
  const other = compareOn && current ? candidates.find((e) => e.id === compareId) ?? candidates[0] ?? null : null;

  const requested = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const requestedWithoutMetrics = status === 'ready' && !!sessionId && !entries.some((e) => e.id === sessionId);

  const select = (id: string) => {
    setSelectedId(id);
    setCompareId(null);
    document.querySelector('[data-scroll-main]')?.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <div className="page pf">
      <header className="pf-head">
        <div className="pf-head__text">
          <span className="caps">Performance</span>
          <h1 className="pf-title">Performance intelligence</h1>
          <p className="pf-lede">Read-only measurements recorded while games you launched from VYSTRAL were running. Nothing here changes your system.</p>
        </div>
      </header>

      {status === 'loading' && <PerfSkeleton />}

      {status === 'error' && !entries.length && (
        <EmptyState
          icon={<Gauge size={34} />}
          title="Performance data couldn’t be loaded"
          body={error ?? 'Something went wrong while reading your sessions.'}
          actions={<Button icon={<RefreshCw size={16} />} onClick={() => void reload()}>Try again</Button>}
        />
      )}

      {requestedWithoutMetrics && (
        <div className="pf-notice surface" role="status">
          <Info size={16} aria-hidden />
          <p>
            {requested
              ? `No performance metrics were recorded for the ${gameTitle(gamesById.get(requested.gameId))} session on ${fmtDateTime(Date.parse(requested.start))}. Metric collection may have been off at the time.`
              : 'That session no longer exists. Its history may have been deleted.'}
          </p>
        </div>
      )}

      {status === 'ready' && !entries.length && (
        <EmptyState
          icon={<Gauge size={34} />}
          title="No performance data yet"
          body={
            <>
              While a game you launched from VYSTRAL is running, VYSTRAL samples CPU and GPU usage, memory and — on NVIDIA cards — GPU temperature, every couple of seconds.
              Metrics are read-only and stay on this PC.{' '}
              {collecting ? 'Collection is on: your next session will appear here.' : 'Collection is currently off (Settings › Performance › Collect metrics).'}
            </>
          }
          actions={
            collecting ? (
              <Button variant="primary" icon={<Gamepad2 size={16} />} onClick={() => useStore.getState().navigate({ name: 'library' })}>Open library</Button>
            ) : (
              <Button variant="primary" onClick={() => useStore.getState().navigate({ name: 'settings', section: 'performance' })}>Open settings</Button>
            )
          }
        />
      )}

      {entries.length > 0 && (
        <>
          <div className="pf-toolbar">
            <label className="pf-filter">
              <span className="caps">Game</span>
              <select
                className="input vx-select"
                value={gameFilter}
                onChange={(e) => {
                  setGameFilter(e.target.value);
                  setListLimit(LIST_PAGE);
                }}
              >
                <option value="all">All games ({entries.length.toLocaleString()})</option>
                {gameOptions.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title} ({g.count})
                  </option>
                ))}
              </select>
            </label>
            <Button
              icon={compareOn ? <X size={16} /> : <GitCompareArrows size={16} />}
              aria-pressed={compareOn}
              onClick={() => setCompareOn((v) => !v)}
              disabled={entries.length < 2}
              title={entries.length < 2 ? 'Record at least two sessions with metrics to compare' : undefined}
            >
              {compareOn ? 'Close compare' : 'Compare sessions'}
            </Button>
            {!collecting && (
              <Badge tone="warn" icon={<Info size={12} />}>
                Metric collection is off
              </Badge>
            )}
          </div>

          <div className="pf-layout">
            <aside className="pf-list surface" aria-label="Sessions with performance metrics">
              <div className="pf-list__head">
                <span className="caps">Sessions</span>
                <span className="pf-muted num">{filtered.length.toLocaleString()}</span>
              </div>
              <ul>
                {filtered.slice(0, listLimit).map((e) => (
                  <li key={e.id}>
                    <SessionItem e={e} game={gamesById.get(e.gameId)} selected={current?.id === e.id} comparing={other?.id === e.id} onSelect={() => select(e.id)} />
                  </li>
                ))}
              </ul>
              {filtered.length > listLimit && (
                <div className="pf-list__more">
                  <Button size="sm" variant="ghost" onClick={() => setListLimit((n) => n + LIST_PAGE * 2)}>
                    Show more ({(filtered.length - listLimit).toLocaleString()})
                  </Button>
                </div>
              )}
            </aside>

            <div className="pf-detail">
              <AnimatePresence mode="wait" initial={false}>
                {current && (
                  <motion.div
                    key={current.id}
                    className="pf-detail__inner"
                    initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, transition: { duration: 0.12 } }}
                    transition={reduce ? { duration: 0.15 } : spring.page}
                  >
                    <SessionDetail
                      entry={current}
                      game={gamesById.get(current.gameId)}
                      compare={
                        compareOn ? (
                          <ComparePanel
                            a={current}
                            b={other}
                            candidates={candidates}
                            gamesById={gamesById}
                            onPick={setCompareId}
                          />
                        ) : null
                      }
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ list */

function SessionItem({ e, game, selected, comparing, onSelect }: { e: PerfEntry; game: Game | undefined; selected: boolean; comparing: boolean; onSelect: () => void }) {
  const gpu = e.summary.gpuAvg;
  const cpu = e.summary.cpuAvg;
  return (
    <button type="button" className="pf-item" aria-current={selected || undefined} onClick={onSelect}>
      <GameThumb game={game} size={34} />
      <span className="pf-item__body">
        <span className="pf-item__title truncate">{gameTitle(game)}</span>
        <span className="pf-item__meta">
          {fmtDate(e.startMs)} · {timeOfDay(e.startMs)} · <span className="num">{formatDuration(e.session.durationSeconds)}</span>
        </span>
        <span className="pf-item__stats num">
          <span>GPU {gpu == null ? '—' : `${Math.round(gpu)}%`}</span>
          <span>CPU {cpu == null ? '—' : `${Math.round(cpu)}%`}</span>
          {comparing && <span className="pf-item__tag">Compared</span>}
        </span>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ detail */

function SessionDetail({ entry, game, compare }: { entry: PerfEntry; game: Game | undefined; compare: ReactNode }) {
  const samples = useSamples(entry.id);
  const insight = useInsightSamples(entry.id);
  const bands = useThrottleBands(insight.samples);
  const [hoverT, setHoverT] = useState<number | null>(null);
  const { summary, session } = entry;

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
            {interval ? <> every ~{Math.round(interval)} s</> : null}
          </p>
        </div>
        {game && (
          <Button size="sm" className="pf-hero__action" icon={<Gamepad2 size={14} />} onClick={() => useStore.getState().navigate({ name: 'game', id: game.id })}>
            Open game
          </Button>
        )}
      </section>

      {compare}

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

/* ------------------------------------------------------------------ compare */

function ComparePanel({
  a,
  b,
  candidates,
  gamesById,
  onPick,
}: {
  a: PerfEntry;
  b: PerfEntry | null;
  candidates: PerfEntry[];
  gamesById: Map<string, Game>;
  onPick: (id: string) => void;
}) {
  const sameGame = candidates.filter((c) => c.gameId === a.gameId);
  const otherGames = candidates.filter((c) => c.gameId !== a.gameId);
  const label = (e: PerfEntry) => `${gameTitle(gamesById.get(e.gameId))} — ${fmtDateTime(e.startMs)} · ${formatDuration(e.session.durationSeconds)}`;
  return (
    <section className="surface vx-card pf-compare" aria-labelledby="pf-compare-title">
      <SectionHead title={<span id="pf-compare-title">Compare</span>} meta="Averages over each whole session" />
      <label className="pf-filter pf-compare__pick">
        <span className="caps">Compare with</span>
        <select className="input vx-select" value={b?.id ?? ''} onChange={(e) => onPick(e.target.value)}>
          {sameGame.length > 0 && (
            <optgroup label={`${gameTitle(gamesById.get(a.gameId))} (same game)`}>
              {sameGame.map((c) => (
                <option key={c.id} value={c.id}>{label(c)}</option>
              ))}
            </optgroup>
          )}
          {otherGames.length > 0 && (
            <optgroup label="Other games">
              {otherGames.slice(0, 300).map((c) => (
                <option key={c.id} value={c.id}>{label(c)}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      {b && (
        <>
          <div className="pf-table-wrap">
            <table className="pf-table">
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">
                    This session
                    <span className="pf-table__sub">{fmtDate(a.startMs)}</span>
                  </th>
                  <th scope="col">
                    Compared
                    <span className="pf-table__sub">{fmtDate(b.startMs)}</span>
                  </th>
                  <th scope="col">Difference</th>
                </tr>
              </thead>
              <tbody>
                {METRICS.map((m) => (
                  <CompareRow key={m.key} m={m} a={summaryValue(a.summary, m, 'avg')} b={summaryValue(b.summary, m, 'avg')} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="vx-note pf-compare__note">
            <Info size={14} aria-hidden />
            <span>
              Differences under ~{NOISE_PCT}% are within normal run-to-run variation — background apps, scenes, settings and session length all move these numbers.
              {a.gameId !== b.gameId && ' These sessions are from different games, so most of the difference comes from the games themselves.'}
              {' '}Frame rate is shown per session above when it was measured.
            </span>
          </p>
        </>
      )}
    </section>
  );
}

function CompareRow({ m, a, b }: { m: MetricDef; a: number | null; b: number | null }) {
  // Difference is "this session" relative to the compared one.
  const d = compareValues(b, a);
  const unitDiff = (v: number) => {
    const sign = v > 0 ? '+' : v < 0 ? '−' : '±';
    const abs = Math.abs(v);
    if (m.unit === 'GB') return `${sign}${abs.toFixed(abs >= 10 ? 1 : 2)} GB`;
    if (m.unit === '°C') return `${sign}${abs.toFixed(1)} °C`;
    return `${sign}${abs.toFixed(1)} pts`;
  };
  let cell: ReactNode;
  if (d.direction === 'unknown') cell = <span className="pf-muted">Unavailable on {a == null && b == null ? 'both' : a == null ? 'this session' : 'compared session'}</span>;
  else {
    const Icon = d.withinNoise || d.direction === 'same' ? Equal : d.direction === 'higher' ? ArrowUp : ArrowDown;
    const word = d.withinNoise || d.direction === 'same' ? 'about the same' : d.direction;
    cell = (
      <span className="pf-delta" data-noise={d.withinNoise || undefined}>
        <Icon size={14} aria-hidden />
        <span className="num">{unitDiff(d.diff!)}</span>
        {d.pct != null && <span className="num pf-muted">({d.pct > 0 ? '+' : ''}{d.pct.toFixed(Math.abs(d.pct) < 10 ? 1 : 0)}%)</span>}
        <span className="pf-delta__word">{word}</span>
      </span>
    );
  }
  return (
    <tr>
      <th scope="row">
        <span className="pf-chart__key" style={{ background: m.color }} aria-hidden />
        {m.label}
      </th>
      <td className="num">{a == null ? <span className="pf-muted">Unavailable</span> : formatMetric(a, m.unit)}</td>
      <td className="num">{b == null ? <span className="pf-muted">Unavailable</span> : formatMetric(b, m.unit)}</td>
      <td>{cell}</td>
    </tr>
  );
}

function PerfSkeleton() {
  return (
    <div className="pf-layout" role="status" aria-label="Loading performance data">
      <Skeleton height={520} radius={22} />
      <div className="pf-stack">
        <Skeleton height={150} radius={22} />
        <div className="vx-tiles">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} height={96} radius={16} />
          ))}
        </div>
        <Skeleton height={360} radius={22} />
      </div>
    </div>
  );
}
