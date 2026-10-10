/**
 * Track D1: the Library's selection state and every gesture that changes it — Ctrl/Shift-click, the hover checkbox,
 * Space, Shift+arrows, Ctrl+A, Escape and the controller's X button. The model itself is pure (lib/selection.ts).
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { EMPTY_SELECTION, extend, inOrder, prune, selectAll, selectRange, toggle, type Selection } from '../../lib/selection';
import { pushPadHandler } from '../../lib/input';
import { haptic } from '../../lib/haptics';

export interface SelectApi {
  ids: ReadonlySet<string>;
  /** Selection mode: plain clicks select instead of opening the game. */
  selecting: boolean;
  toggle(id: string): void;
  range(id: string): void;
  /** Shift+arrow: moves `delta` places from `from`, extending the selection; returns the game to focus. */
  extend(from: string, delta: number): string;
  /** Handles a click on a card or row; true when it was a selection gesture (the caller must not open the game). */
  click(e: MouseEvent, id: string): boolean;
  /** Handles Space on a card or row; true when handled. Shift+arrows are handled by the view (it knows the layout). */
  key(e: KeyboardEvent, id: string): boolean;
}

export function useLibrarySelection(order: readonly string[]) {
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [mode, setMode] = useState(false);
  const ref = useRef(sel);
  ref.current = sel;
  const orderRef = useRef(order);
  orderRef.current = order;
  const selecting = mode || sel.ids.size > 0;
  const selectingRef = useRef(selecting);
  selectingRef.current = selecting;

  // The filter changed: keep only games still shown.
  useEffect(() => setSel((s) => prune(s, order)), [order]);

  const clear = () => {
    setSel(EMPTY_SELECTION);
    setMode(false);
  };

  const api = useMemo<SelectApi>(() => ({
    ids: sel.ids,
    selecting,
    toggle: (id) => setSel((s) => toggle(s, id)),
    range: (id) => setSel((s) => selectRange(s, orderRef.current, id)),
    extend: (from, delta) => {
      const r = extend(ref.current, orderRef.current, from, delta);
      setSel(r.selection);
      return r.focus;
    },
    click: (e, id) => {
      if (e.button !== 0 || !(e.currentTarget as Node).contains(e.target as Node)) return false;
      if ((e.target as HTMLElement).closest?.('[data-select-check]')) return false;
      if (e.ctrlKey || e.metaKey) setSel((s) => toggle(s, id));
      else if (e.shiftKey) setSel((s) => selectRange(s, orderRef.current, id));
      // While selecting, a plain click selects; Enter (a click with no pointer, detail 0) still opens the game.
      else if (selectingRef.current && e.detail !== 0) setSel((s) => toggle(s, id));
      else return false;
      e.preventDefault();
      e.stopPropagation();
      return true;
    },
    key: (e, id) => {
      if (!(e.currentTarget as Node).contains(e.target as Node)) return false;
      if (e.key === ' ' && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) setSel((s) => selectRange(s, orderRef.current, id));
        else setSel((s) => toggle(s, id));
        return true;
      }
      return false;
    },
  }), [sel.ids, selecting]);

  // Escape clears; Ctrl+A selects everything shown (not while typing, or while a menu or dialog is open).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable]');
      if (typing || document.querySelector('[data-dialog-open], [data-menu-open]')) return;
      if (e.key === 'Escape' && (ref.current.ids.size > 0 || selectingRef.current)) {
        e.preventDefault();
        clear();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && orderRef.current.length) {
        e.preventDefault();
        setSel(selectAll(orderRef.current));
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // Controller: X toggles the focused game (View still opens its menu).
  useEffect(() => pushPadHandler((button, repeat) => {
    if (button !== 'X' || repeat) return false;
    const cell = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-select-id]');
    const id = cell?.dataset.selectId;
    if (!id) return false;
    setSel((s) => toggle(s, id));
    haptic('tick');
    return true;
  }), []);

  // Lift the toasts above the bar while it's up.
  const any = sel.ids.size > 0;
  useEffect(() => {
    const root = document.documentElement;
    if (any) root.dataset.bulkBar = '';
    else delete root.dataset.bulkBar;
    return () => { delete root.dataset.bulkBar; };
  }, [any]);

  return {
    api,
    selected: inOrder(sel, order),
    selecting,
    setMode,
    clear,
    selectAll: () => setSel(selectAll(orderRef.current)),
  };
}
