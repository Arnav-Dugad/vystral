import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { call, on } from '../../bridge/bridge';
import type { AchievementFeed, AchievementFeedItem, Game, LiveTileInfo, MediaItem } from '../../bridge/types';
import { useLiveBlock } from '../../components/game/LiveTile';
import { formatPercent } from '../../lib/achievements';
import { shimmerTier } from '../../lib/shimmer';
import '../../components/ui/shimmer.css';
import { highlightAchievements } from './attractSlides';
import { formatRelative, isInstalled, lastPlayed } from '../../lib/format';
import { pushPadHandler } from '../../lib/input';
import { ease } from '../../lib/motion';
import { useGameRunning, useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import './attract.css';

interface Slide {
  key: string;
  game: Game | null;
  imageUrl: string | null;
  caption: string;
  sub: string;
  /** Track L: an achievement highlight (a rare unlock of yours) instead of plain art. */
  achievement?: AchievementFeedItem;
}


const SLIDE_MS = 9000;

/**
 * Attract mode: after a few idle minutes in Immersive, a slow screensaver of hero art and the
 * user's own screenshots. The first input of any kind only wakes it (it never also acts on the
 * interface underneath), and the interface is exactly where it was because it never unmounted.
 */
export function AttractMode({ games, active, onActiveChange }: { games: Game[]; active: boolean; onActiveChange: (v: boolean) => void }) {
  const settings = useStore((s) => s.settings);
  const running = useGameRunning();
  const reduce = useReducedMotion();
  const enabled = settings?.['immersive.attract'] ?? true;
  // `?attractTest` (development only) shortens the idle delay to a few seconds for testing.
  const idleMinutes = import.meta.env.DEV && location.search.includes('attractTest') ? 0.05 : settings?.['immersive.attractMinutes'] ?? 3;
  const [index, setIndex] = useState(0);
  const [shots, setShots] = useState<MediaItem[]>([]);
  const [highlights, setHighlights] = useState<AchievementFeedItem[]>([]);
  const liveBlock = useLiveBlock();
  const lastInput = useRef(Date.now());

  // Idle detection: any input resets the timer; a slow poll decides when to start.
  useEffect(() => {
    if (!enabled) return;
    const bump = () => {
      lastInput.current = Date.now();
    };
    const offPad = on('gamepad.button', bump);
    const offScroll = on('gamepad.scroll', bump);
    addEventListener('keydown', bump, true);
    addEventListener('pointermove', bump, true);
    addEventListener('pointerdown', bump, true);
    addEventListener('wheel', bump, true);
    const poll = window.setInterval(() => {
      const idle = Date.now() - lastInput.current > idleMinutes * 60_000;
      const busy = running || document.hidden || !!document.querySelector('[data-dialog-open]') || useStore.getState().commandOpen;
      if (idle && !busy && !active) onActiveChange(true);
    }, import.meta.env.DEV && location.search.includes('attractTest') ? 500 : 5000);
    return () => {
      offPad();
      offScroll();
      removeEventListener('keydown', bump, true);
      removeEventListener('pointermove', bump, true);
      removeEventListener('pointerdown', bump, true);
      removeEventListener('wheel', bump, true);
      window.clearInterval(poll);
    };
  }, [enabled, idleMinutes, running, active, onActiveChange]);

  // While active, the first input of any kind wakes the interface — and is swallowed.
  useEffect(() => {
    if (!active) return;
    const wake = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      lastInput.current = Date.now();
      onActiveChange(false);
    };
    const popPad = pushPadHandler(() => {
      lastInput.current = Date.now();
      onActiveChange(false);
      return true;
    });
    addEventListener('keydown', wake, true);
    addEventListener('pointerdown', wake, true);
    // Small pointer jitters shouldn't wake it; a deliberate move should.
    let travelled = 0;
    const move = (e: PointerEvent) => {
      travelled += Math.abs(e.movementX) + Math.abs(e.movementY);
      if (travelled > 40) wake(e);
    };
    addEventListener('pointermove', move, true);
    return () => {
      popPad();
      removeEventListener('keydown', wake, true);
      removeEventListener('pointerdown', wake, true);
      removeEventListener('pointermove', move, true);
    };
  }, [active, onActiveChange]);

  // Switching to desktop mode (from anywhere: hotkey, native) ends it too.
  useEffect(() => {
    if (!active) return;
    const end = () => onActiveChange(false);
    addEventListener('vystral:mode-switch', end);
    return () => removeEventListener('vystral:mode-switch', end);
  }, [active, onActiveChange]);

  // Track L: your rare achievements become highlight slides (when the Steam Web API is set up).
  useEffect(() => {
    if (!active) return;
    let alive = true;
    call<AchievementFeed>('achievements.feed', { offset: 0, limit: 40 })
      .then((f) => alive && f?.status === 'ok' && setHighlights(highlightAchievements(f.items)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active]);

  // A game starting always ends the screensaver.
  useEffect(() => {
    if (running && active) onActiveChange(false);
  }, [running, active, onActiveChange]);

  // Screenshots from Moments (only if the user turned Moments on).
  useEffect(() => {
    if (!active || !settings?.['moments.enabled']) return;
    let alive = true;
    call<MediaItem[]>('media.list')
      .then((items) => alive && setShots(items.filter((i) => i.kind === 'image').slice(0, 60)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [active, settings]);

  const slides = useMemo<Slide[]>(() => {
    const byId = new Map(games.map((g) => [g.id, g]));
    const pool = games
      .filter((g) => isInstalled(g) || g.favorite)
      .sort((a, b) => (lastPlayed(b).at ?? '').localeCompare(lastPlayed(a).at ?? ''))
      .slice(0, 24);
    const gameSlides: Slide[] = pool.map((g) => ({
      key: `g-${g.id}`,
      game: g,
      imageUrl: null,
      caption: g.title,
      sub: lastPlayed(g).at ? `Last played ${formatRelative(lastPlayed(g).at)}` : g.genres.slice(0, 2).join(' · '),
    }));
    const shotSlides: Slide[] = shots.map((s) => ({
      key: `s-${s.url}`,
      game: s.gameId ? byId.get(s.gameId) ?? null : null,
      imageUrl: s.url,
      caption: s.gameId ? byId.get(s.gameId)?.title ?? 'Your moment' : 'Your moment',
      sub: `Captured ${formatRelative(s.modifiedAt)}`,
    }));
    const achSlides: Slide[] = highlights.map((a) => ({
      key: `a-${a.appId}-${a.apiName}`,
      game: a.gameId ? byId.get(a.gameId) ?? null : null,
      imageUrl: null,
      caption: a.name,
      sub: `${a.gameTitle} · ${a.globalPercent != null ? `${formatPercent(a.globalPercent)} of players` : 'Rare'} · ${formatRelative(a.unlockedAt)}`,
      achievement: a,
    }));
    // Interleave: two games, then one of the user's screenshots, then a highlight now and then.
    const out: Slide[] = [];
    let gi = 0;
    let si = 0;
    let ai = 0;
    while (gi < gameSlides.length || si < shotSlides.length || ai < achSlides.length) {
      if (gi < gameSlides.length) out.push(gameSlides[gi++]);
      if (gi < gameSlides.length) out.push(gameSlides[gi++]);
      if (si < shotSlides.length) out.push(shotSlides[si++]);
      if (ai < achSlides.length) out.push(achSlides[ai++]);
    }
    return out;
  }, [games, shots, highlights]);

  useEffect(() => {
    if (!active || slides.length < 2) return;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => window.clearInterval(t);
  }, [active, slides.length]);

  useEffect(() => {
    if (active) setIndex(0);
  }, [active]);

  const slide = slides[index % Math.max(1, slides.length)];
  const direction = index % 2 === 0 ? 1 : -1;

  return (
    <AnimatePresence>
      {active && slide && (
        <motion.div
          className="attract"
          role="presentation"
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.45, ease: ease.out } }}
          transition={{ duration: 1.4, ease: ease.out }}
        >
          <AnimatePresence initial={false}>
            <motion.div
              key={slide.key}
              className="attract__slide"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0.6 : 1.8, ease: ease.inOut }}
            >
              <motion.div
                className="attract__art"
                initial={reduce ? false : { scale: 1.02, x: `${-1.5 * direction}%` }}
                animate={reduce ? undefined : { scale: 1.12, x: `${1.5 * direction}%` }}
                transition={{ duration: (SLIDE_MS + 2000) / 1000, ease: 'linear' }}
              >
                {slide.imageUrl ? <img src={slide.imageUrl} alt="" /> : slide.game ? <GameCover game={slide.game} kind="hero" eager /> : null}
              </motion.div>
              {!slide.imageUrl && !slide.achievement && slide.game && !liveBlock && <AttractLoop game={slide.game} />}
            </motion.div>
          </AnimatePresence>
          <div className="attract__scrim" />
          <AnimatePresence mode="wait">
            <motion.div
              key={slide.key}
              className="attract__caption"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.9, ease: ease.out, delay: 0.5 }}
            >
              {slide.achievement ? (
                <div className="attract__ach">
                  <span className="attract__ach-icon shimmer" data-tier={shimmerTier(slide.achievement.globalPercent)}>
                    {slide.achievement.icon ? <img src={slide.achievement.icon} alt="" /> : <span aria-hidden>★</span>}
                  </span>
                  <span>
                    <span className="attract__ach-kicker">{shimmerTier(slide.achievement.globalPercent) === 'ultra' ? 'Ultra-rare achievement' : 'Rare achievement'}</span>
                    <span className="attract__title">{slide.caption}</span>
                  </span>
                </div>
              ) : slide.game?.art.logo && !slide.imageUrl ? (
                <img className="attract__logo" src={slide.game.art.logo} alt={slide.caption} />
              ) : (
                <div className="attract__title">{slide.caption}</div>
              )}
              <div className="attract__sub">{slide.sub}</div>
            </motion.div>
          </AnimatePresence>
          {slides.length > 1 && <div key={`p-${index}`} className="attract__progress" style={{ animationDuration: `${SLIDE_MS}ms` }} />}
          <AttractClock />
          <div className="attract__wake">Press any button</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function AttractClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div className="attract__clock">
      <span className="num">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      <span>{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</span>
    </div>
  );
}

/** The slide's silent micro-trailer (same rules as Home's live tiles), fading in over the still art. */
function AttractLoop({ game }: { game: Game }) {
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!game.installations.some((i) => i.platform === 'steam')) return;
    let alive = true;
    const t = window.setTimeout(() => {
      call<LiveTileInfo>('liveTile.get', { gameId: game.id }, 120_000)
        .then((i) => alive && i.src && setSrc(i.src))
        .catch(() => {});
    }, 1200);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [game]);
  if (!src) return null;
  return (
    <video
      className="attract__loop"
      data-shown={shown || undefined}
      src={src}
      muted
      loop
      playsInline
      autoPlay
      disablePictureInPicture
      tabIndex={-1}
      onPlaying={() => setShown(true)}
      onError={() => setSrc(null)}
    />
  );
}
