import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { AnimatePresence, motion, useSpring } from 'motion/react';
import { ArrowDownToLine, Play, RefreshCw, RotateCcw, Square, Store, X } from 'lucide-react';
import { StoreLogo } from '../ui/StoreLogo';
import { call, errorMessage } from '../../bridge/bridge';
import type { Game } from '../../bridge/types';
import { exit, spring } from '../../lib/motion';
import { setLaunchOrigin } from '../../lib/flight';
import { haptic } from '../../lib/haptics';
import { useInstallFor } from '../../state/installs';
import { useReducedMotion, useStore } from '../../state/store';
import { ProgressRing } from './InstallProgress';
import { openInStore, SteamInstallDialog } from './InstallButton';
import { derivePlayState, familyLabels, type PlayIcon, type PlayState } from './playState';
import './play-button.css';

/**
 * The game page's one Play button. It morphs between every state the game can be in —
 * Play → Launching (learned progress arc) → Playing (live timer; click switches to the game) →
 * Installing / Updating (radial ring + glide fill from Steam's manifests) → Install / Install in
 * store / Rescan — without moving anything around it: the button reserves the width of the
 * widest label it can show, the same <button> element stays mounted (so keyboard and controller
 * focus never drop), and state changes are announced politely. Reduced motion swaps the morphs
 * for an instant crossfade.
 */
export function PlayButton({ game, autoFocus = false, joined = false }: { game: Game; autoFocus?: boolean; joined?: boolean }) {
  const launch = useStore((s) => s.launch);
  const launchGame = useStore((s) => s.launchGame);
  const toast = useStore((s) => s.toast);
  const install = useInstallFor(game.id);
  const reduce = useReducedMotion();
  const [, setTick] = useState(0);
  const [installOpen, setInstallOpen] = useState(false);

  // Date.now() each render: the tick below only exists to re-render the timer / launch arc.
  const state = derivePlayState({ game, launch, install, now: Date.now() });
  const ticking = state.kind === 'running' ? 1000 : state.kind === 'launching' && state.fraction != null ? 250 : 0;
  useEffect(() => {
    if (!ticking) return;
    const t = window.setInterval(() => setTick((n) => n + 1), ticking);
    return () => window.clearInterval(t);
  }, [ticking]);

  /* ---------------------------------------------------------------- width */

  const rows = useMemo(() => familyLabels(game, state.family), [game, state.family]);
  const sizerRef = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = sizerRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.ceil(el.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure); // fonts arriving late, root size changes (Immersive)
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows]);

  /* ---------------------------------------------------------------- announcements */

  const [said, setSaid] = useState('');
  const spoken = useRef({ game: game.id, key: `${state.kind}|${state.label}` });
  useEffect(() => {
    const key = `${state.kind}|${state.label}`;
    const prev = spoken.current;
    if (prev.game === game.id && prev.key === key) return;
    spoken.current = { game: game.id, key };
    // Opening another game's page isn't a change of state; only real transitions are spoken.
    setSaid(prev.game === game.id ? state.announce : '');
  }, [game.id, state.kind, state.label, state.announce]);

  /* ---------------------------------------------------------------- progress fill */

  const showFill = state.tone === 'progress' && state.fraction != null;
  const fill = useSpring(state.fraction ?? 0, { stiffness: 70, damping: 20, restDelta: 0.0005 });
  useEffect(() => {
    if (state.fraction == null) return;
    if (reduce) fill.jump(state.fraction);
    else fill.set(state.fraction);
  }, [state.fraction, reduce, fill]);

  /* ---------------------------------------------------------------- actions */

  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (!state.actionable) {
      haptic('error'); // a controller press on a busy button: feel it, nothing happens
      return;
    }
    switch (state.kind) {
      case 'play':
      case 'failed':
        setLaunchOrigin(game.id, e.currentTarget, document.querySelector(`.dhero__cover[data-game-id="${game.id}"]`));
        haptic('confirm'); // only buzzes when Play came from a controller
        void launchGame(game.id);
        return;
      case 'running':
        void call<boolean>('game.focus')
          .then((ok) => {
            if (ok === false) toast({ tone: 'info', title: `Couldn’t switch to ${game.title}`, body: 'Windows didn’t let VYSTRAL bring it forward. Use Alt+Tab to switch to it.' });
          })
          .catch((err) => toast({ tone: 'info', title: `Couldn’t switch to ${game.title}`, body: errorMessage(err) }));
        return;
      case 'install':
        setInstallOpen(true);
        return;
      case 'storeInstall':
      case 'installing':
      case 'updating':
        if (state.store) openInStore(state.store);
        return;
      case 'missing':
        void useStore.getState().scanLibrary();
        return;
    }
  };

  const aux =
    state.kind === 'running'
      ? { label: 'Stop tracking this session. The game keeps running.', title: 'Stop tracking (the game keeps running)', icon: <Square size={12} fill="currentColor" />, run: () => void call('game.stopTracking').catch(() => {}) }
      : state.kind === 'installing' && install?.watching
        ? { label: 'Stop showing progress. Steam keeps installing.', title: 'Stop showing progress (Steam keeps installing)', icon: <X size={15} />, run: () => void call('steam.forgetInstall', { gameId: game.id }).catch(() => {}) }
        : null;

  const fade = reduce ? { duration: 0.15, ease: 'linear' as const } : undefined;

  return (
    <span
      className="pbtn"
      data-state={state.kind}
      data-tone={state.tone}
      data-aux={aux ? '' : undefined}
      data-joined={joined || undefined}
      style={width ? ({ width } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="pbtn__main"
        aria-label={state.name}
        aria-disabled={!state.actionable || undefined}
        aria-busy={state.kind === 'launching' || undefined}
        onClick={onClick}
        data-autofocus={autoFocus || undefined}
        data-play-button
      >
        <span className="pbtn__bg pbtn__bg--primary" aria-hidden />
        <span className="pbtn__bg pbtn__bg--quiet" aria-hidden />
        <motion.span className="pbtn__fill" aria-hidden style={{ scaleX: fill }} data-on={showFill || undefined} />
        <span className="pbtn__content" aria-hidden>
          <motion.span className="pbtn__icon" layout={reduce ? false : 'position'} transition={spring.focus}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={state.icon}
                className="pbtn__glyph"
                initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.4, rotate: -40 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                exit={reduce ? { opacity: 0, transition: fade } : { opacity: 0, scale: 0.4, rotate: 40, transition: exit }}
                transition={fade ?? spring.focus}
              >
                <Glyph icon={state.icon} state={state} />
              </motion.span>
            </AnimatePresence>
          </motion.span>
          <motion.span className="pbtn__label" layout={reduce ? false : 'position'} transition={spring.focus}>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={state.label}
                className="pbtn__text"
                initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                exit={reduce ? { opacity: 0, transition: fade } : { opacity: 0, y: -12, filter: 'blur(6px)', transition: exit }}
                transition={fade ?? spring.panel}
              >
                {state.label}
              </motion.span>
            </AnimatePresence>
            {state.detail && <span className="pbtn__detail num">{state.detail}</span>}
          </motion.span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {aux && (
          <motion.button
            key={state.kind}
            type="button"
            className="pbtn__aux"
            aria-label={aux.label}
            title={aux.title}
            onClick={aux.run}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? { opacity: 0, transition: fade } : { opacity: 0, scale: 0.6, transition: exit }}
            transition={fade ?? spring.focus}
          >
            {aux.icon}
          </motion.button>
        )}
      </AnimatePresence>
      <span className="pbtn__sizer" ref={sizerRef} aria-hidden>
        {rows.map((r) => (
          <span key={`${r.label}|${r.detail}`} className="pbtn__row" data-aux={r.aux || undefined}>
            <span className="pbtn__icon" />
            <span className="pbtn__label">
              <span className="pbtn__text">{r.label}</span>
              {r.detail && <span className="pbtn__detail num">{r.detail}</span>}
            </span>
          </span>
        ))}
      </span>
      <span className="visually-hidden" role="status" aria-live="polite">
        {said}
      </span>
      {state.kind === 'install' && state.store && <SteamInstallDialog game={game} inst={state.store} open={installOpen} onClose={() => setInstallOpen(false)} />}
    </span>
  );
}

function Glyph({ icon, state }: { icon: PlayIcon; state: PlayState }) {
  switch (icon) {
    case 'play':
      return <Play size={22} fill="currentColor" />;
    case 'ring':
      return <ProgressRing fraction={state.fraction} size={26} stroke={3} showPercent={false} label={state.name} tone={state.kind === 'installing' && state.label.startsWith('Paused') ? 'muted' : 'accent'} />;
    case 'live':
      return <span className="pbtn__live" />;
    case 'retry':
      return <RotateCcw size={20} />;
    case 'download':
      return <ArrowDownToLine size={21} />;
    case 'store':
      // Track R: "Install in EA app" shows the EA mark, so you see where you're going.
      return state.store ? <StoreLogo platform={state.store.platform} size={20} decorative motion /> : <Store size={20} />;
    case 'rescan':
      return <RefreshCw size={19} />;
    default:
      return null;
  }
}
