import type { Transition } from 'motion/react';

/**
 * VYSTRAL motion tokens. Spatial movement uses springs (interruptible, velocity-preserving);
 * opacity/colour use critically damped springs that never bounce. Exits are faster than
 * entrances. See docs/DESIGN-SYSTEM.md → Motion.
 */
export const spring = {
  /** Hover/press feedback, ~120ms. */
  micro: { type: 'spring', stiffness: 1400, damping: 67 } satisfies Transition,
  /** Focus ring/scale; must keep up with 8–10Hz controller repeat. */
  focus: { type: 'spring', visualDuration: 0.22, bounce: 0.12 } satisfies Transition,
  /** Drawers, menus, sheets. */
  panel: { type: 'spring', visualDuration: 0.32, bounce: 0.06 } satisfies Transition,
  /** Page-level spatial changes (~440ms). */
  page: { type: 'spring', stiffness: 380, damping: 31 } satisfies Transition,
  /** Shared-element hero transitions. */
  hero: { type: 'spring', visualDuration: 0.5, bounce: 0.15 } satisfies Transition,
  /** Opacity and colour — critically damped. */
  effect: { type: 'spring', stiffness: 1600, damping: 80 } satisfies Transition,
} as const;

export const ease = {
  out: [0.33, 0, 0.1, 1] as const,
  emph: [0.1, 0.9, 0.2, 1] as const,
  in: [0.8, 0, 0.78, 1] as const,
  cinematic: [0.16, 1, 0.3, 1] as const,
};

export const exit: Transition = { duration: 0.16, ease: ease.in };

/** Reduced-motion replacement: a short cross-fade, no spatial movement. */
export const reduced: Transition = { duration: 0.15, ease: 'linear' };

export function pick(reduce: boolean, t: Transition): Transition {
  return reduce ? reduced : t;
}
