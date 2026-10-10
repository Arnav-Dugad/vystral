/**
 * Shared-element choreography.
 *
 * Card → page flight (FLIP): when a card is pressed we record its cover rect; when the detail
 * page's cover mounts it starts at that rect and springs to its own place. Going back, the
 * detail cover's rect is recorded on unmount and the card springs out of it. Because the
 * motion is a spring on the element itself, a second navigation mid-flight simply retargets.
 *
 * Launch portal: where a launch was triggered (Play button centre + cover rect), so the launch
 * overlay can open from that point and close back into it.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { animate } from 'motion';
import { spring } from './motion';

interface PendingFlight {
  id: string;
  rect: DOMRect;
  radius: string;
  at: number;
}

let pending: PendingFlight | null = null;
// Track D5: 1.4 s (was 0.9 s): a page that takes a moment to render on a busy PC still gets its flight.
const FLIGHT_TTL = 1400;
/** UI tests on a busy machine can stretch it (window.__vystralFlightTtlMs); the app never sets it. */
const ttl = () => {
  const v = typeof window === 'undefined' ? undefined : (window as { __vystralFlightTtlMs?: unknown }).__vystralFlightTtlMs;
  return typeof v === 'number' && v > 0 ? v : FLIGHT_TTL;
};

/** Records where a flight starts (call on press, and when a flight's source leaves). */
export function captureFlight(id: string, el: Element | null | undefined) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4 || rect.bottom < 0 || rect.top > innerHeight) return;
  pending = { id, rect, radius: getComputedStyle(el).borderRadius, at: performance.now() };
}

/**
 * Lands a pending flight on `ref` when it mounts. `deferFrames` waits for scroll restoration
 * (cards on a restored page settle a frame after mounting). Track D5: with `reduce` (reduced
 * motion) the element doesn't travel; it crossfades in where it is.
 */
export function useFlightLanding(id: string, ref: RefObject<HTMLElement | null>, enabled: boolean, deferFrames = 0, reduce = false) {
  useLayoutEffect(() => {
    const el = ref.current;
    const flight = pending;
    if (!el || !enabled || !flight || flight.id !== id || performance.now() - flight.at > ttl()) return;
    // The flight is only claimed when it lands, so effect re-runs (StrictMode) don't lose it.
    el.style.opacity = '0';
    let raf = 0;
    let frames = deferFrames;
    let waits = 12;
    let settled: DOMRect | null = null;
    let steadyWaits = 6;
    let stop: (() => void) | undefined;
    const land = () => {
      if (frames-- > 0) {
        raf = requestAnimationFrame(land);
        return;
      }
      if (pending !== flight) {
        el.style.opacity = '';
        return;
      }
      const to = el.getBoundingClientRect();
      const fresh = waits > 0 && performance.now() - flight.at < ttl();
      // Track D5: the same game can be on screen twice (Recommended and a "Because you played" row); only a copy
      // that's mostly visible claims the flight, so one scrolled away (or clipped by its row) can't swallow it. A page
      // restoring its scroll position takes a few frames, so a copy keeps looking while the flight is fresh.
      if (to.width < 4 || visibleFraction(el, to) < 0.6) {
        el.style.opacity = '';
        if (fresh) { waits--; raf = requestAnimationFrame(land); }
        return;
      }
      // …and lands only once its own place holds still for a frame (scroll restoration, rows loading above it),
      // so the flight starts exactly where the cover was. Hidden meanwhile: at most a few frames.
      // (A few pixels a frame is the page's own ease-in, which the flight rides along with.)
      if (fresh && steadyWaits > 0 && (!settled || Math.abs(settled.top - to.top) > 4 || Math.abs(settled.left - to.left) > 4)) {
        settled = to;
        steadyWaits--;
        raf = requestAnimationFrame(land);
        return;
      }
      el.style.opacity = '';
      pending = null;
      if (reduce) {
        const fade = animate(el, { opacity: [0, 1] }, { duration: 0.22, ease: 'linear' });
        stop = () => fade.stop();
        void fade.finished.then(() => { el.style.opacity = ''; });
        return;
      }
      const sx = flight.rect.width / to.width;
      const sy = flight.rect.height / to.height;
      const dx = flight.rect.left - to.left;
      const dy = flight.rect.top - to.top;
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(sx - 1) < 0.02) return;
      el.style.transformOrigin = '0 0';
      el.style.zIndex = '20';
      el.style.willChange = 'transform';
      const controls = animate(
        el,
        { x: [dx, 0], y: [dy, 0], scaleX: [sx, 1], scaleY: [sy, 1] },
        spring.hero,
      );
      stop = () => controls.stop();
      void controls.finished.then(() => {
        el.style.zIndex = '';
        el.style.willChange = '';
        el.style.transform = '';
      });
    };
    raf = requestAnimationFrame(land);
    return () => {
      cancelAnimationFrame(raf);
      stop?.();
      el.style.opacity = '';
    };
  }, [id, ref, enabled, deferFrames, reduce]);
}

/** How much of an element's box is on screen (0..1): inside the window, its row's track and the page's scroller. */
export function visibleFraction(el: Element, r: DOMRect = el.getBoundingClientRect()): number {
  let left = Math.max(r.left, 0);
  let top = Math.max(r.top, 0);
  let right = Math.min(r.right, innerWidth);
  let bottom = Math.min(r.bottom, innerHeight);
  for (const clip of [el.closest('.shelf__track'), el.closest('[data-scroll-main]')]) {
    if (!clip) continue;
    const c = clip.getBoundingClientRect();
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.right);
    bottom = Math.min(bottom, c.bottom);
  }
  const area = r.width * r.height;
  return area > 0 ? (Math.max(0, right - left) * Math.max(0, bottom - top)) / area : 0;
}

export interface LaunchOrigin {
  gameId: string;
  /** Point the portal opens from (usually the Play button's centre), in viewport px. */
  x: number;
  y: number;
  /** Cover rect the art grows out of, if one was on screen. */
  cover: DOMRect | null;
  at: number;
}

let origin: LaunchOrigin | null = null;

export function setLaunchOrigin(gameId: string, from: Element | null, cover?: Element | null) {
  const r = from?.getBoundingClientRect();
  origin = {
    gameId,
    x: r ? r.left + r.width / 2 : innerWidth / 2,
    y: r ? r.top + r.height / 2 : innerHeight / 2,
    cover: cover?.getBoundingClientRect() ?? null,
    at: Date.now(),
  };
}

/** The origin for this game if it was set recently (otherwise the portal opens from centre). */
export function launchOriginFor(gameId: string): LaunchOrigin {
  if (origin && origin.gameId === gameId && Date.now() - origin.at < 15_000) return origin;
  return { gameId, x: innerWidth / 2, y: innerHeight / 2, cover: null, at: Date.now() };
}

/** Finds the on-screen cover for a game (detail hero cover, or a card in a grid/shelf). */
export function findCoverElement(gameId: string): Element | null {
  const id = CSS.escape(gameId);
  return document.querySelector(`.dhero__cover[data-game-id="${id}"]`) ?? document.querySelector(`[data-game-id="${id}"] .card__frame`);
}
