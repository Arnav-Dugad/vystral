/**
 * Geometry-based spatial navigation for controllers (and arrow keys in Immersive Mode).
 * Focus moves to the nearest focusable element in the pressed direction within the active
 * scope (an open dialog or menu always wins, so focus can never escape or get lost).
 * Vertical moves remember a "sticky" column so moving up/down through rows feels anchored.
 */

import { sound } from './sound';

export type Dir = 'up' | 'down' | 'left' | 'right';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let stickyX: number | null = null;

export function activeScope(): HTMLElement {
  return (
    document.querySelector<HTMLElement>('[data-menu-open]') ??
    document.querySelector<HTMLElement>('[data-dialog-open] [role=dialog]') ??
    document.querySelector<HTMLElement>('[data-nav-scope="overlay"]') ??
    document.body
  );
}

function visible(el: HTMLElement) {
  if (el.closest('[aria-hidden="true"], [inert]')) return false;
  const r = el.getBoundingClientRect();
  return r.width > 2 && r.height > 2 && r.bottom > -window.innerHeight && r.top < window.innerHeight * 2;
}

export function focusables(scope = activeScope()): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
}

export function moveFocus(dir: Dir): boolean {
  const scope = activeScope();
  const items = focusables(scope);
  const current = document.activeElement as HTMLElement | null;
  if (!current || current === document.body || !scope.contains(current)) {
    const first = scope.querySelector<HTMLElement>('[data-autofocus]') ?? scope.querySelector<HTMLElement>('main [data-game-id]') ?? items[0];
    focusEl(first);
    return !!first;
  }
  // Text inputs keep left/right for the caret.
  if ((current.tagName === 'INPUT' || current.tagName === 'TEXTAREA') && (dir === 'left' || dir === 'right')) return false;

  const from = current.getBoundingClientRect();
  const fx = dir === 'up' || dir === 'down' ? (stickyX ?? from.left + from.width / 2) : from.left + from.width / 2;
  const fy = from.top + from.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of items) {
    if (el === current || el.contains(current) || current.contains(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let primary: number, ortho: number;
    switch (dir) {
      case 'right': primary = r.left - from.right; ortho = Math.abs(cy - fy); break;
      case 'left': primary = from.left - r.right; ortho = Math.abs(cy - fy); break;
      case 'down': primary = r.top - from.bottom; ortho = Math.abs(cx - fx); break;
      case 'up': primary = from.top - r.bottom; ortho = Math.abs(cx - fx); break;
    }
    if (primary < -Math.min(from.width, from.height) * 0.3) continue; // behind us
    // Prefer elements overlapping our row/column.
    const overlaps = dir === 'left' || dir === 'right' ? r.bottom > from.top && r.top < from.bottom : r.right > from.left && r.left < from.right;
    const score = Math.max(0, primary) + ortho * 2 - (overlaps ? 40 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  if (!best) return false;
  if (dir === 'up' || dir === 'down') stickyX = fx;
  else stickyX = null;
  focusEl(best);
  sound.spatialFocus();
  return true;
}

export function focusEl(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const reduce = document.documentElement.dataset.reducedMotion === 'true';
  el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}
