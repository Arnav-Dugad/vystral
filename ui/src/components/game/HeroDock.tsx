import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { motion } from 'motion/react';
import type { Game } from '../../bridge/types';
import { DOCKED_AT, dockDistance, dockProgress, dockVars, layoutBox } from '../../lib/heroDock';
import { paletteFor, peekPalette } from '../../lib/palette';
import { useReducedMotion } from '../../state/store';
import { GameCover } from './GameCover';
import { PlayButton } from './PlayButton';

/** Must match `.ddock__bar`'s height in detail.css. */
const BAR_H = 72;

type DockMode = 'timeline' | 'js' | 'reduced';

/** Scroll-driven animations where the engine has them; `?dockFallback` forces the scripted path (for tests). */
function pickMode(reduce: boolean): DockMode {
  if (reduce) return 'reduced';
  const forced = typeof location !== 'undefined' && new URLSearchParams(location.search).has('dockFallback');
  const supported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timeline: scroll()');
  return supported && !forced ? 'timeline' : 'js';
}

/**
 * Track Z: the game page's docking header. A sticky, zero-height layer at the top of the page
 * whose bar holds Back, the docked cover, the title and (once docked) Play. The hero's own cover,
 * title and actions hand over to it as you scroll:
 * - `timeline` mode: CSS scroll-driven animations (`animation-timeline`) on the compositor;
 * - `js` mode: the same keyframes, paused and scrubbed from a passive, rAF-throttled scroll
 *   listener (one custom property per frame, no layout reads);
 * - `reduced` mode (reduced motion): no scroll-linked motion; the bar fades in once docked.
 * Geometry is measured with layout offsets once, and again only on resize.
 */
export function HeroDock({
  game,
  hero,
  cover,
  title,
  back,
}: {
  game: Game;
  hero: RefObject<HTMLElement | null>;
  cover: RefObject<HTMLElement | null>;
  title: RefObject<HTMLElement | null>;
  back: ReactNode;
}) {
  const reduce = useReducedMotion();
  const live = useMemo(() => pickMode(reduce), [reduce]);
  const barRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const titleSlotRef = useRef<HTMLSpanElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [docked, setDocked] = useState(false);

  // Measure (layout offsets only), publish the keyframes' lengths, and keep them current on resize.
  // A passive effect: the hero after this layer has attached its refs by then (and until it runs,
  // the page simply shows the undocked hero).
  useEffect(() => {
    const heroEl = hero.current;
    const root = heroEl?.parentElement;
    const bar = barRef.current;
    const slot = slotRef.current;
    const titleSlot = titleSlotRef.current;
    if (!heroEl || !root || !bar || !slot || !titleSlot) return;
    const scroller = root.closest<HTMLElement>('[data-scroll-main]');
    let keys: string[] = [];
    let distance = dockDistance(heroEl.offsetHeight, BAR_H);
    let frame = 0;

    const scrub = () => {
      frame = 0;
      if (scroller) root.style.setProperty('--dock-p', dockProgress(scroller.scrollTop, distance).toFixed(4));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(scrub);
    };

    const measure = () => {
      const coverBox = layoutBox(cover.current, root);
      const titleBox = layoutBox(title.current, root);
      const vars = dockVars({
        heroH: heroEl.offsetHeight,
        barH: BAR_H,
        cover: coverBox,
        coverSlot: layoutBox(slot, bar) ?? { x: 0, y: 0, w: 32, h: 48 },
        title: titleBox,
        titleSlot: layoutBox(titleSlot, bar) ?? { x: 0, y: 0, w: 0, h: 22 },
      });
      distance = dockDistance(heroEl.offsetHeight, BAR_H);
      for (const k of keys) if (!(k in vars)) root.style.removeProperty(k);
      for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
      keys = Object.keys(vars);
      root.dataset.cover = coverBox ? 'fly' : 'fade';
      if (sentinelRef.current) sentinelRef.current.style.top = `${Math.round(distance * DOCKED_AT)}px`;
      scrub();
    };

    measure();
    root.dataset.dock = live;
    const ro = new ResizeObserver(measure);
    for (const el of [heroEl, cover.current, title.current, bar]) if (el) ro.observe(el);
    if (live === 'js') scroller?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      scroller?.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      for (const k of [...keys, '--dock-p']) root.style.removeProperty(k);
      delete root.dataset.dock;
      delete root.dataset.cover;
    };
  }, [hero, cover, title, live, game.id]);

  // Docked or not: a sentinel at the docking point leaves the top of the scroller. No scroll handler needed.
  useEffect(() => {
    const el = sentinelRef.current;
    const scroller = el?.closest<HTMLElement>('[data-scroll-main]');
    if (!el || !scroller || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      ([e]) => {
        const top = e.rootBounds?.top ?? 0;
        setDocked(!e.isIntersecting && e.boundingClientRect.top < top);
      },
      { root: scroller, threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [game.id]);

  // The bar's glass takes a hint of the game's palette.
  useEffect(() => {
    const root = hero.current?.parentElement;
    if (!root) return;
    let alive = true;
    const apply = (accent: string) => alive && root.style.setProperty('--dk-tint', accent);
    const peek = peekPalette(game);
    if (peek) apply(peek.accent);
    else void paletteFor(game).then((p) => apply(p.accent)).catch(() => undefined);
    return () => {
      alive = false;
      root.style.removeProperty('--dk-tint');
    };
  }, [game, hero]);

  const fade = live === 'reduced' ? { initial: false, animate: { opacity: docked ? 1 : 0 }, transition: { duration: 0.15 } } : {};

  return (
    <>
      <div className="ddock" data-docked={docked || undefined}>
        <div className="ddock__bar" ref={barRef}>
          <motion.div className="ddock__glass dk" aria-hidden {...fade} />
          {back}
          <div className="ddock__slot" ref={slotRef} aria-hidden>
            <motion.div className="ddock__cover dk" {...fade}>
              <span className="ddock__cover-lift dk" />
              <span className="ddock__cover-art">
                <GameCover game={game} />
              </span>
            </motion.div>
          </div>
          <motion.span className="ddock__title dk" ref={titleSlotRef} aria-hidden {...fade}>
            {game.title}
          </motion.span>
          {docked && (
            <motion.div
              className="ddock__play dk"
              initial={live === 'reduced' ? { opacity: 0 } : false}
              animate={live === 'reduced' ? { opacity: 1 } : undefined}
              transition={{ duration: 0.15 }}
            >
              <PlayButton game={game} />
            </motion.div>
          )}
        </div>
      </div>
      <div className="ddock__sentinel" ref={sentinelRef} aria-hidden />
    </>
  );
}
