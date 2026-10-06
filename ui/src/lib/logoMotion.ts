/**
 * Track N: how a store mark "draws itself" in its brand colour when its control is hovered or focused.
 * CSS does the motion (store-logo.css); this only decides which kind, so the rule is testable:
 *
 * - `draw`  — stroked marks (the "added by you" glyph): the strokes draw in, in colour.
 * - `trace` — simple filled brand marks (Steam, Xbox, EA, …): the outline draws in, then the fill fades to
 *             the brand colour.
 * - `sweep` — busy filled marks (many small shapes, e.g. lettering) where a traced outline would look
 *             like noise at 14–20 px: a soft wipe of colour across the mark instead.
 * - `none`  — not interactive (decorative marks in text, cards that don't respond), or High contrast.
 *
 * Reduced motion keeps the kind but CSS makes the change instant (colour, no movement).
 */

export type LogoMotion = 'draw' | 'trace' | 'sweep' | 'none';

/** Above this many sub-paths a filled mark gets the sweep instead of a traced outline. */
export const TRACE_MAX_SUBPATHS = 8;

/** Number of sub-paths (moveto commands) in SVG path data. */
export function subpathCount(d: string): number {
  return (d.match(/[Mm]/g) ?? []).length;
}

/** Works for store marks and service marks alike (anything brand-or-drawn on the 24-unit grid). */
export function logoMotion(mark: { kind: string; path?: string }, opts: { interactive: boolean; highContrast?: boolean }): LogoMotion {
  if (!opts.interactive || opts.highContrast) return 'none';
  if (mark.kind !== 'brand') return 'draw';
  return subpathCount(mark.path ?? '') > TRACE_MAX_SUBPATHS ? 'sweep' : 'trace';
}

/** Draw timing (ms): the outline, then the fill, inside the 400–600 ms the design system allows. */
export const LOGO_DRAW_MS = 460;
export const LOGO_FILL_DELAY_MS = 180;
