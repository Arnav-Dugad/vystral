import { AnimatePresence, motion } from 'motion/react';
import { pick, spring } from '../../lib/motion';
import { useCaption } from '../../lib/useVoiceOver';
import { useReducedMotion } from '../../state/store';
import './captions.css';

/**
 * The voice-over caption (Track T): a subtitle bar near the bottom of the screen with the words
 * being spoken (or, captions only, the words that would be). Hidden from assistive technology —
 * the same information is already in the page for screen readers — so nothing is read twice.
 * High contrast: solid black, white text, a white edge.
 */
export function CaptionBar({ className = '' }: { className?: string }) {
  const caption = useCaption();
  const reduce = useReducedMotion();
  return (
    <div className={`captions ${className}`} aria-hidden>
      <AnimatePresence initial={false}>
        {caption && (
          <motion.div
            key={caption.id}
            className="captions__bar"
            data-kind={caption.kind}
            data-speaking={caption.speaking || undefined}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: caption.speaking ? 1 : 0.86, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.18 } }}
            transition={pick(reduce, spring.panel)}
          >
            <span className="captions__wave" aria-hidden>
              <i /><i /><i />
            </span>
            <span className="captions__text">{caption.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
