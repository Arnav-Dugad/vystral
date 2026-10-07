import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { call, on } from '../../bridge/bridge';
import type { AchievementFeed, AchievementFeedItem, Game, MediaItem } from '../../bridge/types';
import { useLiveBlock } from '../../components/game/LiveTile';
import { formatPercent } from '../../lib/achievements';
import { shimmerTier } from '../../lib/shimmer';
import '../../components/ui/shimmer.css';
import { highlightAchievements } from './attractSlides';
import { formatDuration, formatRelative, lastPlayed } from '../../lib/format';
import { pushPadHandler } from '../../lib/input';
import { ease } from '../../lib/motion';
import { paletteFor, peekPalette, titleHue } from '../../lib/palette';
import { useGameRunning, useReducedMotion, useStore } from '../../state/store';
import { GameCover } from '../../components/game/GameCover';
import { PadHint } from '../../components/ui/primitives';
import { BigClock, CornerClock } from './BigClock';
import { loopFor } from './loopSource';
import { showcaseKicker, showcasePool, trailerMode, type ShowcaseReason, type TrailerMode } from './screensaver';
import { playedSeconds } from './rows';
import { useSystemStatus } from './useSystemStatus';
import './attract.css';

interface Slide {
  key: string;
  game: Game | null;
  imageUrl: string | null;
  caption: string;
  sub: string;
  /** Track Z: why this game is showcased ("It's been a while", "Still waiting for you"). */
  reason?: ShowcaseReason;
  /** Track L: an achievement highlight (a rare unlock of yours) instead of plain art. */
  achievement?: AchievementFeedItem;
}

/** `?attractTest` (development only): starts after a few seconds and moves through slides quickly. */
const TEST = import.meta.env.DEV && typeof location !== 'undefined' && location.search.includes('attractTest');
const SLIDE_MS = TEST ? 4500 : 10_000;

/** "Last played 8 months ago · 42 h played", or how long it has waited. */
function showcaseLine(g: Game, reason: ShowcaseReason | undefined): string {
  const at = lastPlayed(g).at;
  const played = playedSeconds(g);
  if (!at) return reason === 'waiting' ? `In your library since ${formatRelative(g.added)} · not started yet` : g.genres.slice(0, 2).join(' · ');
  return [`Last played ${formatRelative(at)}`, played >= 3600 ? `${formatDuration(played)} played` : ''].filter(Boolean).join(' · ');
}

/**
 * Attract mode: after a few idle minutes in Immersive, a slow screensaver. Track Z: it showcases
 * games you haven't touched in a while with their silent trailer loops (live-tile rules; never on
 * Data saver or Low quality, paused on battery saver; Ken Burns stills otherwise), your
 * screenshots and rare achievements, and optionally a big clock for TVs. The first input only
 * wakes it and never also acts on the interface underneath, which never unmounted, so you're
 * exactly where you were — except A (or Enter) on a showcased game, which opens its page.
 */
export function AttractMode({
  games,
  active,
  onActiveChange,
  onOpen,
}: {
  games: Game[];
  active: boolean;
  onActiveChange: (v: boolean) => void;
  /** A on a showcased game: open its page (the screensaver has already closed). */
  onOpen?: (game: Game) => void;
}) {
  const settings = useStore((s) => s.settings);
  const running = useGameRunning();
  const reduce = useReducedMotion();
  const enabled = settings?.['immersive.attract'] ?? true;
  const idleMinutes = TEST ? 0.05 : settings?.['immersive.attractMinutes'] ?? 3;
  const bigClock = !!settings?.['immersive.attractClock'];
  const [index, setIndex] = useState(0);
  const [shots, setShots] = useState<MediaItem[]>([]);
  const [highlights, setHighlights] = useState<AchievementFeedItem[]>([]);
  const liveBlock = useLiveBlock();
  const status = useSystemStatus();
  const hour12 = status?.clock24h == null ? null : !status.clock24h;
  const mode: TrailerMode = trailerMode({ enabled: settings?.['immersive.attractTrailers'] ?? true, liveBlock, batterySaver: !!status?.battery?.saver });
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
    }, TEST ? 500 : 5000);
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

  // The pool is fixed for the length of one screensaver (it's rebuilt the next time it starts).
  const [startedAt, setStartedAt] = useState(() => Date.now());
  useEffect(() => {
    if (active) {
      setStartedAt(Date.now());
      setIndex(0);
    }
  }, [active]);

  const slides = useMemo<Slide[]>(() => {
    const byId = new Map(games.map((g) => [g.id, g]));
    const gameSlides: Slide[] = showcasePool(games, startedAt).map(({ game: g, reason }) => ({
      key: `g-${g.id}`,
      game: g,
      imageUrl: null,
      caption: g.title,
      sub: showcaseLine(g, reason),
      reason,
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
  }, [games, shots, highlights, startedAt]);

  useEffect(() => {
    if (!active || slides.length < 2) return;
    const t = window.setInterval(() => setIndex((i) => (i + 1) % slides.length), SLIDE_MS);
    return () => window.clearInterval(t);
  }, [active, slides.length]);

  const slide = slides[index % Math.max(1, slides.length)];
  const next = slides.length > 1 ? slides[(index + 1) % slides.length] : null;
  const direction = index % 2 === 0 ? 1 : -1;
  const slideRef = useRef(slide);
  slideRef.current = slide;

  // While active, the first input of any kind wakes the interface and is swallowed. A (or Enter)
  // on a showcased game also opens its page.
  useEffect(() => {
    if (!active) return;
    const close = (open: boolean) => {
      lastInput.current = Date.now();
      onActiveChange(false);
      const g = slideRef.current?.game;
      if (open && g && onOpen) onOpen(g);
    };
    const wake = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const key = e instanceof KeyboardEvent ? e.key : '';
      close(key === 'Enter' || key === ' ');
    };
    const popPad = pushPadHandler((b) => {
      close(b === 'A');
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
  }, [active, onActiveChange, onOpen]);

  // Switching to desktop mode (from anywhere: hotkey, native) ends it too.
  useEffect(() => {
    if (!active) return;
    const end = () => onActiveChange(false);
    addEventListener('vystral:mode-switch', end);
    return () => removeEventListener('vystral:mode-switch', end);
  }, [active, onActiveChange]);

  // The next slide's trailer is looked up ahead of time, so its crossfade starts on cue.
  useEffect(() => {
    if (!active || mode !== 'play' || !next?.game || next.imageUrl || next.achievement) return;
    if (next.game.installations.some((i) => i.platform === 'steam')) void loopFor(next.game.id);
  }, [active, mode, next]);

  // The big clock's glow takes the showcased game's colour.
  const [tint, setTint] = useState<string>('oklch(0.75 0.15 292)');
  const tintGame = slide?.game ?? null;
  useEffect(() => {
    if (!active || !bigClock || !tintGame) return;
    const peek = peekPalette(tintGame);
    if (peek) {
      setTint(peek.accent);
      return;
    }
    setTint(`oklch(0.75 0.15 ${titleHue(tintGame.title)})`);
    let alive = true;
    void paletteFor(tintGame).then((p) => alive && setTint(p.accent)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [active, bigClock, tintGame]);

  const kicker = slide?.reason ? showcaseKicker(slide.reason) : null;
  const showsGame = !!slide?.game && !!onOpen;

  return (
    <AnimatePresence>
      {active && slide && (
        <motion.div
          className="attract"
          role="presentation"
          aria-hidden
          data-clock={bigClock || undefined}
          data-trailers={mode}
          data-slide-game={slide.game?.id}
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
              {!slide.imageUrl && !slide.achievement && slide.game && mode !== 'off' && <AttractLoop game={slide.game} mode={mode} />}
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
              ) : (
                <>
                  {kicker && <div className="attract__kicker">{kicker}</div>}
                  {slide.game?.art.logo && !slide.imageUrl ? (
                    <img className="attract__logo" src={slide.game.art.logo} alt={slide.caption} />
                  ) : (
                    <div className="attract__title">{slide.caption}</div>
                  )}
                </>
              )}
              <div className="attract__sub">{slide.sub}</div>
            </motion.div>
          </AnimatePresence>
          {slides.length > 1 && <div key={`p-${index}`} className="attract__progress" style={{ animationDuration: `${SLIDE_MS}ms` }} />}
          {bigClock ? <BigClock tint={tint} hour12={hour12} /> : <CornerClock hour12={hour12} />}
          <div className="attract__wake">
            {showsGame && <PadHint button="A">View game</PadHint>}
            <span className="attract__wake-any">Any button to return</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The slide's silent micro-trailer (live-tile pipeline), crossfading in over the still art once it
 * plays. `pause` (battery saver) holds the frame on screen and starts nothing new.
 */
function AttractLoop({ game, mode }: { game: Game; mode: Exclude<TrailerMode, 'off'> }) {
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const steam = game.installations.some((i) => i.platform === 'steam');
  useEffect(() => {
    if (!steam || mode !== 'play' || src) return;
    let alive = true;
    // A beat after the slide arrives, so the still art lands first.
    const t = window.setTimeout(() => {
      void loopFor(game.id).then((s) => alive && s && setSrc(s));
    }, 900);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [game.id, steam, mode, src]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (mode === 'pause') v.pause();
    else void v.play().catch(() => undefined);
  }, [mode, src]);
  if (!src) return null;
  return (
    <video
      ref={video}
      className="attract__loop"
      data-shown={shown || undefined}
      data-paused={mode === 'pause' || undefined}
      src={src}
      muted
      loop
      playsInline
      autoPlay={mode === 'play'}
      preload="auto"
      disablePictureInPicture
      disableRemotePlayback
      tabIndex={-1}
      onPlaying={() => setShown(true)}
      onError={() => setSrc(null)}
    />
  );
}
