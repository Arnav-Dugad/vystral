import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DiscoverResult } from '../../bridge/types';
import { useReducedMotion } from '../../state/store';
import { IconButton, Skeleton } from '../ui/primitives';
import { ResultCard, ResultSkeletons } from './DiscoverBits';
import '../game/shelf.css';
import './discover-browse.css';

/**
 * Track C3: one horizontal row of Discover cards. Native scrolling with snap (touchpad-friendly), arrow buttons only
 * when there is somewhere to go, Left/Right/Home/End between cards for keyboards (controllers move geometrically), and
 * a short line saying where the row comes from.
 */
export function DiscoverShelf({ id, title, reason, items, action, icon, children, count }: {
  id: string;
  title: ReactNode;
  /** Plain words for why these games are here. */
  reason?: ReactNode;
  items?: DiscoverResult[];
  action?: ReactNode;
  icon?: ReactNode;
  /** Custom cells instead of result cards (Watching). */
  children?: ReactNode;
  count?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [edge, setEdge] = useState({ start: true, end: true });
  const headingId = `dshelf-${id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const n = count ?? items?.length ?? 0;

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = { start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 };
    setEdge((e) => (e.start === next.start && e.end === next.end ? e : next));
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, n]);

  const scroll = (dir: 1 | -1) => {
    if (dir === -1 ? edge.start : edge.end) return;
    ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: reduce ? 'auto' : 'smooth' });
  };

  // Left/Right move between this row's cards; Home/End jump to its ends. Up/Down are left to the page.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const cards = [...(ref.current?.querySelectorAll<HTMLElement>('[data-shelf-card]') ?? [])];
    const at = cards.findIndex((c) => c === document.activeElement || c.contains(document.activeElement));
    if (at < 0) return;
    const to = e.key === 'Home' ? 0 : e.key === 'End' ? cards.length - 1 : at + (e.key === 'ArrowRight' ? 1 : -1);
    if (to < 0 || to >= cards.length || to === at) return;
    e.preventDefault();
    const target = cards[to].matches('button, a') ? cards[to] : cards[to].querySelector<HTMLElement>('button, a');
    target?.focus({ preventScroll: false });
  };

  if (n === 0 && !children) return null;
  return (
    <section className="dshelf" aria-labelledby={headingId} data-shelf={id}>
      <div className="dshelf__head">
        <div className="dshelf__titles">
          <h2 className="dshelf__title" id={headingId}>{icon}{title}</h2>
          {reason && <p className="dshelf__reason">{reason}</p>}
        </div>
        <div className="dshelf__tools">
          {action}
          {!(edge.start && edge.end) && (
            <>
              {/* aria-disabled (not disabled) so focus isn't dropped when the row reaches its end. */}
              <IconButton label="Scroll left" size="sm" aria-disabled={edge.start || undefined} onClick={() => scroll(-1)}><ChevronLeft size={16} /></IconButton>
              <IconButton label="Scroll right" size="sm" aria-disabled={edge.end || undefined} onClick={() => scroll(1)}><ChevronRight size={16} /></IconButton>
            </>
          )}
        </div>
      </div>
      <div className="shelf__track dshelf__track" ref={ref} onScroll={measure} onKeyDown={onKeyDown} role="list" aria-labelledby={headingId}>
        {children ?? items!.map((r, i) => (
          <div key={r.key} className="shelf__item" role="listitem" data-shelf-card style={{ ['--i' as string]: Math.min(i, 10) }}>
            <ResultCard r={r} query={null} showSources={false} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** A row's shape while it loads. */
export function DiscoverShelfSkeleton({ id, cards = 8 }: { id: string; cards?: number }) {
  return (
    <section className="dshelf dshelf--loading" aria-hidden data-shelf-skeleton={id}>
      <div className="dshelf__head">
        <div className="dshelf__titles">
          <Skeleton width={220} height={20} radius={6} />
          <Skeleton width={160} height={12} radius={4} className="dshelf__reason-skel" />
        </div>
      </div>
      <div className="shelf__track dshelf__track">
        <ResultSkeletons count={cards} />
      </div>
    </section>
  );
}
