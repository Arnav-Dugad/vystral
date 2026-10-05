import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { on } from '../../bridge/bridge';
import { ease } from '../../lib/motion';

const PREF_KEY = 'vystral.introPref';
const PLAYED_KEY = 'vystral.introPlayed';

/**
 * Remembers whether the intro should play, so the decision can be made on the very first
 * frame (settings arrive from the native side a moment later — too late to start an intro).
 */
export function rememberIntroPreference(play: boolean) {
  try {
    localStorage.setItem(PREF_KEY, play ? '1' : '0');
  } catch {
    // storage unavailable: the default (play) applies
  }
}

function shouldPlay(): boolean {
  try {
    if (sessionStorage.getItem(PLAYED_KEY) === '1') return false;
    if (localStorage.getItem(PREF_KEY) === '0') return false;
  } catch {
    // fall through
  }
  if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  // Automated test runs set this to start from a settled interface.
  return !new URLSearchParams(location.search).has('nointro');
}

const WORD = 'VYSTRAL'.split('');

/**
 * Startup sequence (~1.6s): a light bloom, the two blades slide in and sharpen, the star
 * ignites with a flare, the wordmark resolves letter by letter. Played once per app start,
 * skipped instantly by any key, click or controller button, and never delays the app — the
 * interface keeps loading underneath.
 */
export function Intro() {
  const [show, setShow] = useState(shouldPlay);

  useEffect(() => {
    if (!show) return;
    try {
      sessionStorage.setItem(PLAYED_KEY, '1');
    } catch {
      // ignore
    }
    const done = () => setShow(false);
    // Safety cap: the sequence normally ends from the tagline's onAnimationComplete (below),
    // which keeps the timing right even when startup work delays animation frames.
    const t = window.setTimeout(done, 4500);
    const off = on('gamepad.button', (e) => e.pressed && done());
    window.addEventListener('keydown', done);
    window.addEventListener('pointerdown', done);
    return () => {
      window.clearTimeout(t);
      off();
      window.removeEventListener('keydown', done);
      window.removeEventListener('pointerdown', done);
    };
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="intro"
          aria-hidden
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.55, ease: ease.out } }}
        >
          <motion.div
            className="intro__bloom"
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: [0, 1, 0.7], scale: [0.6, 1.05, 1] }}
            exit={{ opacity: 0, scale: 2.4, transition: { duration: 0.6, ease: ease.out } }}
            transition={{ duration: 1.4, ease: ease.cinematic, times: [0, 0.55, 1] }}
          />
          <motion.div className="intro__stage" exit={{ scale: 1.08, filter: 'blur(6px)', transition: { duration: 0.5, ease: ease.in } }}>
            <svg className="intro__mark" viewBox="0 0 512 512">
              <defs>
                <linearGradient id="iL" x1="0" y1="0" x2="0.6" y2="1">
                  <stop offset="0" stopColor="#C4B5FD" />
                  <stop offset="0.45" stopColor="#9B7BFF" />
                  <stop offset="1" stopColor="#6D3DF5" />
                </linearGradient>
                <linearGradient id="iR" x1="1" y1="0" x2="0.4" y2="1">
                  <stop offset="0" stopColor="#9CC8FF" />
                  <stop offset="0.45" stopColor="#5A8CFF" />
                  <stop offset="1" stopColor="#2F5BEA" />
                </linearGradient>
                <radialGradient id="iStar" cx="0.5" cy="0.5" r="0.5">
                  <stop offset="0" stopColor="#FFFFFF" />
                  <stop offset="1" stopColor="#E6E0FF" />
                </radialGradient>
                <filter id="iGlow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="14" />
                </filter>
              </defs>
              {/* Blade glow underlay */}
              <motion.g
                filter="url(#iGlow)"
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.7 }}
                transition={{ delay: 0.35, duration: 0.8 }}
              >
                <polygon points="108,124 178,124 256,312 256,410" fill="#7C5CFF" />
                <polygon points="404,124 334,124 256,312 256,410" fill="#3D7BFF" />
              </motion.g>
              <motion.polygon
                points="108,124 178,124 256,312 256,410"
                fill="url(#iL)"
                initial={{ x: -70, y: -24, opacity: 0, filter: 'blur(10px)' }}
                animate={{ x: 0, y: 0, opacity: 1, filter: 'blur(0px)' }}
                transition={{ duration: 0.75, ease: ease.cinematic, delay: 0.08 }}
              />
              <motion.polygon
                points="404,124 334,124 256,312 256,410"
                fill="url(#iR)"
                initial={{ x: 70, y: -24, opacity: 0, filter: 'blur(10px)' }}
                animate={{ x: 0, y: 0, opacity: 1, filter: 'blur(0px)' }}
                transition={{ duration: 0.75, ease: ease.cinematic, delay: 0.16 }}
              />
              {/* Specular sweep across the blades once they land */}
              <motion.polygon
                points="108,124 120,124 256,398 256,410"
                fill="#FFFFFF"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.55, 0.28] }}
                transition={{ delay: 0.7, duration: 0.6 }}
              />
              {/* Star flare: ring burst then the four-point star */}
              <motion.circle
                cx="256"
                cy="196"
                r="30"
                fill="none"
                stroke="#D9CCFF"
                strokeWidth="3"
                initial={{ scale: 0.2, opacity: 0 }}
                animate={{ scale: [0.2, 2.6], opacity: [0, 0.9, 0] }}
                style={{ transformOrigin: '256px 196px' }}
                transition={{ delay: 0.62, duration: 0.7, ease: ease.out, times: [0, 0.2, 1] }}
              />
              <motion.circle
                cx="256"
                cy="196"
                r="34"
                fill="#B9A6FF"
                filter="url(#iGlow)"
                initial={{ opacity: 0 }}
                animate={{ opacity: [0, 0.9, 0.45] }}
                transition={{ delay: 0.6, duration: 0.8 }}
              />
              <motion.path
                d="M256,156 C260,186 266,192 296,196 C266,200 260,206 256,236 C252,206 246,200 216,196 C246,192 252,186 256,156 Z"
                fill="url(#iStar)"
                initial={{ scale: 0, opacity: 0, rotate: -90 }}
                animate={{ scale: [0, 1.35, 1], opacity: 1, rotate: 0 }}
                style={{ transformOrigin: '256px 196px' }}
                transition={{ duration: 0.65, ease: ease.emph, delay: 0.58, times: [0, 0.6, 1] }}
              />
            </svg>
            <div className="intro__word" aria-label="VYSTRAL">
              {WORD.map((ch, i) => (
                <motion.span
                  key={i}
                  initial={{ opacity: 0, y: 14, filter: 'blur(8px)' }}
                  animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                  transition={{ delay: 0.78 + i * 0.045, duration: 0.55, ease: ease.cinematic }}
                >
                  {ch}
                </motion.span>
              ))}
            </div>
            <motion.div
              className="intro__tag"
              initial={{ opacity: 0, letterSpacing: '0.42em' }}
              animate={{ opacity: 1, letterSpacing: '0.28em' }}
              transition={{ delay: 1.15, duration: 0.7, ease: ease.out }}
              onAnimationComplete={() => window.setTimeout(() => setShow(false), 650)}
            >
              YOUR UNIVERSE OF PLAY
            </motion.div>
          </motion.div>
          <motion.div className="intro__skip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9 }}>
            Press any key to skip
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
