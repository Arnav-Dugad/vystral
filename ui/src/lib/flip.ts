/**
 * FLIP bookkeeping for the virtualized Library grid and list. Positions are computed from indices
 * and the grid's geometry — never measured — so planning a re-sort of 5,000 games costs one pass
 * over the ids and no layout reads. Only cards on screen before *and* after glide; cards that
 * arrive from off screen (or are new) fade in; cards that leave the screen fade out where they were.
 */

export interface GridGeometry {
  columns: number;
  /** Cell width (px). Unused for lists (one column). */
  cellW: number;
  /** Row pitch (px), including the gap below the row. */
  rowH: number;
  /** Horizontal gap between cells (px). */
  gap: number;
}

/** The visible band, in the grid's own content coordinates. */
export interface Band {
  top: number;
  bottom: number;
}

export interface FlipMove {
  id: string;
  dx: number;
  dy: number;
}

export interface FlipLeave {
  id: string;
  x: number;
  y: number;
}

export interface FlipPlan {
  moves: FlipMove[];
  enters: string[];
  leaves: FlipLeave[];
}

/** At most this many cards animate (the rest just appear); a full screen of large-monitor cards fits. */
export const FLIP_MAX = 80;
/** Glide duration grows a little with distance, capped so a re-sort never feels slow. */
export const FLIP_MIN_MS = 200;
export const FLIP_MAX_MS = 420;

export function cellPosition(index: number, g: GridGeometry): { x: number; y: number } {
  const col = index % g.columns;
  const row = Math.floor(index / g.columns);
  return { x: col * (g.cellW + g.gap), y: row * g.rowH };
}

export function sameGeometry(a: GridGeometry, b: GridGeometry): boolean {
  return a.columns === b.columns && Math.abs(a.cellW - b.cellW) < 0.5 && Math.abs(a.rowH - b.rowH) < 0.5 && a.gap === b.gap;
}

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Indices whose row overlaps the band. */
export function visibleRange(count: number, g: GridGeometry, band: Band): [number, number] {
  if (count === 0 || band.bottom <= band.top) return [0, -1];
  const firstRow = Math.max(0, Math.floor(band.top / g.rowH));
  const lastRow = Math.max(firstRow, Math.ceil(band.bottom / g.rowH) - 1);
  return [Math.min(count, firstRow * g.columns), Math.min(count - 1, (lastRow + 1) * g.columns - 1)];
}

export function flipDuration(dx: number, dy: number): number {
  return Math.round(Math.min(FLIP_MAX_MS, FLIP_MIN_MS + Math.hypot(dx, dy) * 0.22));
}

/**
 * Plans the animation between two orders of the same grid. Returns null when the geometry changed
 * (a resize or card-size change): positions aren't comparable, so the caller cross-fades instead.
 */
export function planFlip(
  prevIds: readonly string[],
  nextIds: readonly string[],
  prevGeo: GridGeometry,
  nextGeo: GridGeometry,
  prevBand: Band,
  nextBand: Band,
  max = FLIP_MAX,
): FlipPlan | null {
  if (!sameGeometry(prevGeo, nextGeo)) return null;
  const plan: FlipPlan = { moves: [], enters: [], leaves: [] };
  const [pa, pb] = visibleRange(prevIds.length, prevGeo, prevBand);
  const [na, nb] = visibleRange(nextIds.length, nextGeo, nextBand);
  const prevVisible = new Map<string, number>();
  for (let i = pa; i <= pb; i++) prevVisible.set(prevIds[i], i);
  const nextVisible = new Set<string>();

  for (let i = na; i <= nb; i++) {
    const id = nextIds[i];
    nextVisible.add(id);
    const before = prevVisible.get(id);
    if (before === undefined) {
      plan.enters.push(id);
      continue;
    }
    const from = cellPosition(before, prevGeo);
    const to = cellPosition(i, nextGeo);
    const dx = from.x - to.x;
    // Screen-relative: if the scroll position moved (a filter shortened the page), start from where it was seen.
    const dy = from.y - to.y + (nextBand.top - prevBand.top);
    if (dx !== 0 || dy !== 0) plan.moves.push({ id, dx, dy });
  }
  for (const [id, i] of prevVisible) {
    if (nextVisible.has(id)) continue;
    const at = cellPosition(i, prevGeo);
    // A ghost in content coordinates that sits where the card was on screen.
    plan.leaves.push({ id, x: at.x, y: at.y + (nextBand.top - prevBand.top) });
  }

  // Too much at once (a huge monitor at the smallest card size): fade only, never glide.
  if (plan.moves.length + plan.enters.length > max) return { moves: [], enters: [...nextVisible], leaves: [] };
  plan.leaves = plan.leaves.slice(0, max);
  return plan;
}
