/**
 * Your own Home row order in Immersive (Track Z). Pure, so the rules are unit-tested:
 * - The order is a list of row ids saved in `immersive.rowOrder` ('|'-separated; '' = automatic).
 * - Rows it names take their saved places. Rows it doesn't name (a new collection, a row that was
 *   empty when you saved) keep following the row they follow in the automatic, time-of-day order.
 * - Live rows (Now playing, Downloads) and the All games grid never move.
 */
import type { Row, RowKind } from './rows';

const FIXED: readonly RowKind[] = ['playing', 'downloads', 'tools', 'library'];
const ID = /^[A-Za-z0-9:_-]{1,64}$/;
/** More ids than Home can ever show (9 kinds + 4 collections), with room for rows that come and go. */
export const ROW_ORDER_MAX = 40;

export const isMovableRow = (r: Row | null | undefined): r is Row => !!r && !FIXED.includes(r.kind);

/** The saved setting as a clean id list: unknown shapes, duplicates and junk are dropped. */
export function parseRowOrder(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  const out: string[] = [];
  for (const id of v.split('|')) if (ID.test(id) && !out.includes(id) && out.length < ROW_ORDER_MAX) out.push(id);
  return out;
}

export const serializeRowOrder = (ids: readonly string[]): string => parseRowOrder(ids.join('|')).join('|');

/** Rows in the saved order (see the module note). Returns the input unchanged when there is no saved order. */
export function applyRowOrder(rows: readonly Row[], order: readonly string[]): Row[] {
  if (!order.length) return [...rows];
  const rank = new Map(order.map((id, i) => [id, i]));
  let anchor = -1;
  let follow = 0;
  return rows
    .map((r, i) => {
      const saved = isMovableRow(r) ? rank.get(r.id) : undefined;
      if (saved !== undefined) {
        anchor = saved;
        follow = 0;
        return { r, i, a: saved, f: 0 };
      }
      return { r, i, a: anchor, f: ++follow };
    })
    .sort((x, y) => x.a - y.a || x.f - y.f || x.i - y.i)
    .map((x) => x.r);
}

/** The ids of the rows you can move, in the order they show. */
export const movableIds = (rows: readonly Row[]): string[] => rows.filter(isMovableRow).map((r) => r.id);

/** Moves `id` one place up (-1) or down (1). Null at either end (or when it isn't in the list). */
export function stepRow(ids: readonly string[], id: string, dir: -1 | 1): string[] | null {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/**
 * What to save after a move: the rows on screen in their new order, with rows that weren't on
 * screen (empty right now) kept right after the row they followed in the previous saved order.
 */
export function mergeRowOrder(previous: readonly string[], shown: readonly string[]): string[] {
  const out = [...shown];
  previous.forEach((id, i) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let k = i - 1; k >= 0; k--) {
      const p = out.indexOf(previous[k]);
      if (p >= 0) {
        at = p + 1;
        break;
      }
    }
    out.splice(at, 0, id);
  });
  return out.slice(0, ROW_ORDER_MAX);
}

/** True when the rows on screen already follow the automatic order (nothing worth saving). */
export function isAutomatic(auto: readonly string[], shown: readonly string[]): boolean {
  return auto.length === shown.length && auto.every((id, i) => shown[i] === id);
}
