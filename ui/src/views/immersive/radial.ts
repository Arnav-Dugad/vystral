/**
 * Geometry and D-pad selection for the Immersive quick menu (Track L): items sit on a circle,
 * item 0 at the top, clockwise. Pressing a direction selects the item nearest that direction;
 * when two are equally near it picks the one closer to the current item, and pressing the same
 * direction again steps to the other — so Right, Right walks the right-hand side top to bottom.
 */

export type RadialDir = 'up' | 'down' | 'left' | 'right';

const DIR_ANGLE: Record<RadialDir, number> = { up: -90, right: 0, down: 90, left: 180 };

/** Angle of item `i` of `n` in degrees (screen coordinates: 0 = right, 90 = down). */
export function radialAngle(i: number, n: number): number {
  return -90 + (360 / Math.max(1, n)) * i;
}

const gap = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d;
};

export function radialStep(index: number, n: number, dir: RadialDir): number {
  if (n <= 1) return 0;
  const target = DIR_ANGLE[dir];
  const dists = Array.from({ length: n }, (_, i) => gap(radialAngle(i, n), target));
  const best = Math.min(...dists);
  const nearest = dists.map((d, i) => ({ d, i })).filter((x) => x.d - best < 0.5).map((x) => x.i);
  const cur = index >= 0 && index < n ? index : -1;
  if (cur >= 0 && nearest.includes(cur)) {
    // Already on one of the nearest items: step to the next one in that group (if any).
    const others = nearest.filter((i) => i !== cur);
    if (!others.length) return cur;
    return others.sort((a, b) => gap(radialAngle(a, n), radialAngle(cur, n)) - gap(radialAngle(b, n), radialAngle(cur, n)))[0];
  }
  if (cur < 0) return nearest[0];
  return nearest.sort((a, b) => gap(radialAngle(a, n), radialAngle(cur, n)) - gap(radialAngle(b, n), radialAngle(cur, n)) || a - b)[0];
}

/** Offset (in units of the radius) of item `i` from the centre. */
export function radialOffset(i: number, n: number): { x: number; y: number } {
  const a = (radialAngle(i, n) * Math.PI) / 180;
  return { x: Math.round(Math.cos(a) * 1000) / 1000, y: Math.round(Math.sin(a) * 1000) / 1000 };
}

/** Which item a pointer at (dx, dy) from the centre points at, or -1 inside the dead zone. */
export function radialHit(dx: number, dy: number, n: number, deadZone: number): number {
  if (Math.hypot(dx, dy) < deadZone || n < 1) return -1;
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < n; i++) {
    const g = gap(radialAngle(i, n), angle);
    if (g < bestGap) {
      bestGap = g;
      best = i;
    }
  }
  return best;
}
