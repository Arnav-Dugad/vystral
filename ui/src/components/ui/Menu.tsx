import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { exit, pick, spring } from '../../lib/motion';
import { useReducedMotion } from '../../state/store';

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: ReactNode }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

/** Context menu rendered at a point; arrow keys move, Enter selects, Escape closes. */
export function Menu({ at, entries, onClose, label }: { at: { x: number; y: number } | null; entries: MenuEntry[]; onClose: () => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [pos, setPos] = useState(at);
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useLayoutEffect(() => {
    if (!at || !ref.current) return setPos(at);
    const r = ref.current.getBoundingClientRect();
    setPos({ x: Math.max(8, Math.min(at.x, innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - r.height - 8)) });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const previous = document.activeElement as HTMLElement | null;
    const onClose = () => onCloseRef.current();
    requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>('[role=menuitem]:not([disabled])')?.focus());
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role=menuitem]:not([disabled])') ?? [])];
      const i = items.indexOf(document.activeElement as HTMLElement);
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); onClose(); }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onClose);
      previous?.focus?.();
    };
  }, [at]);

  return createPortal(
    <AnimatePresence>
      {at && (
        <motion.div
          ref={ref}
          className="menu"
          role="menu"
          aria-label={label}
          style={{ left: pos?.x ?? at.x, top: pos?.y ?? at.y }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, transition: exit }}
          transition={pick(reduce, spring.panel)}
          data-menu-open
        >
          {entries.map((e, i) =>
            e.kind === 'separator' ? (
              <div key={i} className="menu__sep" role="separator" />
            ) : e.kind === 'label' ? (
              <div key={i} className="menu__label caps">
                {e.label}
              </div>
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`menu__item ${e.danger ? 'menu__item--danger' : ''}`}
                disabled={e.disabled}
                onClick={() => {
                  onClose();
                  e.onSelect();
                }}
              >
                {e.icon}
                <span style={{ flex: 1 }}>{e.label}</span>
                {e.hint}
              </button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
