import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { exit, pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal: focus moves in on open and returns on close, Tab cycles inside,
 * Escape (or controller B, which maps to Escape) always closes.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  wide,
  describedBy,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  describedBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      first?.focus();
    }, 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: exit }}
          transition={pick(reduce, spring.effect)}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
          data-dialog-open
        >
          <motion.div
            ref={ref}
            className={`dialog ${wide ? 'dialog--wide' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            aria-describedby={describedBy}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98, transition: exit }}
            transition={pick(reduce, spring.panel)}
          >
            <h2 id="dialog-title" className="dialog__title">
              {title}
            </h2>
            {children && <div className="dialog__body">{children}</div>}
            {actions && <div className="dialog__actions">{actions}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
