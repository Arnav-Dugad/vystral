/**
 * Immersive navigation as a pure reducer (Track L): where focus is, how D-pad moves change it,
 * and what feedback each move earns. The view only renders the state and plays the feedback.
 */
import type { LibraryFilter, Row } from './rows';
import { sameFilter } from './rows';

export type ImmTab = 'home' | 'library';

export interface NavState {
  tab: ImmTab;
  row: number;
  /** The focused row's id: rows appearing or disappearing above it never move focus to another row. */
  rowId: string | null;
  /** Remembered column per row id (shelves remember where you were). */
  cols: Record<string, number>;
  /** Library filter (a store, a genre, installed, …); null = all games. */
  filter: LibraryFilter | null;
}

/** What a move did: moved along a row, changed rows, or ran into an edge. */
export type NavEffect = 'col' | 'row' | 'edge' | null;

export const INITIAL_NAV: NavState = { tab: 'home', row: 0, rowId: null, cols: {}, filter: null };

export function clampRow(state: NavState, rows: readonly Row[]): number {
  if (state.rowId) {
    const i = rows.findIndex((r) => r.id === state.rowId);
    if (i >= 0) return i;
  }
  return Math.min(Math.max(0, state.row), Math.max(0, rows.length - 1));
}

export function colOf(state: NavState, rows: readonly Row[], rowIndex = clampRow(state, rows)): number {
  const r = rows[rowIndex];
  if (!r) return 0;
  return Math.min(Math.max(0, state.cols[r.id] ?? 0), Math.max(0, r.tiles.length - 1));
}

export function moveNav(state: NavState, rows: readonly Row[], dr: number, dc: number): { state: NavState; effect: NavEffect } {
  const row = clampRow(state, rows);
  const current = rows[row];
  if (!current) return { state, effect: null };
  const col = colOf(state, rows, row);
  if (dc) {
    const next = Math.max(0, Math.min(current.tiles.length - 1, col + dc));
    if (next === col) return { state, effect: 'edge' };
    return { state: { ...state, row, rowId: current.id, cols: { ...state.cols, [current.id]: next } }, effect: 'col' };
  }
  if (dr) {
    const nextRow = Math.max(0, Math.min(rows.length - 1, row + dr));
    if (nextRow === row) return { state, effect: 'edge' };
    const cols = { ...state.cols };
    // The A–Z grid keeps the same column; shelves remember their own position.
    // (The toolbar over the grid remembers its own chip.)
    if (state.tab === 'library' && current.kind !== 'tools' && rows[nextRow].kind !== 'tools') cols[rows[nextRow].id] = Math.min(col, rows[nextRow].tiles.length - 1);
    return { state: { ...state, row: nextRow, rowId: rows[nextRow].id, cols }, effect: 'row' };
  }
  return { state, effect: null };
}

export function switchTab(state: NavState, tab?: ImmTab): NavState {
  const next = tab ?? (state.tab === 'home' ? 'library' : 'home');
  if (next === state.tab) return state;
  // The grid opens on its first row of games (the toolbar sits just above it).
  return { ...state, tab: next, row: 0, rowId: next === 'library' ? 'lib-0' : null };
}

/** Browse tiles open the A–Z grid filtered to that store or genre. */
export function applyFilter(state: NavState, filter: LibraryFilter | null): NavState {
  if (state.tab === 'library' && sameFilter(state.filter, filter)) return state;
  const cols = { ...state.cols };
  for (const id of Object.keys(cols)) if (id.startsWith('lib-')) delete cols[id];
  return { ...state, tab: 'library', row: 0, rowId: 'lib-0', cols, filter };
}

export function locate(rows: readonly Row[], gameId: string): { row: number; col: number } | null {
  for (let r = 0; r < rows.length; r++) {
    const c = rows[r].tiles.findIndex((t) => t.kind === 'game' && t.game.id === gameId);
    if (c >= 0) return { row: r, col: c };
  }
  return null;
}

/** Puts focus on a game if it is in these rows (state unchanged otherwise). */
export function focusGame(state: NavState, rows: readonly Row[], gameId: string): NavState {
  const at = locate(rows, gameId);
  if (!at) return state;
  return { ...state, row: at.row, rowId: rows[at.row].id, cols: { ...state.cols, [rows[at.row].id]: at.col } };
}

/** Pointer or search picked a tile directly. */
export function pick(state: NavState, rows: readonly Row[], row: number, col: number): NavState {
  const r = rows[row];
  if (!r) return state;
  return { ...state, row, rowId: r.id, cols: { ...state.cols, [r.id]: Math.max(0, Math.min(col, r.tiles.length - 1)) } };
}
