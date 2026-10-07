/**
 * Track Z: the game page's fluid header. As the page scrolls, the cover lifts off the hero and
 * docks into a compact sticky bar, the title shrinks along a curve into it, and Play docks at the
 * bar's right. The motion itself is CSS (a scroll-driven animation on the compositor, or the same
 * keyframes scrubbed by a rAF-throttled fallback); this module turns a one-off measurement of the
 * layout (on resize only, never per frame) into the few lengths those keyframes need.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DockInput {
  /** The hero's height. */
  heroH: number;
  /** The docked bar's height. */
  barH: number;
  /** The hero cover in page coordinates at scroll 0 (null when it isn't shown, e.g. narrow windows). */
  cover: Box | null;
  /** The cover's slot in the bar (bar coordinates; only x, y and w are used). */
  coverSlot: Box;
  /** The hero's title (logo or text) in page coordinates at scroll 0. */
  title: Box | null;
  /** The title's slot in the bar (bar coordinates; x, y and h are used). */
  titleSlot: Box;
}

/** The cover rides with the page (lifting slightly) until here, then flies to the bar. */
export const LIFT_AT = 0.22;
/** How much the cover grows as it lifts. */
export const LIFT_SCALE = 1.035;
/** From this progress the bar counts as docked: its Play button exists (the hero's has faded by then). */
export const DOCKED_AT = 0.5;

const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Scroll distance over which the header docks: until the hero's bottom meets the bar's. */
export const dockDistance = (heroH: number, barH: number) => Math.max(80, Math.round(heroH - barH));

/** Docking progress (0–1) at a scroll position. */
export const dockProgress = (scrollTop: number, distance: number) => clamp(distance > 0 ? scrollTop / distance : 1, 0, 1);

/**
 * CSS custom properties for the docking keyframes (all lengths in px):
 * - `--dk-end`: the scroll distance;
 * - cover: `--dk-cx0/--dk-cy0` (sits exactly on the hero cover), `--dk-cxl/--dk-cyl` (still on it,
 *   lifted, at {@link LIFT_AT}), `--dk-cw/--dk-ch` (its natural size, the hero cover's), `--dk-k`
 *   (the docked scale);
 * - title: `--dk-tx/--dk-ty` (where the hero title must travel to land in the bar's title slot)
 *   and `--dk-kt` (its docked scale).
 */
export function dockVars(i: DockInput): Record<string, string> {
  const d = dockDistance(i.heroH, i.barH);
  const vars: Record<string, string> = { '--dk-end': px(d) };
  if (i.cover && i.cover.w > 0) {
    const c = i.cover;
    const grow = (LIFT_SCALE - 1) / 2;
    vars['--dk-cw'] = px(c.w);
    vars['--dk-ch'] = px(c.h);
    vars['--dk-cx0'] = px(c.x - i.coverSlot.x);
    vars['--dk-cy0'] = px(c.y - i.coverSlot.y);
    vars['--dk-cxl'] = px(c.x - i.coverSlot.x - c.w * grow);
    vars['--dk-cyl'] = px(c.y - i.coverSlot.y - LIFT_AT * d - c.h * grow);
    vars['--dk-k'] = String(Math.round((i.coverSlot.w / c.w) * 10_000) / 10_000);
  }
  if (i.title && i.title.h > 0) {
    const t = i.title;
    vars['--dk-tx'] = px(i.titleSlot.x - t.x);
    vars['--dk-ty'] = px(i.titleSlot.y - (t.y - d));
    vars['--dk-kt'] = String(Math.round(clamp(i.titleSlot.h / t.h, 0.12, 1) * 10_000) / 10_000);
  }
  return vars;
}

/**
 * Where an element sits inside `root` by layout alone (offsets, so transforms and running
 * animations never count). `root` must be positioned (an offset parent); null when the element
 * isn't rendered (display: none) or isn't inside it.
 */
export function layoutBox(el: HTMLElement | null, root: HTMLElement): Box | null {
  if (!el || !el.isConnected || el.offsetParent === null) return null;
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === root ? { x, y, w: el.offsetWidth, h: el.offsetHeight } : null;
}
