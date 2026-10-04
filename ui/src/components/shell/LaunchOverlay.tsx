import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Gauge, X } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { LaunchState, PerfSummary } from '../../bridge/types';
import { formatDuration, PLATFORM_NAMES } from '../../lib/format';
import { ease, spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import { Button } from '../ui/primitives';

const ACTIVE = ['validating', 'starting', 'waiting', 'notDetected', 'failed'];

/**
 * The launch sequence. Status text follows the real native phases (no fake countdown):
 * validating → starting the store client → waiting for the game process → running.
 * It never claims success before VYSTRAL actually sees the game running.
 */
export function LaunchOverlay() {
  const launch = useStore((s) => s.launch);
  const game = useStore((s) => (launch ? s.gamesById.get(launch.gameId) : undefined));
  const cinematic = useStore((s) => s.settings?.['launch.cinematic'] ?? true);
  const reduce = useReducedMotion();
  const toast = useStore((s) => s.toast);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [enjoy, setEnjoy] = useState<string | null>(null);

  // Brief "Enjoy" beat when the game is detected, then get out of the way.
  useEffect(() => {
    if (launch?.phase === 'running') {
      setEnjoy(launch.ticket);
      const t = window.setTimeout(() => setEnjoy(null), 1400);
      return () => window.clearTimeout(t);
    }
  }, [launch?.phase, launch?.ticket]);

  // Session summary when we return from a game.
  useEffect(() => {
    if (launch?.phase === 'ended' && launch.sessionId && launch.durationSeconds != null && game) {
      let perf = '';
      try {
        const p = launch.perfSummary ? (JSON.parse(launch.perfSummary) as PerfSummary) : null;
        if (p?.gpuAvg != null) perf = ` · GPU avg ${Math.round(p.gpuAvg)}%`;
      } catch {
        // summary is optional
      }
      toast({ tone: 'success', title: `Played ${game.title} for ${formatDuration(launch.durationSeconds)}`, body: `Session saved to your journal${perf}.` });
    } else if (launch?.phase === 'ended' && launch.message) {
      toast({ tone: 'info', title: launch.message });
    }
  }, [launch?.phase, launch?.ticket]); // eslint-disable-line react-hooks/exhaustive-deps

  const show = !!launch && !!game && dismissed !== launch.ticket && (ACTIVE.includes(launch.phase) || enjoy === launch.ticket);
  const close = () => launch && setDismissed(launch.ticket);
  const stop = () => void call('game.stopTracking').catch(() => {});

  useEffect(() => {
    if (!show) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!cinematic || reduce) {
    return (
      <AnimatePresence>
        {show && launch && game && (
          <motion.div className="launch-pill" role="status" aria-live="polite" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={reduce ? { duration: 0.15 } : spring.panel}>
            <StatusIcon launch={launch} />
            <span><strong>{game.title}</strong> — {statusText(launch)}</span>
            {(launch.phase === 'waiting' || launch.phase === 'notDetected') && <Button size="sm" variant="ghost" onClick={stop}>Stop waiting</Button>}
            <Button size="sm" variant="ghost" onClick={close} aria-label="Dismiss"><X size={14} /></Button>
          </motion.div>
        )}
      </AnimatePresence>
    );
  }

  return (
    <AnimatePresence>
      {show && launch && game && (
        <motion.div
          className="launch"
          role="dialog"
          aria-modal="true"
          aria-label={`Launching ${game.title}`}
          data-nav-scope="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.45, ease: ease.in } }}
          transition={{ duration: 0.35 }}
        >
          <motion.div className="launch__art" initial={{ scale: 1.08, opacity: 0 }} animate={{ scale: 1.0, opacity: 1 }} transition={{ duration: 1.2, ease: ease.cinematic }}>
            <motion.div style={{ height: '100%' }} animate={{ scale: [1, 1.04] }} transition={{ duration: 9, ease: 'linear' }}>
              <GameCover game={game} kind="hero" eager />
            </motion.div>
          </motion.div>
          <motion.div className="launch__flood" initial={{ opacity: 0.4 }} animate={{ opacity: 1 }} transition={{ duration: 0.9, ease: ease.out }} />
          <div className="launch__content" aria-live="polite">
            <motion.div initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...spring.hero, delay: 0.12 }}>
              {game.art.logo ? <img className="launch__logo" src={game.art.logo} alt={game.title} /> : <h1 className="launch__title">{game.title}</h1>}
            </motion.div>
            <motion.div className="launch__status" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 }}>
              <StatusIcon launch={launch} />
              <span>{statusText(launch)}</span>
            </motion.div>
            {launch.message && launch.phase !== 'starting' && launch.phase !== 'waiting' && <p className="launch__message">{launch.message}</p>}
            <div className="launch__actions">
              {launch.phase === 'failed' && <Button variant="primary" onClick={close} data-autofocus>Close</Button>}
              {(launch.phase === 'waiting' || launch.phase === 'starting') && (
                <Button variant="ghost" onClick={close} data-autofocus>Hide</Button>
              )}
              {launch.phase === 'notDetected' && (
                <>
                  <Button variant="secondary" onClick={close} data-autofocus>Keep waiting in the background</Button>
                  <Button variant="ghost" onClick={stop}>Stop waiting</Button>
                </>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function statusText(l: LaunchState): string {
  const platform = PLATFORM_NAMES[l.platform as keyof typeof PLATFORM_NAMES] ?? 'the store app';
  switch (l.phase) {
    case 'validating': return 'Checking the game…';
    case 'starting': return l.message ?? `Starting via ${platform}…`;
    case 'waiting': return l.message ?? 'Waiting for the game window…';
    case 'notDetected': return 'Still waiting for the game';
    case 'running': return 'Enjoy your game';
    case 'failed': return 'The game didn’t start';
    default: return '';
  }
}

function StatusIcon({ launch }: { launch: LaunchState }) {
  if (launch.phase === 'failed') return <AlertTriangle size={20} color="var(--warn)" aria-hidden />;
  if (launch.phase === 'running') return <CheckCircle2 size={20} color="var(--ok)" aria-hidden />;
  if (launch.phase === 'notDetected') return <Gauge size={20} aria-hidden />;
  return (
    <svg className="launch__ring" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="oklch(1 0 0 / 0.2)" strokeWidth="2.5" />
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--accent-hi)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="14 60">
        <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.9s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
