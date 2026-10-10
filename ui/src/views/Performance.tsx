import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Cpu, Gamepad2, Gauge, GitCompareArrows, History, Info, LayoutDashboard, RefreshCw } from 'lucide-react';
import type { Game } from '../bridge/types';
import { Badge, Button, EmptyState, Skeleton, Tabs, tabPanelProps } from '../components/ui/primitives';
import { formatDuration } from '../lib/format';
import { spring } from '../lib/motion';
import { useReducedMotion, useStore } from '../state/store';
import { GameThumb } from './perf/kit';
import { useTrackedSessions } from './perf/hooks';
import { gameTitle, timeOfDay } from './perf/text';
import { BackgroundAppsCard, DriverChangeCard } from './perf/DataInsightCards';
import { HardwareTimeline } from './perf/HardwareTimeline';
import { EnergyCard } from './perf/EnergyCard';
import { BatteryHistoryCard } from '../components/controller/BatteryHistoryCard';
import { parsePerfSummary, compareCandidates } from './perf/series';
import { HEALTH_LABEL, healthOf, isPerfTab, type PerfEntry, type PerfTab } from './perf/overview';
import { HealthPip, PerfSummaryBand } from './perf/PerfSummaryBand';
import { PerfOverview } from './perf/PerfOverview';
import { SessionTimeline } from './perf/SessionTimeline';
import { SessionDetail } from './perf/SessionDetail';
import { ComparePanel } from './perf/ComparePanel';
import './performance.css';
import './perf/redesign.css';

const LIST_PAGE = 60;
const TAB_KEY = 'vystral.perf.tab';
const fmtDateTime = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms);
const fmtDate = (ms: number) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(ms);

const TABS: { value: PerfTab; label: ReactNode }[] = [
  { value: 'overview', label: <><LayoutDashboard size={15} aria-hidden /> Overview</> },
  { value: 'sessions', label: <><History size={15} aria-hidden /> Sessions</> },
  { value: 'compare', label: <><GitCompareArrows size={15} aria-hidden /> Compare</> },
  { value: 'system', label: <><Cpu size={15} aria-hidden /> System</> },
];

function rememberedTab(): PerfTab | null {
  try {
    const v = sessionStorage.getItem(TAB_KEY);
    return isPerfTab(v) ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ view */

/**
 * Performance intelligence (Track C2 redesign): a summary band (your rig, recent session health, the frame-rate
 * trend), then four tabs — Overview, Sessions (timeline picker and one session in depth), Compare and System
 * (drivers, hardware history, background apps, energy, controller battery). One game filter scopes everything.
 */
export function PerformanceView({ sessionId, tab: routeTab, compareWith }: { sessionId?: string; tab?: PerfTab; compareWith?: string }) {
  const { status, sessions, error, reload } = useTrackedSessions();
  const gamesById = useStore((s) => s.gamesById);
  const collecting = useStore((s) => s.settings?.['performance.collectMetrics'] ?? true);
  const reduce = useReducedMotion();
  const [gameFilter, setGameFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(sessionId ?? null);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(compareWith ?? null); // Track D1: a deep link can name the other session
  const [listLimit, setListLimit] = useState(LIST_PAGE);
  const [tab, setTabState] = useState<PerfTab>(() => (isPerfTab(routeTab) ? routeTab : sessionId ? 'sessions' : rememberedTab() ?? 'overview'));
  const panelRef = useRef<HTMLDivElement>(null);

  const setTab = (t: PerfTab) => {
    setTabState(t);
    try {
      sessionStorage.setItem(TAB_KEY, t);
    } catch {
      // per-session convenience only
    }
  };

  // A new deep link (route prop) selects that session, opens Sessions and clears the game filter.
  const [linked, setLinked] = useState({ sessionId, routeTab, compareWith });
  if (sessionId !== linked.sessionId || routeTab !== linked.routeTab || compareWith !== linked.compareWith) {
    setLinked({ sessionId, routeTab, compareWith });
    if (compareWith) { setCompareA(null); setCompareB(compareWith); }
    if (sessionId) {
      setSelectedId(sessionId);
      setGameFilter('all');
    }
    if (isPerfTab(routeTab)) setTabState(routeTab);
    else if (sessionId) setTabState('sessions');
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

  // Compare: "this session" defaults to the one picked on Sessions; the other to its nearest same-game neighbour.
  const cmpA = (compareA ? filtered.find((e) => e.id === compareA) : null) ?? current;
  const cmpCandidates = useMemo(() => (cmpA ? compareCandidates(filtered, cmpA) : []), [filtered, cmpA]);
  const cmpB = cmpA ? cmpCandidates.find((e) => e.id === compareB) ?? cmpCandidates[0] ?? null : null;

  const requested = sessionId ? sessions.find((s) => s.id === sessionId) : undefined;
  const requestedWithoutMetrics = status === 'ready' && !!sessionId && !entries.some((e) => e.id === sessionId);
  const filterGameId = gameFilter === 'all' ? null : gameFilter;

  const select = (id: string) => {
    setSelectedId(id);
    setCompareA(null);
    setCompareB(null);
  };
  /** From the summary, Overview or a chart: open that session on the Sessions tab. */
  const openSession = (id: string) => {
    const inFilter = filtered.some((e) => e.id === id);
    if (!inFilter) setGameFilter('all');
    select(id);
    setTab('sessions');
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }));
  };

  // Keep the selection valid when the filter changes.
  useEffect(() => {
    if (current && current.id !== selectedId && !filtered.some((e) => e.id === selectedId)) setSelectedId(current.id);
  }, [current, selectedId, filtered]);

  return (
    <div className="page pf">
      <header className="pf-head">
        <div className="pf-head__text">
          <span className="caps">Performance</span>
          <h1 className="pf-title">Performance intelligence</h1>
          <p className="pf-lede">Read-only measurements taken while games VYSTRAL launched or detected were running. Nothing here changes your system.</p>
        </div>
        {entries.length > 0 && (
          <div className="pf-toolbar">
            {!collecting && (
              <Badge tone="warn" icon={<Info size={12} />}>
                Metric collection is off
              </Badge>
            )}
            <label className="pf-filter">
              <span className="caps">Game</span>
              <select
                className="input vx-select"
                value={gameFilter}
                onChange={(e) => {
                  setGameFilter(e.target.value);
                  setListLimit(LIST_PAGE);
                  setCompareA(null);
                  setCompareB(null);
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
          </div>
        )}
      </header>

      {status === 'loading' && <PerfSkeleton />}

      {status === 'error' && !entries.length && (
        <EmptyState
          art="none"
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
              While a game VYSTRAL launched or detected is running, VYSTRAL samples CPU and GPU usage, memory and — on NVIDIA cards — GPU temperature, every couple of seconds.
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
          <PerfSummaryBand entries={filtered} gamesById={gamesById} onOpen={openSession} />

          <div className="pf-tabs" ref={panelRef}>
            <Tabs value={tab} tabs={TABS} onChange={setTab} label="Performance sections" idBase="pf" />
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={tab}
              role="tabpanel"
              className="pf-panel"
              {...tabPanelProps('pf', tab)}
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={reduce ? { duration: 0.12 } : spring.panel}
            >
              {tab === 'overview' && <PerfOverview entries={filtered} gamesById={gamesById} onOpen={openSession} />}

              {tab === 'sessions' && (
                <div className="pf-stack">
                  <SessionTimeline entries={filtered} selectedId={current?.id ?? null} gamesById={gamesById} onSelect={select} />
                  <div className="pf-layout">
                    <aside className="pf-list surface" aria-label="Sessions with performance metrics">
                      <div className="pf-list__head">
                        <span className="caps">Sessions</span>
                        <span className="pf-muted num">{filtered.length.toLocaleString()}</span>
                      </div>
                      <ul>
                        {filtered.slice(0, listLimit).map((e) => (
                          <li key={e.id}>
                            <SessionItem e={e} game={gamesById.get(e.gameId)} selected={current?.id === e.id} onSelect={() => select(e.id)} />
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
                            <SessionDetail entry={current} game={gamesById.get(current.gameId)} />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              )}

              {tab === 'compare' && cmpA && (
                <ComparePanel
                  entries={filtered}
                  a={cmpA}
                  b={cmpB}
                  gamesById={gamesById}
                  onPickA={(id) => {
                    setCompareA(id);
                    setCompareB(null);
                  }}
                  onPickB={setCompareB}
                  onSwap={() => {
                    if (!cmpB) return;
                    setCompareA(cmpB.id);
                    setCompareB(cmpA.id);
                  }}
                />
              )}

              {tab === 'system' && (
                <div className="pf-stack">
                  {/* Track F: GPU driver before/after and background apps, across all sessions (or the filtered game). */}
                  <div className="pf-insights">
                    <DriverChangeCard gameId={filterGameId} />
                    <BackgroundAppsCard />
                  </div>
                  {/* Track Y: hardware at each session start, the opt-in energy estimate, controller battery. */}
                  <HardwareTimeline gameId={filterGameId} />
                  <div className="pf-insights">
                    <EnergyCard gameId={filterGameId} />
                    <BatteryHistoryCard variant="performance" />
                  </div>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ list */

function SessionItem({ e, game, selected, onSelect }: { e: PerfEntry; game: Game | undefined; selected: boolean; onSelect: () => void }) {
  const gpu = e.summary.gpuAvg;
  const fps = e.summary.fpsAvg;
  const health = healthOf(e);
  return (
    <button type="button" className="pf-item" aria-current={selected || undefined} onClick={onSelect}>
      <GameThumb game={game} size={34} />
      <span className="pf-item__body">
        <span className="pf-item__title truncate">{gameTitle(game)}</span>
        <span className="pf-item__meta">
          {fmtDate(e.startMs)} · {timeOfDay(e.startMs)} · <span className="num">{formatDuration(e.session.durationSeconds)}</span>
        </span>
        <span className="pf-item__stats num">
          <span className="pf-item__health" title={HEALTH_LABEL[health.level]}>
            <HealthPip level={health.level} size={9} />
            <span className="visually-hidden">{HEALTH_LABEL[health.level]}</span>
          </span>
          {fps != null ? <span>{Math.round(fps)} fps</span> : <span>GPU {gpu == null ? '—' : `${Math.round(gpu)}%`}</span>}
          <span>CPU {e.summary.cpuAvg == null ? '—' : `${Math.round(e.summary.cpuAvg)}%`}</span>
        </span>
      </span>
    </button>
  );
}

function PerfSkeleton() {
  return (
    <div className="pf-stack" role="status" aria-label="Loading performance data">
      <div className="pf-band">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} height={168} radius={22} />
        ))}
      </div>
      <Skeleton height={44} radius={12} width={420} />
      <div className="vx-tiles">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} height={96} radius={16} />
        ))}
      </div>
      <Skeleton height={300} radius={22} />
    </div>
  );
}
