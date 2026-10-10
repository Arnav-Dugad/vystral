import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Clapperboard, Play, Square, Volume2, VolumeX } from 'lucide-react';
import { isNative } from '../../bridge/bridge';
import type { TrailerInfo } from '../../bridge/types';
import { exit, spring } from '../../lib/motion';
import { IDLE_DELAY_MS } from '../../lib/trailer/policy';
import { youTubeEmbedSrc, youTubeMessage, YOUTUBE_ORIGIN } from '../../lib/trailer/youtube';

/**
 * Track D4: a YouTube trailer (from IGDB or GOG) in the detail hero — only with "Allow YouTube trailers" on, which the
 * host also enforces for every frame. The frame is youtube-nocookie.com, sandboxed without top navigation, popups or
 * forms, muted, without YouTube's own controls (VYSTRAL's play/stop and sound buttons drive it through YouTube's
 * documented iframe messages), and removed when it ends. It autoplays muted only under the same rules as Steam
 * trailers (idle, visible, not reduced motion, autoplay on); otherwise it waits for a click. The browser preview never
 * loads YouTube: it shows a local stand-in.
 */
export function YouTubeTrailer({ info, hero, autoBlocked, blocked, inView, reduce }: {
  info: TrailerInfo; hero: HTMLElement | null; autoBlocked: string | null; blocked: string | null; inView: boolean; reduce: boolean;
}) {
  const [on, setOn] = useState(false);
  const [shown, setShown] = useState(false);
  const [muted, setMuted] = useState(true);
  const [played, setPlayed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const embed = info.src ? youTubeEmbedSrc(info.src, window.location.origin) : null;

  const stop = useCallback(() => {
    setShown(false);
    window.setTimeout(() => setOn(false), reduce ? 150 : 700);
  }, [reduce]);

  // Hard stops (Offline, Data saver, a game starting, hidden…) remove the frame entirely.
  useEffect(() => {
    if (blocked && on) {
      setShown(false);
      setOn(false);
    }
  }, [blocked, on]);

  // Idle autoplay, once per visit, under the same rules as Steam trailers.
  useEffect(() => {
    if (on || played || autoBlocked || !inView) return;
    const t = window.setTimeout(() => {
      setOn(true);
      setPlayed(true);
    }, IDLE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [on, played, autoBlocked, inView]);

  // The player's state comes back as messages from its own origin and window only.
  useEffect(() => {
    if (!on || !isNative) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== YOUTUBE_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const msg = youTubeMessage(e.data);
      if (msg === 'playing') setShown(true);
      if (msg === 'ended') stop();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [on, stop]);

  // The preview's stand-in fades in like the real player would.
  useEffect(() => {
    if (!on || isNative) return;
    const t = window.setTimeout(() => setShown(true), 300);
    return () => window.clearTimeout(t);
  }, [on]);

  const command = (func: 'mute' | 'unMute') =>
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args: [] }), YOUTUBE_ORIGIN);

  const onLoad = () => {
    // Ask the player to report its state (YouTube's iframe API handshake).
    frame.current?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 'vystral', channel: 'widget' }), YOUTUBE_ORIGIN);
    window.setTimeout(() => setShown(true), 600);
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    command(next ? 'mute' : 'unMute');
  };

  const controls = !blocked && (
    <AnimatePresence>
      <motion.div className="htrailer-ctl" role="group" aria-label="Trailer" data-testid="youtube-trailer-controls"
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: exit }}
        transition={reduce ? { duration: 0.15 } : spring.panel}>
        <span className="htrailer-ctl__label">
          <Clapperboard size={13} aria-hidden />
          <span>Trailer</span>
          <span className="htrailer-ctl__src">from {info.source} · YouTube</span>
        </span>
        <button type="button" className="htrailer-ctl__btn" onClick={() => (on ? stop() : (setOn(true), setPlayed(true)))}
          aria-label={on ? 'Stop trailer' : 'Play trailer (from YouTube)'} title={on ? 'Stop' : 'Play'}>
          {on ? <Square size={13} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </button>
        {on && (
          <button type="button" className="htrailer-ctl__btn" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Turn trailer sound on' : 'Mute trailer'} title={muted ? 'Sound on' : 'Mute'}>
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        )}
      </motion.div>
    </AnimatePresence>
  );

  return (
    <div className="htrailer" aria-hidden>
      {on && embed && (
        <motion.div className="htrailer__yt" initial={false} animate={{ opacity: shown ? 1 : 0 }} transition={reduce ? { duration: 0.15 } : { duration: 0.9 }}>
          {isNative ? (
            <iframe
              ref={frame}
              className="htrailer__frame"
              src={embed}
              title={info.name ? `Trailer: ${info.name} (YouTube)` : 'Trailer (YouTube)'}
              // Scripts and its own origin are what the player needs; no top navigation, popups, forms or downloads.
              sandbox="allow-scripts allow-same-origin allow-presentation"
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              loading="lazy"
              tabIndex={-1}
              onLoad={onLoad}
            />
          ) : (
            <div className="htrailer__ytpreview" data-testid="youtube-preview-standin">
              <Clapperboard size={28} aria-hidden />
              <span>YouTube trailer (the preview never contacts YouTube)</span>
            </div>
          )}
        </motion.div>
      )}
      {hero && controls && createPortal(controls, hero)}
    </div>
  );
}
