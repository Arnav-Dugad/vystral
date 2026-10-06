import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Game } from '../../bridge/types';
import { flipDuration, planFlip, sameOrder, type Band, type GridGeometry } from '../../lib/flip';

export interface FlipGhost {
  game: Game;
  x: number;
  y: number;
  key: number;
}

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const GHOST_MS = 220;
let ghostSeq = 0;

/**
 * Animates a virtualized grid/list when its order changes (sort, filter, search): cards on screen
 * before and after glide to their new cells (FLIP with the Web Animations API, transform only),
 * newcomers fade in, and cards that left the screen fade out as ghosts. Positions come from
 * {@link planFlip}'s arithmetic, so nothing is measured. Resizes cross-fade; reduced motion
 * cross-fades the whole grid instead of moving anything.
 */
export function useFlipGrid({
  games,
  geometry,
  container,
  scrollEl,
  offset,
  reduce,
}: {
  games: readonly Game[];
  geometry: GridGeometry;
  container: RefObject<HTMLElement | null>;
  scrollEl: HTMLElement | null;
  /** The grid's top inside the scroll element (the virtualizer's scrollMargin). */
  offset: number;
  reduce: boolean;
}): FlipGhost[] {
  const prev = useRef<{ ids: string[]; geometry: GridGeometry; band: Band; byId: Map<string, Game> } | null>(null);
  const [ghosts, setGhosts] = useState<FlipGhost[]>([]);
  const ghostTimer = useRef<number | undefined>(undefined);
  useLayoutEffect(() => () => window.clearTimeout(ghostTimer.current), []);

  // Keep the remembered visible band current while scrolling, so a re-sort after a scroll plans
  // from what is actually on screen (otherwise cards from the old band flash past as ghosts).
  useLayoutEffect(() => {
    if (!scrollEl) return;
    const onScroll = () => {
      const p = prev.current;
      if (p) p.band = { top: scrollEl.scrollTop - offset, bottom: scrollEl.scrollTop - offset + scrollEl.clientHeight };
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [scrollEl, offset]);

  useLayoutEffect(() => {
    const root = container.current;
    const ids = games.map((g) => g.id);
    const band: Band = scrollEl
      ? { top: scrollEl.scrollTop - offset, bottom: scrollEl.scrollTop - offset + scrollEl.clientHeight }
      : { top: 0, bottom: typeof innerHeight === 'number' ? innerHeight : 800 };
    const before = prev.current;
    prev.current = { ids, geometry, band, byId: new Map(games.map((g) => [g.id, g])) };
    if (!before || !root || sameOrder(before.ids, ids)) return;

    if (reduce || typeof root.animate !== 'function') {
      root.animate?.([{ opacity: 0.35 }, { opacity: 1 }], { duration: 150, easing: 'linear' });
      return;
    }
    const plan = planFlip(before.ids, ids, before.geometry, geometry, before.band, band);
    if (!plan) {
      root.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 180, easing: 'ease-out' });
      return;
    }

    const moves = new Map(plan.moves.map((m) => [m.id, m]));
    const enters = new Set(plan.enters);
    for (const el of root.querySelectorAll<HTMLElement>('[data-flip-id]')) {
      const id = el.dataset.flipId!;
      const base = el.style.transform || 'none';
      const prefix = base === 'none' ? '' : ` ${base}`;
      const m = moves.get(id);
      if (m) {
        el.animate([{ transform: `translate(${m.dx}px, ${m.dy}px)${prefix}` }, { transform: base }], { duration: flipDuration(m.dx, m.dy), easing: EASE });
      } else if (enters.has(id)) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: 80, easing: 'ease-out', fill: 'backwards' });
      }
    }
    if (plan.leaves.length) {
      const leaving = plan.leaves
        .map((l) => ({ game: before.byId.get(l.id), x: l.x, y: l.y, key: ++ghostSeq }))
        .filter((g): g is FlipGhost => !!g.game);
      setGhosts(leaving);
      window.clearTimeout(ghostTimer.current);
      ghostTimer.current = window.setTimeout(() => setGhosts([]), GHOST_MS + 40);
    }
  }, [games, geometry, container, scrollEl, offset, reduce]);

  return ghosts;
}
