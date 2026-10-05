import { useEffect, useRef } from 'react';
import { useWhatsNew } from './state';
import { useNewBadge, useNewBadgeGroup } from './useNewBadge';
import './whatsnew.css';

/** How long a badge must be on screen to count as seen. */
const SEEN_AFTER_MS = 1200;

/**
 * A small animated "New" marker. `dot` for navigation, `pill` (the word "New") next to a row or
 * button. With `seenWhenVisible`, being on screen for a moment marks it seen (rows, sections);
 * otherwise it's marked seen by visiting its page (see `seenOn` in badges.ts) or by `markSeen`
 * from useNewBadge. Renders nothing for keys that aren't new (or aren't in the manifest).
 */
export function NewBadge({ k, variant = 'dot', seenWhenVisible = false }: { k: string; variant?: 'dot' | 'pill'; seenWhenVisible?: boolean }) {
  const { isNew } = useNewBadge(k, seenWhenVisible);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!isNew || !seenWhenVisible || !el || typeof IntersectionObserver === 'undefined') return;
    let timer: number | undefined;
    const io = new IntersectionObserver(([entry]) => {
      window.clearTimeout(timer);
      if (entry?.isIntersecting) timer = window.setTimeout(() => useWhatsNew.getState().markBadgesSeen([k]), SEEN_AFTER_MS);
    });
    io.observe(el);
    return () => {
      window.clearTimeout(timer);
      io.disconnect();
    };
  }, [isNew, seenWhenVisible, k]);

  if (!isNew) return null;
  return (
    <span ref={ref} className={`new-badge new-badge--${variant}`} data-new-badge={k}>
      {variant === 'pill' ? 'New' : <span className="visually-hidden">New</span>}
    </span>
  );
}

/** A dot for a group (a Settings section) while anything in it is new. */
export function NewBadgeGroup({ prefix }: { prefix: string }) {
  const any = useNewBadgeGroup(prefix);
  if (!any) return null;
  return (
    <span className="new-badge new-badge--dot" data-new-badge-group={prefix}>
      <span className="visually-hidden">New</span>
    </span>
  );
}
