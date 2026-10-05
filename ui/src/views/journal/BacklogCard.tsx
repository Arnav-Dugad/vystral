import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Hourglass, Layers, ListChecks } from 'lucide-react';
import { call, on } from '../../bridge/bridge';
import type { Game, StatusHistoryEntry } from '../../bridge/types';
import { formatDuration, plural } from '../../lib/format';
import { STATUS_META, STATUSES } from '../../lib/status';
import { useStore } from '../../state/store';
import { Button, SectionHead, Skeleton } from '../../components/ui/primitives';
import { GameThumb } from '../perf/kit';
import { gameTitle, shortDate } from '../perf/text';
import { BacklogChart } from './BacklogChart';
import { backlogSeries, currentCounts, describeBacklog, finishedInYear, normalizeHistory, timeToBeat } from './backlog';
import type { JSession } from './stats';
import '../../components/game/status.css';
import './backlog.css';

function useStatusHistory(): { history: StatusHistoryEntry[] | null; failed: boolean } {
  const [history, setHistory] = useState<StatusHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    call<StatusHistoryEntry[]>('status.history')
      .then((h) => {
        setHistory(Array.isArray(h) ? h : []);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(() => {
    load();
    let t: number | undefined;
    const off = on('status.changed', () => {
      window.clearTimeout(t);
      t = window.setTimeout(load, 300);
    });
    return () => {
      window.clearTimeout(t);
      off();
    };
  }, [load]);
  return { history, failed };
}

/**
 * Journal → Backlog: how many games sit in each status, the backlog's size over time, what you
 * finished this year and your average time to beat — all from statuses you set yourself.
 */
export function BacklogCard({ sessions, now, gamesById, reveal }: { sessions: readonly JSession[]; now: number; gamesById: Map<string, Game>; reveal: object }) {
  const games = useStore((s) => s.library.games);
  const navigate = useStore((s) => s.navigate);
  const { history, failed } = useStatusHistory();
  const clock = now || Date.now();
  const year = new Date(clock).getFullYear();

  const counts = useMemo(() => currentCounts(games), [games]);
  const totalWithStatus = STATUSES.reduce((n, s) => n + counts[s.value], 0);
  const events = useMemo(() => normalizeHistory(history ?? []), [history]);
  const series = useMemo(() => backlogSeries(events, clock), [events, clock]);
  const finished = useMemo(() => finishedInYear(events, year, (id) => gamesById.get(id)?.status), [events, year, gamesById]);
  const ttb = useMemo(() => timeToBeat(events, sessions), [events, sessions]);
  const maxCount = Math.max(1, ...STATUSES.map((s) => counts[s.value]));

  if (history === null && !failed) {
    return <Skeleton height={300} radius={22} />;
  }

  const empty = totalWithStatus === 0 && events.length === 0;

  return (
    <motion.section className="surface vx-card jr-backlog" {...reveal} aria-labelledby="jr-backlog-title">
      <SectionHead title={<span id="jr-backlog-title">Backlog</span>} meta="From the statuses you set on game pages" />

      {empty ? (
        <div className="jr-backlog__empty">
          <Layers size={22} aria-hidden />
          <div>
            <h3>No statuses yet</h3>
            <p>
              Mark games as Backlog, Playing, Beaten, Completed 100% or Abandoned from their page. This card then charts your backlog over time and
              shows what you’ve finished.
            </p>
          </div>
          <Button onClick={() => navigate({ name: 'library' })}>Open library</Button>
        </div>
      ) : (
        <>
          <ul className="jr-backlog__counts" aria-label="Games per status">
            {STATUSES.map((s) => {
              const Icon = s.icon;
              const n = counts[s.value];
              return (
                <li key={s.value} className="jr-backlog__count" style={{ ['--st' as string]: s.color }}>
                  <span className="status-mark">
                    <span className="status-mark__icon" aria-hidden><Icon size={14} /></span>
                    <span className="jr-backlog__count-label">{s.label}</span>
                  </span>
                  <span className="jr-backlog__count-value num">{n}</span>
                  <span className="jr-backlog__count-bar" aria-hidden>
                    <span style={{ transform: `scaleX(${n / maxCount})` }} />
                  </span>
                </li>
              );
            })}
          </ul>

          {series.points.length > 0 && (
            <div className="jr-backlog__chart">
              <div className="jr-backlog__chart-head">
                <h3>Backlog size over time</h3>
                <span className="jr-muted">{series.unit === 'week' ? 'Weekly' : 'Daily'} · games marked Backlog</span>
              </div>
              <BacklogChart points={series.points} unit={series.unit} ariaLabel={describeBacklog(series, (ms) => shortDate(ms, true))} />
            </div>
          )}

          <div className="jr-backlog__split">
            <div>
              <h3 className="jr-backlog__subhead">
                <ListChecks size={15} aria-hidden /> Finished in {year}
              </h3>
              {finished.length ? (
                <ol className="jr-backlog__finished">
                  {finished.slice(0, 8).map((f) => {
                    const g = gamesById.get(f.gameId);
                    const meta = STATUS_META[f.status];
                    const Icon = meta.icon;
                    return (
                      <li key={f.gameId}>
                        <button type="button" className="jr-backlog__game" onClick={() => g && navigate({ name: 'game', id: g.id })} disabled={!g}>
                          <GameThumb game={g} size={28} />
                          <span className="jr-backlog__game-title truncate">{gameTitle(g)}</span>
                          <span className="status-mark jr-backlog__game-status" style={{ ['--st' as string]: meta.color }}>
                            <span className="status-mark__icon" aria-hidden><Icon size={13} /></span>
                            {meta.label}
                          </span>
                          <time className="jr-backlog__game-date num" dateTime={new Date(f.atMs).toISOString()}>{shortDate(f.atMs)}</time>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="jr-muted">Nothing marked Beaten or Completed 100% in {year} yet.</p>
              )}
              {finished.length > 8 && <p className="jr-footnote">And {plural(finished.length - 8, 'more game')}.</p>}
            </div>
            <div className="jr-backlog__ttb">
              <h3 className="jr-backlog__subhead">
                <Hourglass size={15} aria-hidden /> Average time to beat
              </h3>
              {ttb.games ? (
                <>
                  <div className="jr-backlog__ttb-value">
                    {ttb.avgTrackedSeconds != null ? formatDuration(ttb.avgTrackedSeconds) : '—'}
                    <small>tracked play</small>
                  </div>
                  <p className="jr-backlog__ttb-sub">
                    {ttb.avgTrackedSeconds != null
                      ? `Across ${plural(ttb.trackedGames, 'game')} with VYSTRAL sessions between “Playing” and “Beaten”.`
                      : 'None of your finished games have VYSTRAL sessions between “Playing” and “Beaten”.'}
                    {' '}About {Math.max(1, Math.round(ttb.avgDays ?? 0))} {Math.round(ttb.avgDays ?? 0) === 1 ? 'day' : 'days'} from start to finish on average ({plural(ttb.games, 'game')}).
                  </p>
                </>
              ) : (
                <p className="jr-muted">Mark a game Playing when you start it and Beaten when you finish, and your average shows up here.</p>
              )}
              <p className="jr-footnote">Only counts time VYSTRAL tracked; store-reported playtime isn’t included.</p>
            </div>
          </div>
        </>
      )}
    </motion.section>
  );
}
