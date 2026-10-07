import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { CalendarClock, ChevronRight } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Game, Session, TimeToBeat } from '../../bridge/types';
import { aboutSpan, completionForecast, roughDate, spanRange, WINDOW_DAYS, type Forecast } from '../../lib/completionForecast';
import { formatDuration, plural } from '../../lib/format';
import { isObserved } from '../../lib/sessions';
import { playedSeconds, TTB_LABEL } from '../../lib/timeToBeat';
import { useReducedMotion, useStore } from '../../state/store';
import { SectionHead } from '../ui/primitives';
import { useTimeToBeat, useTimeToBeatMap } from '../../state/recap';
import { GameThumb } from '../../views/perf/kit';
import { gameTitle } from '../../views/perf/text';
import type { JSession } from '../../views/journal/stats';
import './forecast.css';

const TARGET_WORDS: Record<Forecast['target'], string> = { main: 'the main story', extras: 'the main story and extras', completionist: 'everything (completionist)' };

export function forecastFor(game: Game, ttb: TimeToBeat | undefined, sessions: readonly { startMs: number; seconds: number }[], now: number): Forecast | null {
  const r = completionForecast({ played: playedSeconds(game), ttb, sessions, now, status: game.status ?? null });
  return 'forecast' in r ? r.forecast : null;
}

/** A tiny range strip: now → the far end of the range, the likely range shaded and the likely point marked. */
function RangeStrip({ f, reduce }: { f: Forecast; reduce: boolean }) {
  const max = Math.max(f.weeksHigh * 1.08, 0.5);
  const pos = (w: number) => `${Math.min(100, (w / max) * 100)}%`;
  return (
    <span className="cf-strip" aria-hidden>
      <span className="cf-strip__track" />
      <motion.span
        className="cf-strip__band"
        style={{ left: pos(f.weeksLow), width: `calc(${pos(f.weeksHigh)} - ${pos(f.weeksLow)})` }}
        initial={reduce ? false : { opacity: 0, scaleX: 0.3 }}
        animate={{ opacity: 1, scaleX: 1 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.1 }}
      />
      <motion.span
        className="cf-strip__dot"
        style={{ left: pos(f.weeks) }}
        initial={reduce ? false : { opacity: 0, scale: 0.4 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, delay: reduce ? 0 : 0.45 }}
      />
    </span>
  );
}

/**
 * Game page (Track Y): "At your pace you'll finish … in about 3 weeks", with an honest range. Renders
 * nothing without an IGDB estimate or without enough recent play to have a pace.
 */
export function CompletionForecastPanel({ game }: { game: Game }) {
  const ttb = useTimeToBeat(game.id);
  const reduce = useReducedMotion();
  const [sessions, setSessions] = useState<{ startMs: number; seconds: number }[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ttb) return;
    let alive = true;
    call<Session[]>('sessions.list', { gameId: game.id, limit: 200 })
      .then((list) => {
        if (!alive) return;
        setNow(Date.now());
        setSessions((Array.isArray(list) ? list : []).filter((s) => isObserved(s.source)).map((s) => ({ startMs: Date.parse(s.start), seconds: s.durationSeconds })));
      })
      .catch(() => alive && setSessions([]));
    return () => { alive = false; };
  }, [game.id, game.sessionCount, ttb]);

  const f = useMemo(() => (sessions ? forecastFor(game, ttb, sessions, now) : null), [game, ttb, sessions, now]);
  if (!f) return null;
  const title = gameTitle(game);
  const summary = `At your pace you'll finish ${TARGET_WORDS[f.target]} of ${title} in ${aboutSpan(f.weeks)}, likely within ${spanRange(f.weeksLow, f.weeksHigh)}.`;
  return (
    <section className="ttb-panel cf-panel surface" aria-labelledby={`cf-${game.id}`}>
      <header className="ttb-panel__head">
        <CalendarClock size={15} aria-hidden />
        <h2 id={`cf-${game.id}`} className="ttb-panel__title">Completion forecast</h2>
        <span className="ttb-panel__src">Estimate · last {WINDOW_DAYS / 7} weeks</span>
      </header>
      <p className="cf-lead">
        At your pace you’ll finish {TARGET_WORDS[f.target]} in <strong>{aboutSpan(f.weeks)}</strong>
        <span className="cf-when"> — around {roughDate(now, f.weeks)}</span>.
      </p>
      <div className="cf-range" role="img" aria-label={summary}>
        <RangeStrip f={f} reduce={reduce} />
        <span className="cf-range__labels" aria-hidden>
          <span>Now</span>
          <span className="cf-range__likely">Likely {spanRange(f.weeksLow, f.weeksHigh)}</span>
        </span>
      </div>
      <dl className="cf-facts">
        <div><dt className="caps">Your pace</dt><dd><span className="num">{formatDuration(f.weekly)}</span> a week</dd></div>
        <div><dt className="caps">Sessions</dt><dd><span className="num">{(Math.round(f.sessionsPerWeek * 10) / 10).toLocaleString()}</span> a week · ~<span className="num">{formatDuration(f.avgSession)}</span> each</dd></div>
        <div><dt className="caps">Left</dt><dd><span className="num">{formatDuration(f.remaining)}</span> of {TTB_LABEL[f.target].toLowerCase()}</dd></div>
      </dl>
      <p className="ttb-panel__foot">
        Your last {WINDOW_DAYS / 7} weeks of {title} ({plural(f.sessionsInWindow, 'session')}) against what’s left of IGDB’s player average. The range allows for weeks that vary
        {f.steadiness === 'uneven' ? ' — yours vary a lot, so it’s wide —' : ''} and for players who are 25% faster or slower than average. It updates after every session, and hides when there isn’t enough recent play.
      </p>
    </section>
  );
}

/**
 * Journal (Track Y): the games you're on track to finish soonest, from the same forecast. Renders
 * nothing when no game has an estimate and a recent pace.
 */
export function FinishingSoon({ sessions, now, gamesById }: { sessions: readonly JSession[]; now: number; gamesById: Map<string, Game> }) {
  const map = useTimeToBeatMap();
  const navigate = useStore((s) => s.navigate);
  const rows = useMemo(() => {
    if (!map?.games) return [];
    const byGame = new Map<string, { startMs: number; seconds: number }[]>();
    for (const s of sessions) {
      const list = byGame.get(s.gameId) ?? [];
      list.push({ startMs: s.startMs, seconds: s.seconds });
      byGame.set(s.gameId, list);
    }
    const out: { game: Game; f: Forecast }[] = [];
    for (const [id, list] of byGame) {
      const game = gamesById.get(id);
      const ttb = map.games[id];
      if (!game || !ttb) continue;
      const f = forecastFor(game, ttb, list, now);
      if (f) out.push({ game, f });
    }
    return out.sort((a, b) => a.f.weeks - b.f.weeks).slice(0, 5);
  }, [map, sessions, gamesById, now]);
  if (!rows.length) return null;
  return (
    <section className="surface vx-card cf-card" aria-labelledby="jr-finishing-title">
      <SectionHead title={<span id="jr-finishing-title">Finishing soon</span>} meta="At your pace · IGDB time-to-beat" />
    <ol className="cf-list">
      {rows.map(({ game, f }) => (
        <li key={game.id}>
          <button
            type="button"
            className="cf-row"
            onClick={() => navigate({ name: 'game', id: game.id })}
            aria-label={`${gameTitle(game)}: about ${aboutSpan(f.weeks).replace(/^about /, '')} to finish ${TARGET_WORDS[f.target]} at your pace, likely ${spanRange(f.weeksLow, f.weeksHigh)}. ${formatDuration(f.weekly)} a week, ${formatDuration(f.remaining)} left.`}
          >
            <GameThumb game={game} size={34} />
            <span className="cf-row__body">
              <span className="cf-row__title truncate">{gameTitle(game)}</span>
              <span className="cf-row__meta"><span className="num">{formatDuration(f.weekly)}</span> a week · <span className="num">{formatDuration(f.remaining)}</span> left of {TTB_LABEL[f.target].toLowerCase()}</span>
            </span>
            <span className="cf-row__when">
              <strong>{aboutSpan(f.weeks).replace(/^about /, '')}</strong>
              <span className="num">{spanRange(f.weeksLow, f.weeksHigh)}</span>
            </span>
            <ChevronRight size={16} className="cf-row__chev" aria-hidden />
          </button>
        </li>
      ))}
    </ol>
      <p className="jr-footnote">
        Sessions per week × average length over your last {WINDOW_DAYS / 7} weeks, against what’s left of IGDB’s player-reported estimate. Ranges allow for uneven weeks and for
        playing faster or slower than average. Games without an estimate or without recent sessions aren’t listed.
      </p>
    </section>
  );
}
