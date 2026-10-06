import { animate, motionValue, type MotionValue } from 'motion/react';

/**
 * The hero stage's depth "lean" (Track L): each D-pad move nudges the backdrop layers a little
 * against the direction of travel and springs them back, so the art feels like it has depth.
 * Deeper layers move more. Two shared motion values; layers derive their own offset from them.
 */
export const leanX: MotionValue<number> = motionValue(0);
export const leanY: MotionValue<number> = motionValue(0);

const NUDGE = { type: 'spring', stiffness: 420, damping: 30 } as const;
const SETTLE = { type: 'spring', stiffness: 120, damping: 18 } as const;
let back: number | undefined;

/** dx/dy are −1, 0 or 1 (the D-pad direction). Off under reduced motion (the caller checks). */
export function nudge(dx: number, dy: number) {
  window.clearTimeout(back);
  // The layers lean against the direction you move, like a camera panning past them.
  animate(leanX, -dx, NUDGE);
  animate(leanY, -dy, NUDGE);
  back = window.setTimeout(() => {
    animate(leanX, 0, SETTLE);
    animate(leanY, 0, SETTLE);
  }, 150);
}

/** Pixel offset for a layer at `depth` (0 = flat, 1 = deepest). */
export const layerOffset = (lean: number, depth: number, range: number) => lean * depth * range;
