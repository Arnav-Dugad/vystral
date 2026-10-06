import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CalendarDays, Clapperboard, Gauge, Moon, Thermometer, Timer, Trophy, X } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { AwayResult, AwaySummary, RecapSession } from '../../bridge/types';
import { formatPercent } from '../../lib/achievements';
import { awayHeadline, awayOrigin, latestDay, sessionLink, sortAchievements } from '../../lib/away';
import { formatDuration, formatRelative, plural } from '../../lib/format';
import { shimmerTier } from '../../lib/shimmer';
import { spring } from '../../lib/motion';
import { peekPalette, titleHue } from '../../lib/palette';
import { openReplay } from '../../state/recap';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { IconButton } from '../../components/ui/primitives';
import '../../components/ui/shimmer.css';
import './away.css';

// The summary stays for this run of the app until dismissed, even though the "last seen" marker
// moves as soon as it is shown (so it never comes back after a restart).
let held: Promise<AwaySummary | null> | null = null;

function load(): Promise<AwaySummary | null> {
  return call<AwayResult>('away.summary').then(
    (r) => {
      const s = r?.summary && Array.isArray(r.summary.sessions) && r.summary.sessions.length ? r.summary : null;
      // Home was opened: move the marker so these sessions aren't "new" next time.
      if (!r?.firstVisit) void call('away.markSeen', { until: s?.until ?? new Date().toISOString() }).catch(() => {});
      return s;
    },
    () => {
      held = null; // try again next time Home opens
      return null;
    },
  );
}

/**
 * Track M: "While you were away" — games VYSTRAL noticed being played without launching them (by
 * the background helper while it was closed, or detected while it was open), since Home was last
 * opened. Renders nothing when nothing happened.
 */
export function AwayCard() {
  const [summary, setSummary] = useState<AwaySummary | null>(null);
  const reduce = useReducedMotion();
  const navigate = useStore((s) => s.navigate);
  const gamesById = useStore((s) => s.gamesById);

  useEffect(() => {
    let alive = true;
    held ??= load();
    void held.then((s) => alive && setSummary(s));
    return () => { alive = false; };
  }, []);

  const dismiss = () => {
    held = Promise.resolve(null);
    setSummary(null);
  };

  const ach = useMemo(() => (summary ? sortAchievements(summary.achievements) : []), [summary]);
  const peak = useMemo(() => {
    let best: RecapSession | null = null;
    for (const s of summary?.sessions ?? []) if (s.perf.peakTempC != null && (!best || s.perf.peakTempC > best.perf.peakTempC!)) best = s;
    return best;
  }, [summary]);

  const lead = summary ? gamesById.get(summary.games[0]?.gameId) : undefined;
  const accent = lead ? peekPalette(lead)?.accent ?? `oklch(0.72 0.15 ${titleHue(lead.title)})` : 'var(--accent)';
  const day = summary ? latestDay(summary) : null;

  return (
    <AnimatePresence>
      {summary && (
        <motion.section
          key="away"
          className="away surface"
          aria-labelledby="away-title"
          style={{ ['--away-accent' as string]: accent }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98, transition: { duration: 0.22 } }}
          transition={reduce ? { duration: 0.15 } : spring.panel}
        >
          <div className="away__glow" aria-hidden />
          <header className="away__head">
            <span className="away__eyebrow caps"><Moon size={13} aria-hidden /> While you were away</span>
            <IconButton label="Dismiss" size="sm" onClick={dismiss}><X size={15} /></IconButton>
          </header>
          <h2 id="away-title" className="away__title">{awayHeadline(summary)}</h2>
          <p className="away__origin">{awayOrigin(summary)} · since {formatRelative(summary.since).toLowerCase()}</p>

          <div className="away__body">
            <ul className="away__games" aria-label="Games played">
              {summary.games.slice(0, 6).map((g, i) => {
                const game = gamesById.get(g.gameId);
                const last = summary.sessions.find((s) => s.gameId === g.gameId);
                return (
                  <motion.li key={g.gameId} initial={reduce ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.panel, delay: 0.08 + i * 0.06 }}>
                    <button className="away__game" onClick={() => last && navigate(sessionLink(last))}
                      aria-label={`${g.title}: ${formatDuration(g.seconds)} in ${plural(g.sessions, 'session')}. ${last?.perf.hasMetrics ? 'Open performance' : 'Open in Journal'}`}>
                      <span className="away__thumb" aria-hidden>{game && <GameCover game={game} />}</span>
                      <span className="away__game-text">
                        <span className="away__game-title truncate">{g.title}</span>
                        <span className="away__game-meta"><span className="num">{formatDuration(g.seconds)}</span> · {plural(g.sessions, 'session')}</span>
                      </span>
                    </button>
                  </motion.li>
                );
              })}
            </ul>

            <div className="away__highlights">
              {summary.best && (
                <Highlight icon={<Timer size={14} />} label="Best session" value={formatDuration(summary.best.durationSeconds)}
                  sub={`${summary.best.title} · ${formatRelative(summary.best.start)}`} onClick={() => navigate(sessionLink(summary.best!))}
                  replay={() => openReplay(summary.best!.id)} />
              )}
              {summary.bestFps?.perf.fpsAvg != null && (
                <Highlight icon={<Gauge size={14} />} label="Smoothest" value={`${Math.round(summary.bestFps.perf.fpsAvg)} FPS`}
                  sub={`${summary.bestFps.title}${summary.bestFps.perf.fps1Low != null ? ` · 1% low ${Math.round(summary.bestFps.perf.fps1Low)}` : ''}`}
                  onClick={() => navigate(sessionLink(summary.bestFps!))} />
              )}
              {peak && (
                <Highlight icon={<Thermometer size={14} />} label="Peak GPU temperature" value={`${Math.round(peak.perf.peakTempC!)}°C`} sub={peak.title}
                  onClick={() => navigate(sessionLink(peak))} />
              )}
              {ach.length > 0 && (
                <div className="away__ach">
                  <span className="away__hl-label"><Trophy size={14} aria-hidden /> {plural(ach.length, 'achievement')} unlocked</span>
                  <ul className="away__ach-list">
                    {ach.slice(0, 8).map((a, i) => (
                      <li key={`${a.gameId}-${a.apiName}`} className={reduce ? undefined : 'shimmer'} data-tier={shimmerTier(a.globalPercent)}
                        style={{ ['--shimmer-delay' as string]: `${0.4 + i * 0.12}s` }}
                        title={`${a.name}${a.globalPercent != null ? ` · ${formatPercent(a.globalPercent)} of players` : ''}`}>
                        {a.icon ? <img src={a.icon} alt={a.name} /> : <span className="away__ach-fallback" role="img" aria-label={a.name}><Trophy size={16} /></span>}
                      </li>
                    ))}
                    {ach.length > 8 && <li className="away__ach-more">+{ach.length - 8}</li>}
                  </ul>
                </div>
              )}
            </div>
          </div>

          <footer className="away__foot">
            {day != null && (
              <button className="away__link" onClick={() => navigate({ name: 'journal', tab: 'sessions', day })}>
                <CalendarDays size={13} aria-hidden /> Open in Journal
              </button>
            )}
            {summary.gamesWithoutAchievementData > 0 && (
              <span className="away__note">Achievements for {plural(summary.gamesWithoutAchievementData, 'game')} haven’t been checked with Steam yet.</span>
            )}
          </footer>
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function Highlight({ icon, label, value, sub, onClick, replay }: { icon: React.ReactNode; label: string; value: string; sub: string; onClick: () => void; replay?: () => void }) {
  return (
    <div className="away__hl">
      <button className="away__hl-main" onClick={onClick} aria-label={`${label}: ${value}, ${sub}`}>
        <span className="away__hl-label">{icon} {label}</span>
        <span className="away__hl-value num">{value}</span>
        <span className="away__hl-sub truncate">{sub}</span>
      </button>
      {replay && <IconButton label="Replay this session" size="sm" onClick={replay}><Clapperboard size={14} /></IconButton>}
    </div>
  );
}
