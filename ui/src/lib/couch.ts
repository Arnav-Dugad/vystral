/**
 * Couch mode (Track L): Immersive text/UI scale and a TV overscan safe area. Values come from
 * settings (`immersive.scale`, `immersive.safeArea`) and are always clamped here, so a bad value
 * can never push the interface off screen.
 */

export const COUCH_SCALE = { min: 1, max: 1.3, step: 0.05, default: 1 } as const;
export const COUCH_SAFE = { min: 0, max: 0.06, step: 0.01, default: 0 } as const;

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function couchScale(v: unknown): number {
  return Math.round(clamp(v, COUCH_SCALE.min, COUCH_SCALE.max, COUCH_SCALE.default) * 100) / 100;
}

export function couchSafe(v: unknown): number {
  return Math.round(clamp(v, COUCH_SAFE.min, COUCH_SAFE.max, COUCH_SAFE.default) * 1000) / 1000;
}

/** CSS custom properties for the Immersive root. */
export function couchVars(scale: unknown, safe: unknown): Record<string, string> {
  return { '--couch-scale': String(couchScale(scale)), '--couch-safe': String(couchSafe(safe)) };
}

/** Steps a couch value by one notch (Left/Right on a controller). */
export function stepCouch(kind: 'scale' | 'safe', value: unknown, dir: -1 | 1): number {
  const spec = kind === 'scale' ? COUCH_SCALE : COUCH_SAFE;
  const norm = kind === 'scale' ? couchScale : couchSafe;
  return norm(norm(value) + spec.step * dir);
}

export const formatScale = (v: number) => `${Math.round(couchScale(v) * 100)}%`;
export const formatSafe = (v: number) => (couchSafe(v) === 0 ? 'Off' : `${Math.round(couchSafe(v) * 100)}%`);
