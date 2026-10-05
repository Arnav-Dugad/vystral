import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Clapperboard, Pause, Play, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { call } from '../../bridge/bridge';
import type { Game, TrailerInfo } from '../../bridge/types';
import { ease, exit, spring } from '../../lib/motion';
import { attachHlsTrailer, type AttachedTrailer } from '../../lib/trailer/player';
import { autoplayBlock, effectiveQuality, IDLE_DELAY_MS, manualBlock, MAX_PLAYS, maxTrailerHeight, type TrailerConditions } from '../../lib/trailer/policy';
import { followAllowed, SAMPLE_H, SAMPLE_INTERVAL_MS, SAMPLE_W, tintFromFrame, useHeroTrailer } from '../../lib/trailer/tint';
import { useReducedMotion, useStore } from '../../state/store';
import './trailer.css';

type Phase = 'waiting' | 'loading' | 'playing' | 'paused' | 'ended' | 'failed';

function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);
  return hidden;
}

/**
 * A muted Steam trailer that crossfades in over the detail hero art after the page has been
 * visible and idle for 2.5 s, plays once plus one loop, then fades back to the art. It never
 * starts (and nothing is downloaded) under Data saver, Offline mode, reduced motion, low
 * quality, safe mode, while a game is starting or running, or while VYSTRAL is hidden.
 * Moving the pointer out of the hero pauses it on desktop; hovering back resumes.
 *
 * While it is visibly playing it also lends its colours to the Living Canvas: a 32×18 copy of
 * the frame is read ~3×/s and published through lib/trailer/tint.ts (off under reduced motion,
 * low quality, with the Living Canvas or "Follow trailer colours" off, and when hidden).
 */
export function HeroTrailer({ game, active }: { game: Game; active: boolean }) {
  const settings = useStore((s) => s.settings);
  const safeMode = useStore((s) => !!s.info?.safeMode);
  const mode = useStore((s) => s.window.mode);
  const gameActive = useStore((s) => !!s.launch && ['validating', 'starting', 'waiting', 'running'].includes(s.launch.phase));
  const reduce = useReducedMotion();
  const hidden = usePageHidden();

  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hero, setHero] = useState<HTMLElement | null>(null);
  const [info, setInfo] = useState<TrailerInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [shown, setShown] = useState(false);
  const [muted, setMuted] = useState(true);
  const [hasAudio, setHasAudio] = useState(false);
  const [inView, setInView] = useState(true);

  const attached = useRef<AttachedTrailer | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const plays = useRef(0);
  const pausedBy = useRef<'pointer' | 'hidden' | 'user' | null>(null);
  const pointerInside = useRef(false);

  const cond: TrailerConditions = {
    active,
    autoplay: settings?.['trailers.autoplay'] ?? true,
    dataSaver: !!settings?.['dataSaver.enabled'],
    offline: !!settings?.['privacy.localOnly'],
    reducedMotion: reduce,
    quality: effectiveQuality(settings?.['appearance.quality'], typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 8),
    gameActive,
    hidden,
    safeMode,
  };
  const blocked = manualBlock(cond);
  const autoBlocked = autoplayBlock(cond);

  useEffect(() => {
    setHero(rootRef.current?.closest<HTMLElement>('.dhero') ?? null);
  }, []);

  /* ------------------------------------------------------------ lifecycle */

  const teardown = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    attached.current?.destroy();
    attached.current = null;
    setShown(false);
  }, []);

  // New game: forget everything.
  useEffect(() => {
    setInfo(null);
    setPhase('waiting');
    setHasAudio(false);
    plays.current = 0;
    pausedBy.current = null;
    return teardown;
  }, [game.id, teardown]);

  // Ask the host about the trailer only when it could play at all (no lookups under Data saver/Offline).
  const dataSaverSetting = !!settings?.['dataSaver.enabled'];
  const meteredSetting = !!settings?.['dataSaver.onMetered'];
  useEffect(() => {
    if (blocked && blocked !== 'hidden') return;
    let alive = true;
    call<TrailerInfo>('trailer.get', { gameId: game.id })
      .then((t) => alive && setInfo(t))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
    // Re-ask when the network-related settings change (e.g. Data saver turned off).
  }, [game.id, blocked === null || blocked === 'hidden', dataSaverSetting, meteredSetting]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hard stops: fade out and release the stream (a game is starting, Data saver, Offline, inactive…).
  useEffect(() => {
    if (blocked && blocked !== 'hidden' && phase !== 'waiting') {
      teardown();
      setPhase('waiting');
      plays.current = 0;
    }
  }, [blocked, phase, teardown]);

  const start = useCallback(async () => {
    const video = videoRef.current;
    if (!video || !info?.available || !info.src) return;
    teardown();
    const c = new AbortController();
    ctrl.current = c;
    setPhase('loading');
    pausedBy.current = null;
    try {
      if (info.kind === 'hls') {
        attached.current = await attachHlsTrailer(video, info.src, maxTrailerHeight(cond.quality, window.innerHeight * (window.devicePixelRatio || 1)), c.signal);
      } else {
        // The media host answers with CORS headers; asking for them keeps frames readable for colour sampling.
        video.crossOrigin = 'anonymous';
        video.src = info.src;
        attached.current = { hasAudio: true, canLoop: () => true, destroy: () => { video.removeAttribute('src'); video.load(); } };
      }
      if (c.signal.aborted) return;
      setHasAudio(attached.current.hasAudio);
      plays.current = 1;
      video.muted = muted;
      video.volume = 0.7;
      await video.play();
    } catch (err) {
      if (c.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      console.warn('[trailer] could not play', err);
      teardown();
      setPhase('failed');
    }
  }, [info, teardown, muted, cond.quality]);

  /* ------------------------------------------------------------ idle autoplay */

  useEffect(() => {
    if (!hero || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setInView(e.intersectionRatio >= 0.5), { threshold: [0, 0.5, 1] });
    io.observe(hero);
    return () => io.disconnect();
  }, [hero]);

  const [idleKey, setIdleKey] = useState(0);
  useEffect(() => {
    // Activity elsewhere on the page restarts the idle clock; hovering or focusing the hero counts as interest.
    const bump = (e: Event) => {
      if (hero && e.target instanceof Node && hero.contains(e.target) && e.type !== 'wheel') return;
      setIdleKey((k) => k + 1);
    };
    const opts = { passive: true, capture: true } as const;
    window.addEventListener('wheel', bump, opts);
    window.addEventListener('keydown', bump, opts);
    window.addEventListener('pointerdown', bump, opts);
    return () => {
      window.removeEventListener('wheel', bump, opts);
      window.removeEventListener('keydown', bump, opts);
      window.removeEventListener('pointerdown', bump, opts);
    };
  }, [hero]);

  useEffect(() => {
    if (phase !== 'waiting' || autoBlocked || !info?.available || !inView) return;
    const t = window.setTimeout(() => void start(), IDLE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [phase, autoBlocked, info, inView, idleKey, start]);

  /* ------------------------------------------------------------ pause rules */

  // Window hidden (minimized/suspended): pause, and resume when visible again.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (hidden && phase === 'playing') {
      pausedBy.current = 'hidden';
      v.pause();
    } else if (!hidden && phase === 'paused' && pausedBy.current === 'hidden') {
      pausedBy.current = null;
      void v.play().catch(() => {});
    }
  }, [hidden, phase]);

  // Pointer leaving the hero pauses on desktop; coming back resumes.
  useEffect(() => {
    if (!hero || mode !== 'desktop') return;
    const enter = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      pointerInside.current = true;
      const v = videoRef.current;
      if (v && pausedBy.current === 'pointer') {
        pausedBy.current = null;
        void v.play().catch(() => {});
      }
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const was = pointerInside.current;
      pointerInside.current = false;
      const v = videoRef.current;
      if (was && v && !v.paused) {
        pausedBy.current = 'pointer';
        v.pause();
      }
    };
    hero.addEventListener('pointerenter', enter);
    hero.addEventListener('pointerleave', leave);
    return () => {
      hero.removeEventListener('pointerenter', enter);
      hero.removeEventListener('pointerleave', leave);
    };
  }, [hero, mode]);

  /* ------------------------------------------------------------ media events */

  const shownRef = useRef(shown);
  shownRef.current = shown;

  const finish = useCallback(() => {
    setShown(false);
    setPhase('ended');
    // Release the stream after the fade so the art is never left blank.
    window.setTimeout(() => {
      if (!shownRef.current) {
        ctrl.current?.abort();
        ctrl.current = null;
        attached.current?.destroy();
        attached.current = null;
      }
    }, 1000);
  }, []);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let stall: number | undefined;
    const onPlaying = () => {
      window.clearTimeout(stall);
      setPhase('playing');
      setShown(true);
    };
    const onPause = () => {
      if (!v.ended && v.currentTime > 0) setPhase((p) => (p === 'playing' ? 'paused' : p));
    };
    const onEnded = () => {
      if (plays.current < MAX_PLAYS && attached.current?.canLoop()) {
        plays.current++;
        v.currentTime = 0;
        void v.play().catch(finish);
      } else finish();
    };
    const onWaiting = () => {
      window.clearTimeout(stall);
      stall = window.setTimeout(() => {
        console.warn('[trailer] stalled; returning to artwork');
        finish();
      }, 8000);
    };
    const onError = () => {
      if (v.getAttribute('src')) finish();
    };
    v.addEventListener('playing', onPlaying);
    v.addEventListener('pause', onPause);
    v.addEventListener('ended', onEnded);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('error', onError);
    return () => {
      window.clearTimeout(stall);
      v.removeEventListener('playing', onPlaying);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('ended', onEnded);
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('error', onError);
    };
  }, [finish]);

  /* ------------------------------------------------------------ colours for the Living Canvas */

  const setVisible = useHeroTrailer((s) => s.setVisible);
  const setTint = useHeroTrailer((s) => s.setTint);
  useEffect(() => {
    setVisible(game.id, shown);
    return () => setVisible(game.id, false);
  }, [game.id, shown, setVisible]);

  const follow =
    phase === 'playing' &&
    shown &&
    inView &&
    followAllowed({
      setting: settings?.['canvas.followTrailer'],
      livingCanvas: !!settings?.['appearance.livingCanvas'],
      quality: effectiveQuality(settings?.['appearance.quality'], typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 8),
      reducedMotion: reduce,
      safeMode,
      hidden,
    });
  useEffect(() => {
    const video = videoRef.current;
    if (!follow || !video) return;
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_W;
    canvas.height = SAMPLE_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    if (!ctx) return;
    let stopped = false;
    const sample = () => {
      if (stopped || video.paused || video.readyState < 2) return;
      try {
        ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
        const target = tintFromFrame(ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data, SAMPLE_W, SAMPLE_H);
        if (target) setTint({ gameId: game.id, ...target });
      } catch (err) {
        // A cross-origin frame without CORS taints the canvas; the canvas simply keeps the artwork colours.
        stopped = true;
        setTint(null);
        console.info('[trailer] frame colours unavailable', err);
      }
    };
    sample();
    const t = window.setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(t);
      setTint(null);
    };
  }, [follow, game.id, setTint]);

  /* ------------------------------------------------------------ controls */

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (phase === 'playing') {
      pausedBy.current = 'user';
      v.pause();
    } else if (phase === 'paused') {
      pausedBy.current = null;
      void v.play().catch(() => {});
    } else {
      plays.current = 0;
      void start();
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    const next = !muted;
    setMuted(next);
    if (v) v.muted = next;
  };

  const canOffer = !!info?.available && !blocked;
  const showControls = canOffer && phase !== 'failed';
  const live = phase === 'playing' || phase === 'paused';
  const fade = reduce ? { duration: 0.15 } : { duration: phase === 'ended' ? 0.7 : 0.9, ease: ease.cinematic };

  const controls = (
    <AnimatePresence>
      {showControls && (
        <motion.div
          className="htrailer-ctl"
          role="group"
          aria-label="Trailer"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: exit }}
          transition={reduce ? { duration: 0.15 } : spring.panel}
        >
          <span className="htrailer-ctl__label">
            <Clapperboard size={13} aria-hidden />
            <span>{live ? 'Trailer' : phase === 'loading' ? 'Loading trailer…' : 'Trailer'}</span>
            <span className="htrailer-ctl__src">from Steam</span>
          </span>
          <button
            type="button"
            className="htrailer-ctl__btn"
            onClick={togglePlay}
            aria-label={phase === 'playing' ? 'Pause trailer' : phase === 'paused' ? 'Resume trailer' : phase === 'ended' ? 'Play trailer again' : 'Play trailer'}
            title={phase === 'playing' ? 'Pause' : phase === 'ended' ? 'Replay' : 'Play'}
            disabled={phase === 'loading'}
          >
            {phase === 'playing' ? <Pause size={15} fill="currentColor" /> : phase === 'ended' ? <RotateCcw size={15} /> : <Play size={15} fill="currentColor" />}
          </button>
          {live && hasAudio && (
            <button type="button" className="htrailer-ctl__btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Turn trailer sound on' : 'Mute trailer'} title={muted ? 'Sound on' : 'Mute'}>
              {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div ref={rootRef} className="htrailer" aria-hidden>
      <motion.video
        ref={videoRef}
        className="htrailer__video"
        muted
        playsInline
        preload="none"
        disablePictureInPicture
        tabIndex={-1}
        initial={false}
        animate={{ opacity: shown ? 1 : 0 }}
        transition={fade}
      />
      {hero && createPortal(controls, hero)}
    </div>
  );
}
