import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ArrowDownToLine, CircleSlash, ExternalLink, Flag, Heart, MonitorCog, Play, Store, Trophy } from 'lucide-react';
import type { Game, GameStatus, GamepadButton } from '../../bridge/types';
import { haptic } from '../../lib/haptics';
import { pushPadHandler } from '../../lib/input';
import { ease, pick, spring } from '../../lib/motion';
import { STATUS_META, STATUSES } from '../../lib/status';
import { isInstalled, PLATFORM_NAMES } from '../../lib/format';
import { sound } from '../../lib/sound';
import { moodFor } from '../../lib/mood';
import { useReducedMotion } from '../../state/store';
import { PadGlyph } from '../../components/ui/primitives';
import { radialHit, radialOffset, radialStep, type RadialDir } from './radial';

export type QuickAction =
  | { kind: 'play' }
  | { kind: 'install' }
  | { kind: 'favorite' }
  | { kind: 'status'; status: GameStatus | null }
  | { kind: 'achievements' }
  | { kind: 'store' }
  | { kind: 'display' };

interface Item {
  id: string;
  label: string;
  icon: ReactNode;
  action?: QuickAction;
  /** Opens the status ring instead of acting. */
  sub?: 'status';
  disabled?: boolean;
  pressed?: boolean;
}

const DIRS: Partial<Record<GamepadButton | string, RadialDir>> = {
  Up: 'up', Down: 'down', Left: 'left', Right: 'right', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

function mainItems(game: Game): Item[] {
  const installed = isInstalled(game);
  const steamInstall = game.installations.find((i) => i.platform === 'steam' && i.state !== 'installed' && /^\d{1,10}$/.test(i.platformGameId));
  const storeInst = game.installations.find((i) => i.platform !== 'manual');
  const play: Item = installed
    ? { id: 'play', label: 'Play', icon: <Play size="1.3em" fill="currentColor" />, action: { kind: 'play' } }
    : steamInstall
      ? { id: 'play', label: 'Install with Steam', icon: <ArrowDownToLine size="1.3em" />, action: { kind: 'install' } }
      : storeInst
        ? { id: 'play', label: `Get it in ${PLATFORM_NAMES[storeInst.platform]}`, icon: <Store size="1.3em" />, action: { kind: 'store' } }
        : { id: 'play', label: 'Not installed', icon: <Play size="1.3em" />, disabled: true };
  return [
    play,
    { id: 'favorite', label: game.favorite ? 'Remove from favorites' : 'Add to favorites', icon: <Heart size="1.3em" fill={game.favorite ? 'currentColor' : 'none'} />, action: { kind: 'favorite' }, pressed: game.favorite },
    { id: 'status', label: game.status ? `Status: ${STATUS_META[game.status].label}` : 'Set status', icon: <Flag size="1.3em" />, sub: 'status' },
    { id: 'display', label: 'Display & text size', icon: <MonitorCog size="1.3em" />, action: { kind: 'display' } },
    { id: 'storepage', label: storeInst ? `${PLATFORM_NAMES[storeInst.platform]} page` : 'No store page', icon: <ExternalLink size="1.3em" />, action: { kind: 'store' }, disabled: !storeInst },
    { id: 'achievements', label: 'Achievements', icon: <Trophy size="1.3em" />, action: { kind: 'achievements' } },
  ];
}

function statusItems(game: Game): Item[] {
  return [
    ...STATUSES.map((s) => {
      const Icon = s.icon;
      return { id: `status-${s.value}`, label: s.label, icon: <Icon size="1.3em" />, action: { kind: 'status' as const, status: s.value }, pressed: game.status === s.value } satisfies Item;
    }),
    { id: 'status-clear', label: 'Clear status', icon: <CircleSlash size="1.3em" />, action: { kind: 'status', status: null }, disabled: !game.status },
  ];
}

/**
 * Immersive quick menu (Track L): a radial of the actions you'd otherwise dig for — Play or
 * install, favourite, play status (a second ring), the store page, achievements, and the couch
 * display settings. Hold X or press View on a game; the D-pad picks a petal (nearest to the
 * direction, pressing again walks to its neighbour), A acts, B steps back or closes. Mouse and
 * keyboard work too. It never acts on hidden UI: while it is open it owns all input.
 */
export function QuickMenu({ game, anchor, onAction, onClose }: { game: Game; anchor: { x: number; y: number }; onAction: (a: QuickAction) => void; onClose: () => void }) {
  const reduce = useReducedMotion();
  const present = useIsPresent();
  const uid = useId();
  const [ring, setRing] = useState<'main' | 'status'>('main');
  const items = useMemo(() => (ring === 'main' ? mainItems(game) : statusItems(game)), [ring, game]);
  const [index, setIndex] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const restore = useRef<HTMLElement | null>(null);
  const mood = moodFor(game);

  // Clamp the ring inside the window (its radius is ~10rem plus the petals).
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize) || 20;
  const radius = 9.2 * root;
  const margin = radius + 2.8 * root;
  const cx = Math.min(innerWidth - margin, Math.max(margin, anchor.x));
  const cy = Math.min(innerHeight - margin, Math.max(margin, anchor.y));

  useLayoutEffect(() => {
    restore.current ??= document.activeElement as HTMLElement | null;
    refs.current[index]?.focus({ preventScroll: true });
  }, [index, ring]);

  useEffect(
    () => () => {
      const back = restore.current;
      if (back?.isConnected) back.focus({ preventScroll: true });
    },
    [],
  );

  const feedback = (i: number) => {
    const el = refs.current[i];
    const r = el?.getBoundingClientRect();
    sound.spatial('focus', mood, { x: r ? r.left + r.width / 2 : cx, width: innerWidth, depth: r ? Math.round((r.top / innerHeight) * 4) : 1 });
  };

  const select = (i: number) => {
    const item = items[i];
    if (!item || item.disabled) {
      haptic('error');
      return;
    }
    if (item.sub === 'status') {
      setRing('status');
      setIndex(Math.max(0, STATUSES.findIndex((s) => s.value === game.status)));
      sound.select();
      haptic('tick');
      return;
    }
    if (item.action) {
      haptic(item.action.kind === 'play' ? 'confirm' : 'tick');
      onAction(item.action);
    }
  };

  const back = () => {
    if (ring === 'status') {
      setRing('main');
      setIndex(2);
      sound.back();
      return;
    }
    sound.back();
    onClose();
  };

  const handle = (button: string, repeat: boolean): boolean => {
    if (!present) return true;
    const dir = DIRS[button];
    if (dir) {
      const next = radialStep(index, items.length, dir);
      if (next !== index) {
        setIndex(next);
        feedback(next);
      } else haptic('edge');
      return true;
    }
    if (repeat) return true;
    switch (button) {
      case 'A': case 'Enter': case ' ': select(index); return true;
      case 'B': case 'Escape': case 'View': case 'Y': back(); return true;
      default: return true; // the quick menu owns every button while open
    }
  };
  const handleRef = useRef(handle);
  useLayoutEffect(() => {
    handleRef.current = handle;
  });
  useEffect(() => {
    if (!present) return;
    return pushPadHandler((b, r) => handleRef.current(b, r));
  }, [present]);

  return (
    <motion.div
      className="imm-quick"
      data-dialog-open={present || undefined}
      inert={!present || undefined}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.16, ease: ease.in } }}
      transition={pick(reduce, spring.effect)}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          e.preventDefault();
          setIndex((i) => (i + (e.shiftKey ? items.length - 1 : 1)) % items.length);
          return;
        }
        if (handle(e.key, e.repeat)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      onPointerMove={(e) => {
        if (e.movementX === 0 && e.movementY === 0) return;
        const hit = radialHit(e.clientX - cx, e.clientY - cy, items.length, radius * 0.45);
        if (hit >= 0 && hit !== index) setIndex(hit);
      }}
    >
      <div
        role="menu"
        aria-label={ring === 'main' ? `Quick actions for ${game.title}` : `Play status for ${game.title}`}
        aria-orientation="horizontal"
        className="imm-quick__ring"
        style={{ left: cx, top: cy, ['--radius' as string]: `${radius}px` }}
      >
        <motion.div
          key={ring}
          className="imm-quick__disc"
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={pick(reduce, spring.hero)}
        >
          <motion.div
            className="imm-quick__pointer"
            aria-hidden
            initial={false}
            animate={{ rotate: (360 / items.length) * index }}
            transition={pick(reduce, spring.focus)}
          />
          <div className="imm-quick__label" aria-hidden>
            <span className="imm-quick__title">{items[index]?.label}</span>
            <span className="imm-quick__game">{ring === 'status' ? 'Play status' : game.title}</span>
          </div>
        </motion.div>
        {items.map((item, i) => {
          const o = radialOffset(i, items.length);
          return (
            <motion.button
              key={`${ring}-${item.id}`}
              id={`${uid}-${i}`}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role={item.pressed === undefined ? 'menuitem' : 'menuitemcheckbox'}
              className="imm-quick__petal"
              data-selected={i === index}
              aria-disabled={item.disabled || undefined}
              aria-checked={item.pressed}
              aria-label={item.label}
              tabIndex={i === index ? 0 : -1}
              initial={reduce ? { opacity: 0, x: o.x * radius, y: o.y * radius } : { opacity: 0, x: 0, y: 0, scale: 0.4 }}
              animate={{ opacity: 1, x: o.x * radius, y: o.y * radius, scale: i === index ? 1.14 : 1 }}
              transition={reduce ? { duration: 0.15 } : { ...spring.hero, delay: 0.02 * i }}
              onMouseEnter={() => setIndex(i)}
              onClick={() => select(i)}
            >
              {item.icon}
            </motion.button>
          );
        })}
      </div>
      <footer className="imm-quick__hints" aria-hidden>
        <span><PadGlyph button="A" /> Select</span>
        <span><PadGlyph button="B" /> {ring === 'status' ? 'Back' : 'Close'}</span>
      </footer>
    </motion.div>
  );
}
