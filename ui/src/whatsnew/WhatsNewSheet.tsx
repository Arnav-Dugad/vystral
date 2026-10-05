import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Activity, ArrowLeft, ArrowRight, BadgeCheck, Bell, CalendarDays, Gamepad2, HardDrive, Palette, Rocket, ShieldCheck, Sparkles, Trophy, Undo2, X,
} from 'lucide-react';
import { exit, pick, spring } from '../lib/motion';
import { pushPadHandler } from '../lib/input';
import { useReducedMotion, useStore } from '../state/store';
import { Button } from '../components/ui/primitives';
import { openUpdateCenter } from '../components/shell/UpdateCenter';
import type { Tour, TourCard, TourIcon } from './tours';
import './whatsnew.css';

const ICONS: Record<TourIcon, ReactNode> = {
  sparkles: <Sparkles />, rocket: <Rocket />, undo: <Undo2 />, activity: <Activity />, badge: <BadgeCheck />, calendar: <CalendarDays />,
  trophy: <Trophy />, 'hard-drive': <HardDrive />, gamepad: <Gamepad2 />, palette: <Palette />, bell: <Bell />, shield: <ShieldCheck />,
};

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * The "What's new" tour: 3–6 cards, one at a time. Next/Back buttons, ←/→ or PageUp/PageDown,
 * controller LB/RB to page, A to press, B or Escape to close. Skippable at any point; with reduced
 * motion the cards simply cross-fade.
 */
export function WhatsNewSheet({ tour, onClose }: { tour: Tour; onClose: () => void }) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [dir, setDir] = useState(1);
  const ref = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const card = tour.cards[index];
  const last = index === tour.cards.length - 1;

  const go = useCallback((to: number) => {
    setIndex((i) => {
      const n = Math.max(0, Math.min(tour.cards.length - 1, to));
      setDir(n >= i ? 1 : -1);
      return n;
    });
  }, [tour.cards.length]);
  const next = useCallback(() => (last ? onClose() : go(index + 1)), [last, onClose, go, index]);
  const prev = useCallback(() => go(index - 1), [go, index]);

  // Focus in on open, back where it was on close; keyboard paging and a Tab trap.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => nextRef.current?.focus(), 40);
    return () => {
      window.clearTimeout(t);
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        prev();
      } else if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (!items.length) return;
        const first = items[0], lastItem = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastItem.focus(); }
        else if (!e.shiftKey && document.activeElement === lastItem) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [next, prev, onClose]);

  // Controller: LB/RB page, B closes; everything else (A, the d-pad) works as usual.
  useEffect(() => pushPadHandler((button, repeat) => {
    if (repeat) return button === 'LB' || button === 'RB';
    if (button === 'LB') { prev(); return true; }
    if (button === 'RB') { next(); return true; }
    if (button === 'B') { onClose(); return true; }
    if (button === 'Menu' || button === 'Y') return true; // no mode switch or search under the tour
    return false;
  }), [next, prev, onClose]);

  const runAction = (c: TourCard) => {
    if (!c.action) return;
    onClose();
    if (c.action.to === 'updates') openUpdateCenter();
    else useStore.getState().navigate(c.action.to);
  };

  const hue = card.hue ?? 285;
  const slide = reduce ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } } : {
    initial: { opacity: 0, x: 48 * dir, filter: 'blur(6px)' },
    animate: { opacity: 1, x: 0, filter: 'blur(0px)' },
    exit: { opacity: 0, x: -36 * dir, filter: 'blur(4px)', transition: exit },
  };

  return createPortal(
    <motion.div
      className="wn-backdrop"
      data-dialog-open
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: exit }}
      transition={pick(reduce, spring.effect)}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        ref={ref}
        className="wn"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wn-title"
        aria-describedby="wn-card-body"
        data-testid="whats-new"
        style={{ ['--wn-hue' as string]: hue }}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98, transition: exit }}
        transition={pick(reduce, spring.panel)}
      >
        <div className="wn__head">
          <div>
            <div className="wn__kicker">What’s new · <span className="num">{tour.version}</span></div>
            <h2 id="wn-title" className="wn__title">{tour.title}</h2>
          </div>
          <button className="wn__close" onClick={onClose} aria-label="Skip the tour">
            <X size={18} aria-hidden />
          </button>
        </div>
        {tour.subtitle && index === 0 && <p className="wn__subtitle">{tour.subtitle}</p>}

        <div className="wn__stage">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.section
              key={card.key + index}
              className="wn__card"
              aria-roledescription="slide"
              aria-label={`${index + 1} of ${tour.cards.length}: ${card.title}`}
              {...slide}
              transition={pick(reduce, spring.panel)}
            >
              <TourArt icon={card.icon ?? 'sparkles'} reduce={reduce} />
              <div className="wn__text">
                <div className="wn__eyebrow">{card.eyebrow}</div>
                <h3 className="wn__card-title">{card.title}</h3>
                <p id="wn-card-body" className="wn__body">{card.body}</p>
                {card.action && (
                  <Button size="sm" variant="secondary" icon={<ArrowRight size={14} />} onClick={() => runAction(card)}>
                    {card.action.label}
                  </Button>
                )}
              </div>
            </motion.section>
          </AnimatePresence>
        </div>

        <div className="wn__foot">
          <div className="wn__dots" aria-label="Cards">
            {tour.cards.map((c, i) => (
              <button
                key={c.key + i}
                className="wn__dot"
                aria-label={`Card ${i + 1} of ${tour.cards.length}: ${c.title}`}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => go(i)}
              >
                {i === index && <motion.span layoutId="wn-dot" className="wn__dot-fill" transition={reduce ? { duration: 0 } : spring.focus} />}
              </button>
            ))}
          </div>
          <span className="wn__hint" aria-hidden>
            <span className="wn__hint-pad"><span className="kbd">LB</span><span className="kbd">RB</span></span>
            <span className="wn__hint-keys"><span className="kbd">←</span><span className="kbd">→</span></span>
          </span>
          <div className="wn__nav">
            <Button variant="ghost" icon={<ArrowLeft size={15} />} onClick={prev} disabled={index === 0}>Back</Button>
            <Button ref={nextRef} variant="primary" onClick={next}>
              {last ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** A soft orb in the card's hue with a slowly turning ring and a few drifting sparks. */
function TourArt({ icon, reduce }: { icon: TourIcon; reduce: boolean }) {
  return (
    <div className="wn-art" aria-hidden>
      <motion.div
        className="wn-art__ring"
        animate={reduce ? undefined : { rotate: 360 }}
        transition={reduce ? undefined : { duration: 18, ease: 'linear', repeat: Infinity }}
      />
      {!reduce && [0, 1, 2, 3, 4].map((i) => (
        <motion.span
          key={i}
          className="wn-art__spark"
          style={{ left: `${18 + i * 16}%`, top: `${22 + ((i * 37) % 56)}%` }}
          animate={{ y: [0, -10, 0], opacity: [0.25, 0.9, 0.25] }}
          transition={{ duration: 3.2 + i * 0.45, repeat: Infinity, ease: 'easeInOut', delay: i * 0.3 }}
        />
      ))}
      <motion.div
        className="wn-art__icon"
        initial={reduce ? false : { scale: 0.6, rotate: -12, opacity: 0 }}
        animate={{ scale: 1, rotate: 0, opacity: 1 }}
        transition={pick(reduce, spring.hero)}
      >
        {ICONS[icon]}
      </motion.div>
    </div>
  );
}
