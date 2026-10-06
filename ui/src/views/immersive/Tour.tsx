import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Sparkles } from 'lucide-react';
import { pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { PadGlyph } from '../../components/ui/primitives';

export type TourStep = 'move' | 'sections' | 'quick' | 'search';
export const TOUR_STEPS: readonly TourStep[] = ['move', 'sections', 'quick', 'search'];

/** The first step not done yet, or null when every step is done. */
export function nextTourStep(done: ReadonlySet<TourStep>): TourStep | null {
  return TOUR_STEPS.find((s) => !done.has(s)) ?? null;
}

const COPY: Record<TourStep, { title: string; body: React.ReactNode }> = {
  move: { title: 'Look around', body: <>Move with the D-pad, the left stick or the arrow keys.</> },
  sections: { title: 'Switch sections', body: <>Press <PadGlyph button="LB" /> <PadGlyph button="RB" /> (or Q / E) for Home and All games.</> },
  quick: { title: 'Quick actions', body: <>Hold <PadGlyph button="X" /> or press <PadGlyph button="View" /> (or M) on a game: play, favourite, status, store page.</> },
  search: { title: 'Find anything', body: <>Press <PadGlyph button="Y" /> to search, <PadGlyph button="A" /> to open a game.</> },
};

/**
 * A short first-run tour of Immersive (Track L). It never blocks anything: each card waits for
 * you to actually do the thing, then moves on. Shown once; B (or Skip) ends it at any point.
 */
export function Tour({ done, onFinish }: { done: ReadonlySet<TourStep>; onFinish: () => void }) {
  const reduce = useReducedMotion();
  const step = nextTourStep(done);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (step) return;
    setClosing(true);
    const t = window.setTimeout(onFinish, 1800);
    return () => window.clearTimeout(t);
  }, [step, onFinish]);

  const index = step ? TOUR_STEPS.indexOf(step) : TOUR_STEPS.length;
  return (
    <section className="imm-tour" aria-label="Immersive Mode tour" aria-live="polite">
      <AnimatePresence mode="wait" initial={!reduce}>
        <motion.div
          key={step ?? 'done'}
          className="imm-tour__card"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8, transition: { duration: 0.14 } }}
          transition={pick(reduce, spring.panel)}
        >
          <Sparkles className="imm-tour__icon" size="1.2em" aria-hidden />
          <div className="imm-tour__text">
            <strong>{step ? COPY[step].title : 'You’re all set'}</strong>
            <span>{step ? COPY[step].body : 'Enjoy the couch. F11 or Menu returns to desktop mode.'}</span>
          </div>
          <ol className="imm-tour__dots" aria-label={`Step ${Math.min(index + 1, TOUR_STEPS.length)} of ${TOUR_STEPS.length}`}>
            {TOUR_STEPS.map((s, i) => (
              <li key={s} data-state={done.has(s) ? 'done' : i === index ? 'current' : 'todo'} />
            ))}
          </ol>
          {!closing && (
            <button type="button" className="imm-tour__skip" onClick={onFinish}>
              <PadGlyph button="B" /> Skip tour
            </button>
          )}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
