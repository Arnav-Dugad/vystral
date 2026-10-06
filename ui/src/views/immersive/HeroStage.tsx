import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useTransform } from 'motion/react';
import { call } from '../../bridge/bridge';
import type { Game, LiveTileInfo } from '../../bridge/types';
import { useLiveBlock } from '../../components/game/LiveTile';
import { GameCover } from '../../components/game/GameCover';
import { ease } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { layerOffset, leanX, leanY } from './parallax';

/** Focus must rest this long on a game before its loop starts (browsing never churns decoders). */
export const HERO_LOOP_DELAY_MS = 1400;

const loops = new Map<string, Promise<string | null>>();

function loopFor(gameId: string): Promise<string | null> {
  let p = loops.get(gameId);
  if (!p) {
    p = call<LiveTileInfo>('liveTile.get', { gameId }, 120_000)
      .then((i) => i.src)
      .catch(() => null);
    loops.set(gameId, p);
    // Transient refusals (offline, data saver…) are asked again next time.
    void p.then((src) => !src && loops.delete(gameId));
  }
  return p;
}

/**
 * The hero stage (Track L): the focused game's art full-bleed, with its silent micro-trailer
 * fading in once focus rests on it — under the same rules as Home's live tiles (setting, Data
 * saver, Offline mode, reduced motion, Low quality, safe mode, a hidden window or a running game
 * all keep it still). Three depth layers lean against each D-pad move (parallax), off under
 * reduced motion.
 */
export function HeroStage({ game, tint, tint2 }: { game: Game | null; tint?: string; tint2?: string }) {
  const reduce = useReducedMotion();
  const block = useLiveBlock();
  const [loop, setLoop] = useState<{ id: string; src: string } | null>(null);
  const [playing, setPlaying] = useState(false);
  const steam = !!game?.installations.some((i) => i.platform === 'steam');

  const gameId = game?.id ?? null;
  useEffect(() => {
    setLoop(null);
    setPlaying(false);
    if (!gameId || !steam || block) return;
    let alive = true;
    const t = window.setTimeout(() => {
      void loopFor(gameId).then((src) => alive && src && setLoop({ id: gameId, src }));
    }, HERO_LOOP_DELAY_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [gameId, steam, block]);

  const artX = useTransform(leanX, (v) => layerOffset(v, 1, 22));
  const artY = useTransform(leanY, (v) => layerOffset(v, 1, 12));
  const glowX = useTransform(leanX, (v) => layerOffset(v, 0.45, 22));
  const glowY = useTransform(leanY, (v) => layerOffset(v, 0.45, 12));

  return (
    <div className="imm__backdrop" aria-hidden>
      <motion.div className="imm__layer imm__layer--art" style={reduce ? undefined : { x: artX, y: artY }}>
        <AnimatePresence initial={false}>
          {game && (
            <motion.div
              key={game.id}
              className="imm__backdrop-art"
              initial={{ opacity: 0, scale: reduce ? 1 : 1.04 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ opacity: { duration: reduce ? 0.15 : 0.7, ease: ease.out }, scale: { duration: 1.6, ease: ease.cinematic } }}
            >
              <div className="imm__backdrop-drift">
                <GameCover game={game} kind="hero" eager />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {loop && game && loop.id === game.id && (
          <video
            key={loop.src}
            className="imm__loop"
            data-playing={playing || undefined}
            src={loop.src}
            muted
            loop
            playsInline
            autoPlay
            preload="auto"
            disablePictureInPicture
            disableRemotePlayback
            tabIndex={-1}
            onPlaying={() => setPlaying(true)}
            onError={() => setLoop(null)}
          />
        )}
      </motion.div>
      <motion.div
        className="imm__layer imm__layer--glow"
        style={{ ['--stage' as string]: tint, ['--stage-2' as string]: tint2, ...(reduce ? {} : { x: glowX, y: glowY }) }}
      />
      <div className="imm__backdrop-scrim" />
      <div className="imm__vignette" />
    </div>
  );
}
