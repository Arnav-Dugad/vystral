import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ease } from '../../lib/motion';

/**
 * Startup sequence: about 1.2s, played once per app start, skipped by any input, and never
 * holds the app back — the interface is already loading underneath.
 */
export function Intro({ enabled }: { enabled: boolean }) {
  const [show, setShow] = useState(() => {
    try {
      return enabled && sessionStorage.getItem('vystral.introPlayed') !== '1';
    } catch {
      return enabled;
    }
  });

  useEffect(() => {
    if (!show) return;
    try {
      sessionStorage.setItem('vystral.introPlayed', '1');
    } catch {
      // ignore
    }
    const done = () => setShow(false);
    const t = window.setTimeout(done, 1500);
    window.addEventListener('keydown', done, { once: true });
    window.addEventListener('mousedown', done, { once: true });
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', done);
      window.removeEventListener('mousedown', done);
    };
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div className="intro" aria-hidden exit={{ opacity: 0, transition: { duration: 0.35, ease: ease.in } }}>
          <div>
            <motion.svg className="intro__mark" viewBox="0 0 512 512" initial={{ scale: 0.86, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.7, ease: ease.cinematic }}>
              <defs>
                <linearGradient id="iL" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stopColor="#C4B5FD" /><stop offset="1" stopColor="#6D3DF5" /></linearGradient>
                <linearGradient id="iR" x1="1" y1="0" x2="0.4" y2="1"><stop offset="0" stopColor="#9CC8FF" /><stop offset="1" stopColor="#2F5BEA" /></linearGradient>
              </defs>
              <motion.polygon points="108,124 178,124 256,312 256,410" fill="url(#iL)" initial={{ x: -40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: 0.6, ease: ease.cinematic, delay: 0.05 }} />
              <motion.polygon points="404,124 334,124 256,312 256,410" fill="url(#iR)" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: 0.6, ease: ease.cinematic, delay: 0.12 }} />
              <motion.path
                d="M256,156 C260,186 266,192 296,196 C266,200 260,206 256,236 C252,206 246,200 216,196 C246,192 252,186 256,156 Z"
                fill="#fff"
                initial={{ scale: 0, opacity: 0, rotate: -45 }}
                animate={{ scale: 1, opacity: 1, rotate: 0 }}
                style={{ transformOrigin: '256px 196px' }}
                transition={{ duration: 0.5, ease: ease.emph, delay: 0.45 }}
              />
            </motion.svg>
            <motion.div className="intro__word" initial={{ opacity: 0, letterSpacing: '0.9em' }} animate={{ opacity: 1, letterSpacing: '0.6em' }} transition={{ duration: 0.9, ease: ease.cinematic, delay: 0.3 }}>
              VYSTRAL
            </motion.div>
            <motion.div className="intro__tag" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.65, duration: 0.5 }}>
              YOUR UNIVERSE OF PLAY
            </motion.div>
          </div>
          <div className="intro__skip">Press any key to skip</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
