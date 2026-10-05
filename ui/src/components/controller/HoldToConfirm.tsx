import { forwardRef, useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AnimatePresence, motion, useTransform, type MotionValue } from 'motion/react';
import { Check } from 'lucide-react';
import { ease } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';
import { useHoldToConfirm, type HoldOptions } from './useHoldToConfirm';
import './controller.css';

type HoldButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'> & HoldOptions & {
  children?: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Drawn inside the ring. */
  icon?: ReactNode;
  loading?: boolean;
  /** No button styling: the caller styles it (e.g. an icon-only title-bar control). */
  bare?: boolean;
};

/**
 * A button for destructive-looking actions that confirms only after a ~0.9 s hold, with a
 * radial ring that fills as you hold. See {@link useHoldToConfirm} for the input rules.
 */
export const HoldToConfirm = forwardRef<HTMLButtonElement, HoldButtonProps>(function HoldToConfirm(
  { onConfirm, holdFor = 'all', durationMs, disabled, children, variant = 'danger', size = 'md', icon, loading, bare, className = '', ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  const hintId = useId();
  const { progress, phase, nudge, bind } = useHoldToConfirm({ onConfirm, holdFor, durationMs, disabled: disabled || loading });
  // A too-short press shows "Hold to confirm" in place of the label for a moment.
  const [seenNudge, setSeenNudge] = useState(0);
  const hinting = nudge > seenNudge;
  useEffect(() => {
    if (!nudge) return;
    const t = window.setTimeout(() => setSeenNudge(nudge), 1600);
    return () => window.clearTimeout(t);
  }, [nudge]);

  const overlay = bare || holdFor === 'pad';
  const hint = holdFor === 'pad' ? 'Hold A to confirm' : 'Hold to confirm';
  const classes = bare
    ? `hold hold--bare ${className}`
    : `btn btn--${variant} ${size !== 'md' ? `btn--${size}` : ''} hold ${className}`;

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      data-hold={phase}
      data-hold-for={holdFor}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      aria-describedby={hintId}
      disabled={disabled || loading}
      {...rest}
      {...bind}
    >
      <motion.span className="hold__wash" aria-hidden style={{ scaleX: progress }} />
      <motion.span
        key={nudge}
        className="hold__content"
        initial={nudge && !reduce ? { x: 0 } : false}
        animate={nudge && !reduce ? { x: [0, -5, 5, -3, 2, 0] } : { x: 0 }}
        transition={{ duration: 0.38, ease: ease.out }}
      >
        {!overlay && <HoldRing progress={progress} done={phase === 'done'} icon={icon} reduce={reduce} />}
        {overlay && icon}
        {children != null && (
          <span className="hold__label">
            <span data-shown={!hinting}>{children}</span>
            <span data-shown={hinting} aria-hidden>{hint}</span>
          </span>
        )}
      </motion.span>
      {overlay && (
        <span className="hold__overlay" data-visible={phase !== 'idle'} aria-hidden>
          <HoldRing progress={progress} done={phase === 'done'} reduce={reduce} />
        </span>
      )}
      <span id={hintId} className="visually-hidden">
        {holdFor === 'pad' ? 'With a controller, hold A to confirm.' : 'Press and hold to confirm.'}
      </span>
      <span className="visually-hidden" aria-live="polite">{hinting ? `${hint}.` : ''}</span>
      {loading && (
        <span className="btn__spinner">
          <span className="spinner" />
        </span>
      )}
    </button>
  );
});

function HoldRing({ progress, done, icon, reduce }: { progress: MotionValue<number>; done: boolean; icon?: ReactNode; reduce: boolean }) {
  // A zero-length round-capped stroke still draws a dot; hide the arc until it has length.
  const visible = useTransform(progress, (v) => (v > 0.004 ? 1 : 0));
  return (
    <span className="hold__ring" data-done={done} aria-hidden>
      <svg viewBox="0 0 24 24" className="hold__svg">
        <circle className="hold__track" cx="12" cy="12" r="10" />
        <motion.circle className="hold__fill" cx="12" cy="12" r="10" style={{ pathLength: progress, opacity: visible }} />
      </svg>
      <span className="hold__glyph">
        <AnimatePresence initial={false} mode="popLayout">
          {done ? (
            <motion.span
              key="done"
              className="hold__glyph-in"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={reduce ? { duration: 0.12 } : { type: 'spring', visualDuration: 0.28, bounce: 0.45 }}
            >
              <Check size={12} strokeWidth={3} />
            </motion.span>
          ) : (
            icon && (
              <motion.span key="icon" className="hold__glyph-in" exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.1 } }}>
                {icon}
              </motion.span>
            )
          )}
        </AnimatePresence>
      </span>
    </span>
  );
}
