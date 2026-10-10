/**
 * Track D1: the Library's multi-select model. Pure and immutable, so every gesture is unit-tested:
 * Ctrl-click / Space / controller X toggle one game, Shift-click selects a range from the anchor, Shift+arrows extend
 * from the anchor as focus moves, and "Select all" takes everything the current filter shows.
 *
 * `base` is the selection as it was when the anchor was set; a range (Shift-click, Shift+arrows) is always
 * `base ∪ anchor…target`, so moving back over a range shrinks it again, like a file manager.
 */
import type { Game, GameStatus } from '../bridge/types';
import { userHiddenOf } from './bulk';

export interface Selection {
  readonly ids: ReadonlySet<string>;
  readonly anchor: string | null;
  readonly base: ReadonlySet<string>;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null, base: new Set() };

/** Adds or removes one game; it becomes the anchor for the next range. */
export function toggle(s: Selection, id: string): Selection {
  const ids = new Set(s.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id, base: ids };
}

/** The ids from `a` to `b` in display order (inclusive, either direction); empty when either isn't shown. */
export function between(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

/** Shift-click: everything from the anchor to `id`, on top of what was selected before the anchor. */
export function selectRange(s: Selection, order: readonly string[], id: string): Selection {
  if (!s.anchor || !order.includes(s.anchor)) return toggle(s, id);
  const ids = new Set(s.base);
  for (const x of between(order, s.anchor, id)) ids.add(x);
  return { ids, anchor: s.anchor, base: s.base };
}

/**
 * Shift+arrow from the focused game: focus moves by `delta` places (±1 for left/right or a list, ±columns for
 * up/down in the grid) and the selection becomes `base ∪ anchor…target`. The first press anchors on `from`
 * (and selects it). Returns the new selection and the game to focus.
 */
export function extend(s: Selection, order: readonly string[], from: string, delta: number): { selection: Selection; focus: string } {
  const i = order.indexOf(from);
  if (i < 0 || order.length === 0) return { selection: s, focus: from };
  const target = order[Math.max(0, Math.min(order.length - 1, i + delta))];
  const anchored = s.anchor && order.includes(s.anchor) ? s : { ids: s.ids, anchor: from, base: new Set([...s.ids].filter((x) => x !== from)) };
  const ids = new Set(anchored.base);
  for (const x of between(order, anchored.anchor!, target)) ids.add(x);
  return { selection: { ids, anchor: anchored.anchor, base: anchored.base }, focus: target };
}

/** Everything the current filter shows. */
export function selectAll(order: readonly string[]): Selection {
  const ids = new Set(order);
  return { ids, anchor: null, base: ids };
}

/** Keeps only games that are still shown (the filter changed, or a game left the library). */
export function prune(s: Selection, order: readonly string[]): Selection {
  if (s.ids.size === 0) return s;
  const shown = new Set(order);
  let same = true;
  for (const id of s.ids) if (!shown.has(id)) { same = false; break; }
  if (same && (!s.anchor || shown.has(s.anchor))) return s;
  const keep = (set: ReadonlySet<string>) => new Set([...set].filter((id) => shown.has(id)));
  return { ids: keep(s.ids), anchor: s.anchor && shown.has(s.anchor) ? s.anchor : null, base: keep(s.base) };
}

/** The selected games in display order. */
export function inOrder(s: Selection, order: readonly string[]): string[] {
  return order.filter((id) => s.ids.has(id));
}

/** What the action bar needs to know about the selected games to label its toggles. */
export interface SelectionSummary {
  count: number;
  allFavorite: boolean;
  /** Hidden by the user (games Steam no longer lists are hidden regardless). */
  allHidden: boolean;
  /** Every game is played or marked played (so the action offers to clear the marks). */
  allMarkedPlayed: boolean;
  /** The status they all share; 'mixed' when they differ; null when none has one. */
  status: GameStatus | null | 'mixed';
  /** Selected games that have a store page to open (a store copy other than one you added yourself). */
  withStore: number;
}

export function summarize(games: readonly Game[]): SelectionSummary {
  const first = games[0]?.status ?? null;
  return {
    count: games.length,
    allFavorite: games.length > 0 && games.every((g) => g.favorite),
    allHidden: games.length > 0 && games.every(userHiddenOf),
    allMarkedPlayed: games.length > 0 && games.every((g) => !!g.playedMarkedAt),
    status: games.every((g) => (g.status ?? null) === first) ? first : 'mixed',
    withStore: games.filter((g) => storeInstallation(g) != null).length,
  };
}

/** The copy whose store page "Open in store" opens: the preferred one, else the first store copy. */
export function storeInstallation(g: Game): string | null {
  const stores = g.installations.filter((i) => i.platform !== 'manual');
  return (stores.find((i) => i.id === g.preferredInstallationId) ?? stores[0])?.id ?? null;
}

/** "Open in store" opens one page per game; more than this many would bury the desktop in windows. */
export const MAX_STORE_PAGES = 5;
