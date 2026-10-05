import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Square } from 'lucide-react';
import { call } from '../../bridge/bridge';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';

function elapsed(fromIso: string | null): string {
  if (!fromIso) return '';
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(fromIso)) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Title-bar chip while a game is running (or starting): what's playing, a live session timer,
 * and a control to stop tracking — which never touches the game itself.
 */
export function NowPlaying() {
  const launch = useStore((s) => s.launch);
  const game = useStore((s) => (s.launch ? s.gamesById.get(s.launch.gameId) : undefined));
  const navigate = useStore((s) => s.navigate);
  const reduce = useReducedMotion();
  const [, tick] = useState(0);
  const active = !!launch && !!game && ['starting', 'waiting', 'notDetected', 'running'].includes(launch.phase);
  const running = launch?.phase === 'running';

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  return (
    <AnimatePresence>
      {active && game && launch && (
        <motion.div
          className="now-playing"
          role="status"
          aria-live="polite"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14 } }}
          transition={pick(reduce, spring.panel)}
        >
          <button className="now-playing__main" onClick={() => navigate({ name: 'game', id: game.id })} aria-label={`${running ? 'Playing' : 'Starting'} ${game.title}. Open game page`}>
            <span className="now-playing__thumb">
              <GameCover game={game} />
            </span>
            <span className="now-playing__dot" data-running={running} aria-hidden />
            <span className="now-playing__label">{running ? 'Playing' : 'Starting'}</span>
            <span className="now-playing__title truncate">{game.title}</span>
            {running && <span className="now-playing__time num">{elapsed(launch.startedAt)}</span>}
          </button>
          <button
            className="now-playing__stop"
            title="Stop tracking this session (the game keeps running)"
            aria-label="Stop tracking this session. The game keeps running."
            onClick={() => void call('game.stopTracking').catch(() => {})}
          >
            <Square size={11} fill="currentColor" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
