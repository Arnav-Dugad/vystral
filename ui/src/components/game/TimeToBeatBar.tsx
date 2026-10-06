import { motion } from 'motion/react';
import { Hourglass } from 'lucide-react';
import type { Game } from '../../bridge/types';
import { formatHours } from '../../lib/dataSources';
import { formatDuration } from '../../lib/format';
import { playedSeconds, TTB_HINT, TTB_SOURCE, ttbProgress, ttbSummary } from '../../lib/timeToBeat';
import { useReducedMotion } from '../../state/store';
import { useTimeToBeat } from '../../state/recap';
import { ServiceLogo } from '../ui/ServiceLogo';
import './ttb.css';

/**
 * Track M: your playtime against IGDB's time-to-beat estimates. Renders nothing without an estimate
 * (no IGDB key, no match, or the setting is off), so cards never show an empty or invented bar.
 */
export function TimeToBeatBar({ game, variant }: { game: Game; variant: 'card' | 'row' }) {
  const ttb = useTimeToBeat(game.id);
  const pr = ttbProgress(playedSeconds(game), ttb);
  if (!pr) return null;
  const label = ttbSummary(pr, formatDuration(pr.played));
  return (
    <span className={`ttb ttb--${variant}`} data-state={pr.state} role="img" aria-label={`Time to beat: ${label}`} title={label}>
      <span className="ttb__track">
        <span className="ttb__fill" style={{ transform: `scaleX(${pr.fill})` }} />
        {pr.markers.map((m) => <span key={m.key} className="ttb__tick" data-reached={m.reached || undefined} style={{ left: `${m.pos * 100}%` }} />)}
      </span>
    </span>
  );
}

/** Game page: the bar with labelled estimates, the source, and IGDB's definitions. */
export function TimeToBeatPanel({ game }: { game: Game }) {
  const ttb = useTimeToBeat(game.id);
  const reduce = useReducedMotion();
  const played = playedSeconds(game);
  const pr = ttbProgress(played, ttb);
  if (!pr || !ttb) return null;
  const summary = ttbSummary(pr, formatDuration(pr.played));
  return (
    <section className="ttb-panel surface" aria-labelledby={`ttb-${game.id}`}>
      <header className="ttb-panel__head">
        <Hourglass size={15} aria-hidden />
        <h2 id={`ttb-${game.id}`} className="ttb-panel__title">Time to beat</h2>
        <span className="ttb-panel__src">{TTB_SOURCE}{ttb.count > 0 ? ` · ${ttb.count.toLocaleString()} ${ttb.count === 1 ? 'player' : 'players'}` : ''}</span>
      </header>
      <p className="ttb-panel__lead">
        {pr.state === 'notStarted'
          ? <>Not started yet. About <strong className="num">{formatHours(pr.targetSeconds)}</strong> to the credits.</>
          : pr.next
            ? <>You’ve played <strong className="num">{formatDuration(pr.played)}</strong> — <strong className="num">{Math.round((pr.played / pr.next.seconds) * 100)}%</strong> of the {pr.next.label.toLowerCase()} estimate.</>
            : <>You’ve played <strong className="num">{formatDuration(pr.played)}</strong>, past every estimate.</>}
      </p>
      <div className="ttb ttb--panel" role="img" aria-label={summary}>
        <span className="ttb__track">
          <motion.span className="ttb__fill" initial={reduce ? false : { scaleX: 0 }} animate={{ scaleX: pr.fill }} transition={{ duration: 1, ease: [0.16, 1, 0.3, 1], delay: 0.15 }} />
          {pr.markers.map((m) => <span key={m.key} className="ttb__tick" data-reached={m.reached || undefined} style={{ left: `${m.pos * 100}%` }} />)}
        </span>
      </div>
      <ul className="ttb-panel__legend">
        {pr.markers.map((m) => (
          <li key={m.key} data-reached={m.reached || undefined} title={`${m.label}: ${TTB_HINT[m.key]}`}>
            <span className="caps">{m.label}</span>
            <strong className="num">{formatHours(m.seconds)}</strong>
          </li>
        ))}
      </ul>
      <p className="ttb-panel__foot">
        <ServiceLogo service="igdb" size={14} decorative /> Player-reported averages from IGDB. Your time is the larger of VYSTRAL-tracked and store-reported playtime (store playtime already includes tracked sessions).
      </p>
    </section>
  );
}
