import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  Activity, Award, BookOpen, CalendarDays, ChevronRight, Clock, Download, Flag, Flame, Gamepad2, Hourglass, Info, Medal, RefreshCw,
  Sparkles, Store, Timer, Trash2, Trophy, X,
} from 'lucide-react';
import { call, errorMessage } from '../bridge/bridge';
import type { Game } from '../bridge/types';
import { Button, EmptyState, SectionHead, Segmented, Skeleton, Tabs } from '../components/ui/primitives';
import { HoldToConfirm } from '../components/controller/HoldToConfirm';
import { Dialog } from '../components/ui/Dialog';
import { formatDuration, formatRelative, PLATFORM_NAMES, plural } from '../lib/format';
import { spring } from '../lib/motion';
import { useReducedMotion, useStore } from '../state/store';
import { GameThumb, StatTile } from './perf/kit';
import { useTrackedSessions } from './perf/hooks';
import { dayLabel, gameTitle, shortDate, timeOfDay } from './perf/text';
import { DayChart } from './journal/DayChart';
import { BacklogCard } from './journal/BacklogCard';
import { Heatmap } from './journal/Heatmap';
import { AchievementTimeline } from './journal/AchievementTimeline';
import {
  computeTotals, currentStreak, genreTotals, groupByDay, inRange, longestStreak, milestones, normalizeSessions, playtimeBuckets, splitAcrossDays, takeGroups,
  topGames, yearInReview, type DayGroup, type JSession, type Milestone, type Range, type YearReview,
} from './journal/stats';
import './journal.css';

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'year', label: 'Year' },
  { value: 'all', label: 'All time' },
];
const RANGE_TEXT: Record<Range, string> = { week: 'last 7 days', month: 'last 30 days', year: 'last 365 days', all: 'all time' };
const PAGE = 40;
const monthName = (ms: number, style: 'long' | 'short' | 'narrow' = 'long', year = true) =>
  new Intl.DateTimeFormat(undefined, { month: style, year: year ? 'numeric' : undefined }).format(ms);

/** Largest store-reported playtime for a game, with the store that reported it. */
function storePlaytime(game: Game | undefined): { minutes: number; store: string } | null {
  if (!game) return null;
  let best: { minutes: number; store: string } | null = null;
  for (const i of game.installations) {
    if (i.importedPlaytimeMinutes != null && i.importedPlaytimeMinutes > 0 && (!best || i.importedPlaytimeMinutes > best.minutes))
      best = { minutes: i.importedPlaytimeMinutes, store: PLATFORM_NAMES[i.platform] };
  }
  return best;
}

export type JournalTab = 'sessions' | 'achievements';

export function JournalView({ tab: routeTab }: { tab?: JournalTab } = {}) {
  const { status, sessions: rawSessions, error, reload, loadedAt: now } = useTrackedSessions();
  const gamesById = useStore((s) => s.gamesById);
  const games = useStore((s) => s.library.games);
  const reduce = useReducedMotion();
  const [range, setRange] = useState<Range>('month');
  const [limit, setLimit] = useState(PAGE);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAllMilestones, setShowAllMilestones] = useState(false);
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  // Track F: Sessions / Achievements tabs (a notification can deep-link to a tab) and the calendar's day filter.
  const [tab, setTab] = useState<JournalTab>(routeTab ?? 'sessions');
  const [linkedTab, setLinkedTab] = useState(routeTab);
  if (routeTab !== linkedTab) {
    setLinkedTab(routeTab);
    if (routeTab) setTab(routeTab);
  }
  const [day, setDay] = useState<number | null>(null);
  const timelineRef = useRef<HTMLElement>(null);

  const all = useMemo(() => normalizeSessions(rawSessions), [rawSessions]);
  const scoped = useMemo(() => inRange(all, range, now), [all, range, now]);
  const totals = useMemo(() => computeTotals(scoped), [scoped]);
  const allTotals = useMemo(() => computeTotals(all), [all]);
  const streak = useMemo(() => currentStreak(all, now), [all, now]);
  const bestStreak = useMemo(() => longestStreak(all).days, [all]);
  const chart = useMemo(() => playtimeBuckets(scoped, range, now), [scoped, range, now]);
  const top = useMemo(() => topGames(scoped, 8), [scoped]);
  const genresOf = useCallback((id: string) => gamesById.get(id)?.genres, [gamesById]);
  const genres = useMemo(() => genreTotals(scoped, genresOf).slice(0, 8), [scoped, genresOf]);
  const groups = useMemo(() => groupByDay(scoped), [scoped]);
  const dayGroups = useMemo(
    () => (day == null ? null : groupByDay(all.filter((s) => splitAcrossDays(s.startMs, s.seconds).some((p) => p.dayStart === day)))),
    [all, day],
  );
  const selectDay = useCallback(
    (d: number | null) => {
      setDay(d);
      if (d != null) requestAnimationFrame(() => timelineRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }));
    },
    [reduce],
  );
  const switchTab = (t: JournalTab) => {
    setTab(t);
    useStore.getState().navigate({ name: 'journal', tab: t }, { replace: true });
  };
  const capsule = useMemo(() => milestones(all), [all]);
  const review = useMemo(() => yearInReview(all, new Date(now).getFullYear(), genresOf), [all, now, genresOf]);
  const store = useMemo(() => {
    let minutes = 0;
    let count = 0;
    for (const g of games) {
      const p = storePlaytime(g);
      if (p) {
        minutes += p.minutes;
        count++;
      }
    }
    return { minutes, count };
  }, [games]);

  const changeRange = (r: Range) => {
    setRange(r);
    setLimit(PAGE);
  };

  const exportJournal = async () => {
    setBusy('export');
    try {
      const res = await call<{ path: string } | null>('data.exportJournal');
      if (res?.path) useStore.getState().toast({ tone: 'success', title: 'Journal exported', body: res.path });
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: 'Couldn’t export your journal', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const deleteHistory = async () => {
    setBusy('delete');
    try {
      await call('data.deleteHistory');
      setConfirmDelete(false);
      useStore.getState().toast({ tone: 'success', title: 'Tracked history deleted', body: 'Store-reported playtime is unchanged.' });
      await Promise.all([reload(), useStore.getState().refreshLibrary()]);
    } catch (err) {
      useStore.getState().toast({ tone: 'danger', title: 'History wasn’t deleted', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const reveal = (i: number) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: reduce ? { duration: 0.15 } : { ...spring.page, delay: 0.04 * i },
  });

  const hasHistory = all.length > 0;

  return (
    <div className="page jr">
      <header className="jr-head">
        <div className="jr-head__text">
          <span className="caps">Journal</span>
          <h1 className="jr-title">Your gaming journal</h1>
          <p className="jr-lede">
            Private to this PC. Built only from sessions you started from VYSTRAL
            <span className="vx-source vx-source--tracked" style={{ marginLeft: 8 }}>
              <Activity size={11} aria-hidden /> Tracked by VYSTRAL
            </span>
          </p>
        </div>
        {hasHistory && (
          <div className="jr-head__actions">
            <Button icon={<Download size={16} />} onClick={exportJournal} loading={busy === 'export'}>
              Export
            </Button>
            <Button variant="ghost" icon={<Trash2 size={16} />} onClick={() => setConfirmDelete(true)}>
              Delete history
            </Button>
          </div>
        )}
      </header>

      <Tabs
        label="Journal sections"
        value={tab}
        onChange={switchTab}
        tabs={[
          { value: 'sessions', label: 'Sessions' },
          { value: 'achievements', label: <><Trophy size={14} aria-hidden style={{ marginRight: 6, verticalAlign: '-2px' }} />Achievements</> },
        ]}
      />

      {tab === 'achievements' && (
        <div role="tabpanel" aria-label="Achievements" className="jr-panel">
          <AchievementTimeline />
        </div>
      )}

      {tab === 'sessions' && <>
      {status === 'loading' && <JournalSkeleton />}

      {status === 'error' && !hasHistory && (
        <EmptyState
          art="none"
          icon={<BookOpen size={34} />}
          title="Your journal couldn’t be loaded"
          body={error ?? 'Something went wrong while reading your sessions.'}
          actions={<Button icon={<RefreshCw size={16} />} onClick={() => void reload()}>Try again</Button>}
        />
      )}

      {status === 'ready' && !hasHistory && (
        <>
          <JournalEmpty storeGames={store.count} />
          <BacklogCard sessions={all} now={now} gamesById={gamesById} reveal={reveal(1)} />
        </>
      )}

      {hasHistory && (
        <>
          <motion.div className="jr-toolbar" {...reveal(0)}>
            <Segmented label="Time range" value={range} options={RANGE_OPTIONS} onChange={changeRange} />
            <span className="jr-toolbar__meta">
              {range === 'all' ? `All time · since ${shortDate(all[all.length - 1].startMs, true)}` : `Showing the ${RANGE_TEXT[range]}`}
            </span>
          </motion.div>

          <motion.div className="vx-tiles jr-tiles" {...reveal(1)}>
            <StatTile icon={<Clock size={13} />} label="Tracked time" value={<span>{formatDuration(totals.seconds)}</span>} sub={`Across ${plural(totals.activeDays, 'active day')}`} />
            <StatTile icon={<Activity size={13} />} label="Sessions" value={<span>{totals.sessions.toLocaleString()}</span>} sub={totals.sessions ? `Avg ${formatDuration(totals.seconds / totals.sessions)}` : 'None in this range'} />
            <StatTile icon={<Gamepad2 size={13} />} label="Games played" value={<span>{totals.games.toLocaleString()}</span>} sub={top[0] ? `Most: ${gameTitle(gamesById.get(top[0].gameId))}` : '—'} />
            <StatTile
              icon={<Timer size={13} />}
              label="Longest session"
              value={<span>{totals.longest ? formatDuration(totals.longest.seconds) : '—'}</span>}
              sub={totals.longest ? `${gameTitle(gamesById.get(totals.longest.gameId))} · ${shortDate(totals.longest.startMs)}` : 'None in this range'}
            />
            <StatTile
              icon={<Flame size={13} />}
              label="Current streak"
              value={<span>{streak}<small>{streak === 1 ? 'day' : 'days'}</small></span>}
              sub={bestStreak > 1 ? `Best: ${plural(bestStreak, 'day')} in a row` : 'Play on consecutive days to build one'}
            />
          </motion.div>

          <motion.section className="surface vx-card jr-heatmap" {...reveal(2)} aria-labelledby="jr-heatmap-title">
            <SectionHead title={<span id="jr-heatmap-title">Play calendar</span>} meta="Tracked minutes per day" />
            <Heatmap sessions={all} now={now} gamesById={gamesById} selectedDay={day} onSelectDay={selectDay} />
          </motion.section>

          {store.count > 0 && (
            <motion.div className="jr-provenance surface" {...reveal(2)}>
              <Info size={16} aria-hidden />
              <p>
                <span className="vx-source vx-source--tracked"><Activity size={11} aria-hidden /> Tracked</span> numbers on this page come only from VYSTRAL sessions.{' '}
                Your stores separately report <strong className="num">{formatDuration(store.minutes * 60, { short: true })}</strong> across{' '}
                {plural(store.count, 'game')}{' '}
                <span className="vx-source vx-source--store"><Store size={11} aria-hidden /> from Steam/store</span> — shown per game below, never added to tracked totals.
              </p>
            </motion.div>
          )}

          {scoped.length === 0 ? (
            <motion.div className="surface vx-card jr-range-empty" {...reveal(3)}>
              <CalendarDays size={22} aria-hidden />
              <div>
                <h2>Nothing tracked in the {RANGE_TEXT[range]}</h2>
                <p>Your most recent session was {formatRelative(new Date(all[0].startMs).toISOString(), now).toLowerCase()}, on {shortDate(all[0].startMs, true)}.</p>
              </div>
              <Button onClick={() => changeRange('all')}>Show all time</Button>
            </motion.div>
          ) : (
            <>
              <motion.section className="surface vx-card" {...reveal(3)} aria-labelledby="jr-chart-title">
                <SectionHead
                  title={<span id="jr-chart-title">Play time by {chart.unit}</span>}
                  meta={`${chart.unit === 'week' ? 'Weekly' : 'Daily'} totals · ${RANGE_TEXT[range]}`}
                />
                <DayChart buckets={chart.buckets} unit={chart.unit} animateKey={range} ariaLabel={chartSummary(chart.buckets, chart.unit, range)} />
              </motion.section>

              <div className="jr-grid">
                <motion.section className="surface vx-card" {...reveal(4)} aria-labelledby="jr-top-title">
                  <SectionHead title={<span id="jr-top-title">Top games</span>} meta={`By tracked time · ${RANGE_TEXT[range]}`} />
                  <ol className="jr-top">
                    {top.map((g, i) => (
                      <TopGameRow key={g.gameId} rank={i + 1} game={gamesById.get(g.gameId)} seconds={g.seconds} sessions={g.sessions} max={top[0].seconds} reduce={reduce} />
                    ))}
                  </ol>
                </motion.section>

                <motion.section className="surface vx-card" {...reveal(5)} aria-labelledby="jr-genres-title">
                  <SectionHead title={<span id="jr-genres-title">Favorite genres</span>} meta="Weighted by tracked time" />
                  {genres.length ? (
                    <>
                      <ul className="jr-genres">
                        {genres.map((g) => (
                          <li key={g.genre}>
                            <div className="jr-genres__row">
                              <span className="jr-genres__name">
                                {g.genre}
                                <span className="jr-genres__meta"> · {plural(g.games, 'game')}</span>
                              </span>
                              <span className="jr-genres__value num">{formatDuration(g.seconds)}</span>
                            </div>
                            <div className="vx-bar" aria-hidden>
                              <Fill fraction={g.seconds / genres[0].seconds} reduce={reduce} />
                            </div>
                          </li>
                        ))}
                      </ul>
                      <p className="jr-footnote">A game counts toward each of its genres.</p>
                    </>
                  ) : (
                    <p className="jr-muted">The games you played don’t have genre information yet.</p>
                  )}
                </motion.section>
              </div>
            </>
          )}

          <BacklogCard sessions={all} now={now} gamesById={gamesById} reveal={reveal(6)} />

          {review && <YearInReviewCard review={review} now={now} gamesById={gamesById} reveal={reveal(6)} />}

          <div className="jr-split">
            <motion.section ref={timelineRef} className="surface vx-card jr-timeline-card" {...reveal(7)} aria-labelledby="jr-timeline-title">
              <SectionHead
                title={<span id="jr-timeline-title">Timeline</span>}
                meta={dayGroups ? `${plural(dayGroups.reduce((n, g) => n + g.sessions.length, 0), 'session')} · ${shortDate(day!, true)}` : `${plural(scoped.length, 'session')} · ${RANGE_TEXT[range]}`}
                action={day != null ? <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={() => setDay(null)}>Show all days</Button> : undefined}
              />
              {dayGroups ? (
                dayGroups.length ? (
                  <Timeline groups={dayGroups} limit={Number.POSITIVE_INFINITY} onMore={() => undefined} now={now} gamesById={gamesById} />
                ) : (
                  <p className="jr-muted">No tracked sessions on {shortDate(day!, true)}.</p>
                )
              ) : groups.length ? (
                <Timeline groups={groups} limit={limit} onMore={() => setLimit((l) => l + PAGE * 2)} now={now} gamesById={gamesById} />
              ) : (
                <p className="jr-muted">No sessions in this range.</p>
              )}
            </motion.section>

            <motion.section className="surface vx-card jr-capsule" {...reveal(8)} aria-labelledby="jr-capsule-title">
              <SectionHead title={<span id="jr-capsule-title">Time Capsule</span>} meta="Milestones" />
              <ol className="jr-milestones">
                {capsule
                  .slice()
                  .reverse()
                  .slice(0, showAllMilestones ? undefined : 10)
                  .map((m) => (
                    <MilestoneItem key={m.id} m={m} gamesById={gamesById} />
                  ))}
              </ol>
              {capsule.length > 10 && (
                <div className="jr-more">
                  <Button size="sm" variant="ghost" aria-expanded={showAllMilestones} onClick={() => setShowAllMilestones((v) => !v)}>
                    {showAllMilestones ? 'Show fewer' : `Show all ${capsule.length}`}
                  </Button>
                </div>
              )}
              <p className="jr-footnote">Milestones come only from sessions VYSTRAL recorded{allTotals.sessions ? `, starting ${shortDate(all[all.length - 1].startMs, true)}` : ''}.</p>
            </motion.section>
          </div>
        </>
      )}

      </>}

      <Dialog
        open={confirmDelete}
        onClose={() => busy !== 'delete' && setConfirmDelete(false)}
        title="Delete tracked history?"
        describedBy="jr-delete-body"
        actions={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setConfirmDelete(false)} disabled={busy === 'delete'}>
              Cancel
            </Button>
            <HoldToConfirm icon={<Trash2 size={16} />} onConfirm={() => void deleteHistory()} loading={busy === 'delete'}>
              Delete history
            </HoldToConfirm>
          </>
        }
      >
        <div id="jr-delete-body" className="jr-delete">
          <p>This permanently deletes:</p>
          <ul>
            <li>
              Every session VYSTRAL tracked — <strong>{plural(allTotals.sessions, 'session')}</strong>, <strong>{formatDuration(allTotals.seconds)}</strong> across {plural(allTotals.games, 'game')}.
            </li>
            <li>All performance samples (CPU, GPU, memory, temperature) recorded during those sessions.</li>
            <li>The graphics driver versions and background-app names noted during those sessions, and the apps you hid from that report.</li>
          </ul>
          <p>
            Not affected: your games, notes, ratings, collections, and playtime reported by Steam and other stores, which keeps showing on each game’s page. This can’t be undone — export your journal first if you want a copy.
          </p>
        </div>
      </Dialog>
    </div>
  );
}

function chartSummary(buckets: { start: number; seconds: number }[], unit: 'day' | 'week', range: Range): string {
  const total = buckets.reduce((n, b) => n + b.seconds, 0);
  const active = buckets.filter((b) => b.seconds > 0).length;
  const best = buckets.reduce<{ start: number; seconds: number } | null>((m, b) => (b.seconds > (m?.seconds ?? 0) ? b : m), null);
  const span = range === 'all' ? 'all time' : `the ${RANGE_TEXT[range]}`;
  if (!best) return `Play time per ${unit} for ${span}: nothing tracked.`;
  return `Play time per ${unit} for ${span}. ${formatDuration(total)} in total across ${plural(active, `active ${unit}`)}. Busiest ${unit}: ${unit === 'week' ? 'week of ' : ''}${shortDate(best.start, true)} with ${formatDuration(best.seconds)}.`;
}

function Fill({ fraction, reduce }: { fraction: number; reduce: boolean }) {
  return (
    <motion.span
      className="vx-bar__fill"
      style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%` }}
      initial={reduce ? false : { scaleX: 0 }}
      animate={{ scaleX: 1 }}
      transition={{ type: 'spring', visualDuration: 0.6, bounce: 0 }}
    />
  );
}

function TopGameRow({ rank, game, seconds, sessions, max, reduce }: { rank: number; game: Game | undefined; seconds: number; sessions: number; max: number; reduce: boolean }) {
  const store = storePlaytime(game);
  const content = (
    <>
      <span className="jr-top__rank num" aria-hidden>{rank}</span>
      <GameThumb game={game} size={36} />
      <span className="jr-top__body">
        <span className="jr-top__line">
          <span className="jr-top__title truncate">{gameTitle(game)}</span>
          <span className="jr-top__value num">{formatDuration(seconds)}</span>
        </span>
        <span className="vx-bar" aria-hidden>
          <Fill fraction={seconds / (max || 1)} reduce={reduce} />
        </span>
        <span className="jr-top__meta">
          <span>{plural(sessions, 'session')}</span>
          {store && (
            <span className="vx-source vx-source--store" title={`Reported by ${store.store}. Not tracked by VYSTRAL.`}>
              <Store size={10} aria-hidden /> {formatDuration(store.minutes * 60, { short: true })} from {store.store}
            </span>
          )}
        </span>
      </span>
    </>
  );
  const label = `${gameTitle(game)}: ${formatDuration(seconds)} tracked over ${plural(sessions, 'session')}${store ? `. ${store.store} separately reports ${formatDuration(store.minutes * 60)}` : ''}`;
  return (
    <li>
      {game ? (
        <button type="button" className="jr-top__row" aria-label={label} onClick={() => useStore.getState().navigate({ name: 'game', id: game.id })}>
          {content}
        </button>
      ) : (
        <div className="jr-top__row" aria-label={label}>
          {content}
        </div>
      )}
    </li>
  );
}

function Timeline({ groups, limit, onMore, now, gamesById }: { groups: DayGroup[]; limit: number; onMore: () => void; now: number; gamesById: Map<string, Game> }) {
  const { shown, shownSessions } = useMemo(() => takeGroups(groups, limit), [groups, limit]);
  const totalSessions = useMemo(() => groups.reduce((n, g) => n + g.sessions.length, 0), [groups]);
  const remaining = totalSessions - shownSessions;
  return (
    <div className="jr-timeline">
      {shown.map((g) => (
        <section key={g.dayStart} className="jr-day" aria-label={dayLabel(g.dayStart, now)}>
          <header className="jr-day__head">
            <span className="jr-day__dot" aria-hidden />
            <h3>{dayLabel(g.dayStart, now)}</h3>
            <span className="jr-day__total num">{formatDuration(g.seconds)}</span>
          </header>
          <ul className="jr-day__list">
            {g.sessions.map((s) => (
              <SessionRow key={s.id} s={s} game={gamesById.get(s.gameId)} />
            ))}
          </ul>
        </section>
      ))}
      {remaining > 0 && (
        <div className="jr-more">
          <Button onClick={onMore}>Show more</Button>
          <span className="jr-muted">{plural(remaining, 'earlier session')}</span>
        </div>
      )}
    </div>
  );
}

function SessionRow({ s, game }: { s: JSession; game: Game | undefined }) {
  const title = gameTitle(game);
  const go = () => {
    const nav = useStore.getState().navigate;
    if (s.hasMetrics) nav({ name: 'performance', sessionId: s.id });
    else if (game) nav({ name: 'game', id: game.id });
  };
  const clickable = s.hasMetrics || !!game;
  const body = (
    <>
      <span className="jr-session__time num">{timeOfDay(s.startMs)}</span>
      <GameThumb game={game} size={28} />
      <span className="jr-session__title truncate">{title}</span>
      {s.hasMetrics && (
        <span className="jr-session__metrics" title="Performance metrics were recorded">
          <Activity size={12} aria-hidden /> Metrics
        </span>
      )}
      <span className="jr-session__dur num">{formatDuration(s.seconds)}</span>
      {clickable && <ChevronRight size={16} className="jr-session__chev" aria-hidden />}
    </>
  );
  return (
    <li>
      {clickable ? (
        <button
          type="button"
          className="jr-session"
          onClick={go}
          aria-label={`${title}, ${formatDuration(s.seconds)}, started ${timeOfDay(s.startMs)}. ${s.hasMetrics ? 'View performance' : 'Open game'}`}
        >
          {body}
        </button>
      ) : (
        <div className="jr-session">{body}</div>
      )}
    </li>
  );
}

function MilestoneItem({ m, gamesById }: { m: Milestone; gamesById: Map<string, Game> }) {
  const name = (id: string) => gameTitle(gamesById.get(id));
  let icon: ReactNode;
  let title: string;
  let detail: string;
  let date = shortDate(m.at, true);
  switch (m.kind) {
    case 'first':
      icon = <Flag size={15} />;
      title = 'First session tracked';
      detail = name(m.gameId);
      break;
    case 'gameHours':
      icon = <Hourglass size={15} />;
      title = `${m.hours} hours in ${name(m.gameId)}`;
      detail = 'Tracked by VYSTRAL';
      break;
    case 'totalHours':
      icon = <Clock size={15} />;
      title = `${m.hours.toLocaleString()} hours tracked`;
      detail = 'Across all games';
      break;
    case 'sessionCount':
      icon = <Medal size={15} />;
      title = `Session number ${m.count.toLocaleString()}`;
      detail = name(m.gameId);
      break;
    case 'longestSession':
      icon = <Trophy size={15} />;
      title = `Longest session: ${formatDuration(m.seconds)}`;
      detail = name(m.gameId);
      break;
    case 'longestStreak':
      icon = <Flame size={15} />;
      title = `Longest streak: ${m.days} days in a row`;
      detail = 'Ended on this day';
      break;
    case 'topMonth':
      icon = <Award size={15} />;
      title = `Most played month: ${monthName(m.month)}`;
      detail = `${formatDuration(m.seconds)} tracked`;
      date = monthName(m.month, 'short');
      break;
  }
  return (
    <li className="jr-milestone">
      <span className="jr-milestone__icon" aria-hidden>{icon}</span>
      <div className="jr-milestone__body">
        <span className="jr-milestone__title">{title}</span>
        <span className="jr-milestone__detail">{detail}</span>
      </div>
      <time className="jr-milestone__date num" dateTime={new Date(m.at).toISOString()}>{date}</time>
    </li>
  );
}

function YearInReviewCard({ review, now, gamesById, reveal }: { review: YearReview; now: number; gamesById: Map<string, Game>; reveal: object }) {
  const top = review.topGame ? gamesById.get(review.topGame.gameId) : undefined;
  const maxMonth = Math.max(...review.months, 1);
  const currentMonth = new Date(now).getFullYear() === review.year ? new Date(now).getMonth() : 11;
  const monthsSummary = review.months
    .slice(0, currentMonth + 1)
    .map((v, i) => `${monthName(new Date(review.year, i, 1).getTime(), 'short', false)} ${formatDuration(v)}`)
    .join(', ');
  return (
    <motion.section className="jr-year surface" {...reveal} aria-labelledby="jr-year-title">
      <div className="jr-year__glow" aria-hidden />
      <div className="jr-year__head">
        <div>
          <span className="caps">
            <Sparkles size={11} aria-hidden style={{ verticalAlign: '-1px', marginRight: 6 }} />
            Year in review · so far
          </span>
          <h2 id="jr-year-title" className="jr-year__title">
            Your {review.year}
          </h2>
        </div>
        <div className="jr-year__hero">
          <span className="jr-year__big">{formatDuration(review.seconds)}</span>
          <span className="jr-muted">tracked through {shortDate(now)}</span>
        </div>
      </div>
      <div className="jr-year__body">
        <dl className="jr-year__facts">
          <div><dt className="caps">Sessions</dt><dd>{review.sessions.toLocaleString()}</dd></div>
          <div><dt className="caps">Games</dt><dd>{review.games.toLocaleString()}</dd></div>
          <div><dt className="caps">Active days</dt><dd>{review.activeDays.toLocaleString()}</dd></div>
          <div><dt className="caps">Best streak</dt><dd>{plural(review.longestStreakDays, 'day')}</dd></div>
          <div><dt className="caps">Busiest month</dt><dd>{monthName(new Date(review.year, review.busiestMonth, 1).getTime(), 'long', false)}</dd></div>
          <div><dt className="caps">Top genre</dt><dd className="truncate">{review.topGenre?.genre ?? '—'}</dd></div>
          {review.longest && (
            <div><dt className="caps">Longest session</dt><dd>{formatDuration(review.longest.seconds)}</dd></div>
          )}
        </dl>
        {review.topGame && (
          <div className="jr-year__top">
            <GameThumb game={top} size={54} />
            <div className="jr-year__top-text">
              <span className="caps">Most played</span>
              <span className="jr-year__top-title">{gameTitle(top)}</span>
              <span className="jr-muted num">{formatDuration(review.topGame.seconds)} · {plural(review.topGame.sessions, 'session')}</span>
            </div>
          </div>
        )}
        <div className="jr-year__months" role="img" aria-label={`Tracked time per month in ${review.year}: ${monthsSummary}.`}>
          {review.months.map((v, i) => (
            <div key={i} className="jr-year__month" data-future={i > currentMonth || undefined} data-best={i === review.busiestMonth && v > 0 ? true : undefined}>
              <span className="jr-year__bar" style={{ height: `${v > 0 ? Math.max(4, (v / maxMonth) * 100) : 0}%` }} />
              <span className="jr-year__mlabel">{monthName(new Date(review.year, i, 1).getTime(), 'narrow', false)}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="jr-footnote">Built only from sessions VYSTRAL recorded in {review.year}. Store-reported playtime isn’t included.</p>
    </motion.section>
  );
}

function JournalEmpty({ storeGames }: { storeGames: number }) {
  return (
    <EmptyState
      art="tide"
      icon={<BookOpen size={34} />}
      title="Your journal starts with your next session"
      body={
        <>
          VYSTRAL records a session each time you start a game from VYSTRAL — when it began, how long you played, and, if enabled, how your PC performed.
          Everything stays on this PC.
          {' '}Playtime that Steam and other stores report{storeGames > 0 ? ` (${plural(storeGames, 'game')} so far)` : ''} appears on each game’s page, labelled “from Steam/store” — it isn’t part of this journal.
        </>
      }
      actions={
        <Button variant="primary" icon={<Gamepad2 size={16} />} onClick={() => useStore.getState().navigate({ name: 'library' })}>
          Open library
        </Button>
      }
    />
  );
}

function JournalSkeleton() {
  return (
    <div className="jr-skeleton" aria-label="Loading your journal" role="status">
      <Skeleton width={320} height={36} />
      <div className="vx-tiles">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} height={96} radius={16} />
        ))}
      </div>
      <Skeleton height={260} radius={22} />
      <div className="jr-grid">
        <Skeleton height={320} radius={22} />
        <Skeleton height={320} radius={22} />
      </div>
    </div>
  );
}
