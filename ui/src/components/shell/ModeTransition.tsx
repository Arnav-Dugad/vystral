import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { on } from '../../bridge/bridge';
import type { Game } from '../../bridge/types';
import { pushPadHandler } from '../../lib/input';
import { ease } from '../../lib/motion';
import {
  IDLE, inputPolicy, setEntryFocus, SWITCH_TIMING, switchKind, switchReducer, zoomFrom,
  type AppMode, type Rect, type SwitchEvent, type SwitchKind, type SwitchState,
} from '../../lib/modeSwitch';
import { homeRows, tileGame } from '../../views/immersive/rows';
import { registerModeSwitcher, useStore } from '../../state/store';
import { GameCover } from '../game/GameCover';
import './mode-transition.css';

/**
 * The signature desktop ↔ Immersive switch (Track L). A full-window overlay does all the visible
 * work so the native window can change presenter (windowed ↔ full screen) underneath it without
 * any flash or visible resize:
 *
 * - **Out** (~380 ms): the old layout folds away (CSS, keyed on `data-mode-switch="out"`), the
 *   focused game's art zooms from its card to fill the window with a light sweep, and the
 *   VYSTRAL star flares in the middle. The overlay ends fully opaque.
 * - **Commit**: the layout swaps and `window.setMode` runs; we wait for Windows to finish the
 *   resize (`settle`, a few frames at most) with the new layout held at its first frame.
 * - **In** (~500 ms): the art settles into Immersive's own backdrop (or recedes into depth when
 *   going back to the desktop), the star flies into the mark of the new layout, and the new
 *   layout rises in with staggered springs.
 *
 * Any key, click, wheel or controller button skips; before the commit the input is swallowed,
 * after it the input also reaches the new layout. Reduced motion (or the setting off) is a quick
 * crossfade; nothing animates while a game is starting or running, or when the window is hidden.
 */

interface Run {
  id: number;
  target: AppMode;
  kind: Exclude<SwitchKind, 'instant'>;
  phase: SwitchState['phase'];
  game: Game | null;
  from: { x: number; y: number; scale: number };
  /** Where the star lands (the mark of the new layout), measured when it appears. */
  mark: Rect | null;
}

const STAR = 132; // px, the star's drawn size

let active: { target: AppMode; done: Promise<void>; skip: () => void } | null = null;
let seq = 0;

const nextFrame = () =>
  new Promise<void>((resolve) => {
    // rAF stops in a hidden window; the timeout keeps the switch from ever hanging.
    const t = window.setTimeout(() => {
      cancelAnimationFrame(id);
      resolve();
    }, 60);
    const id = requestAnimationFrame(() => {
      window.clearTimeout(t);
      resolve();
    });
  });

function rectOf(el: Element | null | undefined): Rect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * Where an element sits in the layout, ignoring transforms (the new layout's mark is still on the
 * first frame of its entrance — translated off screen — when the star needs its destination).
 */
function layoutRect(el: HTMLElement | null): Rect | null {
  if (!el) return null;
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return el.offsetWidth > 4 ? { x, y, w: el.offsetWidth, h: el.offsetHeight } : null;
}

/** The game whose art leads the switch, and where on screen it is now. */
function pickSource(target: AppMode): { game: Game | null; rect: Rect | null } {
  const s = useStore.getState();
  if (target === 'desktop') {
    // Leaving Immersive: the focused game is its full-screen backdrop already.
    const g = s.focusGameId ? s.gamesById.get(s.focusGameId) ?? null : null;
    return { game: g, rect: null };
  }
  const active = (document.activeElement as HTMLElement | null)?.closest?.<HTMLElement>('[data-game-id]');
  const focusedId = active?.getAttribute('data-game-id') ?? null;
  const routeId = s.route.name === 'game' ? s.route.id : null;
  const id = routeId ?? focusedId;
  let game = id ? s.gamesById.get(id) ?? null : null;
  if (!game || game.hidden) {
    // Otherwise the game Immersive opens on: the first tile of its first row.
    const visible = s.library.games.filter((g) => !g.hidden);
    game = tileGame(homeRows(visible, s.library.collections, Date.now(), new Date().getHours())[0]?.tiles[0]) ?? null;
  }
  if (!game) return { game: null, rect: null };
  const sel = `[data-game-id="${CSS.escape(game.id)}"]`;
  const el =
    (routeId === game.id ? document.querySelector('.dhero__cover') : null) ??
    (active?.getAttribute('data-game-id') === game.id ? active.querySelector('.cover') ?? active : null) ??
    [...document.querySelectorAll(`${sel} .cover, ${sel}.cover`)].find((e) => rectOf(e)) ??
    // Home's featured hero (it names its game in its label).
    (document.querySelector('.hero')?.getAttribute('aria-label') === `Featured: ${game.title}` ? document.querySelector('.hero__art') : null) ??
    null;
  return { game, rect: rectOf(el) };
}

export function ModeTransition() {
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const switcher = async (target: AppMode, commit: () => Promise<void>): Promise<void> => {
      if (active) {
        if (active.target === target) return active.done;
        active.skip();
        await active.done;
        if (useStore.getState().window.mode === target) return;
      }
      const s = useStore.getState();
      const reduce = s.settings?.['motion.reduce'] === 'on' ? true : s.settings?.['motion.reduce'] === 'off' ? false : s.systemReducedMotion;
      const kind = switchKind({
        setting: s.settings?.['immersive.cinematicSwitch'] ?? true,
        reducedMotion: reduce,
        gameActive: !!s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase),
        hidden: document.visibilityState === 'hidden',
        safeMode: !!s.info?.safeMode,
      });
      if (kind === 'instant') return commit();

      const timing = SWITCH_TIMING[kind];
      const id = ++seq;
      let state: SwitchState = IDLE;
      const waiters = new Set<() => void>();
      const dispatch = (e: SwitchEvent) => {
        state = switchReducer(state, e);
      };
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          if (state.skipped) return resolve();
          const done = () => {
            window.clearTimeout(t);
            waiters.delete(done);
            resolve();
          };
          const t = window.setTimeout(done, ms);
          waiters.add(done);
        });
      const skip = () => {
        if (state.phase === 'idle') return;
        dispatch({ type: 'skip' });
        waiters.forEach((f) => f());
        if ((state.phase as string) === 'idle') finish();
      };

      // Input skips; before the commit it is swallowed (the layout it was aimed at is leaving).
      const onInput = (e: Event) => {
        const policy = inputPolicy(state.phase);
        if (policy === 'none') return;
        if (policy === 'swallow') {
          e.preventDefault();
          e.stopPropagation();
        }
        skip();
      };
      // Controller: swallowed before the commit; after it the new layout's own handler sits above
      // this one, so presses are also watched directly to skip the rest of the animation.
      const popPad = pushPadHandler(() => {
        const policy = inputPolicy(state.phase);
        skip();
        return policy === 'swallow';
      });
      const offPadWatch = on('gamepad.button', (e) => {
        if (e.pressed && inputPolicy(state.phase) === 'pass') skip();
      });
      addEventListener('keydown', onInput, true);
      addEventListener('pointerdown', onInput, true);
      addEventListener('wheel', onInput, { capture: true, passive: true });
      // A game starting mid-switch ends the animation at once.
      const offLaunch = useStore.subscribe((st) => {
        if (st.launch && ['starting', 'waiting', 'running'].includes(st.launch.phase)) skip();
      });

      let resolveDone!: () => void;
      const done = new Promise<void>((r) => (resolveDone = r));
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        delete root.dataset.modeSwitch;
        delete root.dataset.modeSwitchTo;
        delete root.dataset.modeSwitchKind;
        removeEventListener('keydown', onInput, true);
        removeEventListener('pointerdown', onInput, true);
        removeEventListener('wheel', onInput, true);
        popPad();
        offPadWatch();
        offLaunch();
        setRun((r) => (r?.id === id ? null : r));
        if (active?.done === done) active = null;
        resolveDone();
      };
      active = { target, done, skip };

      const source = pickSource(target);
      if (target === 'immersive') setEntryFocus(source.game?.id ?? null);
      // Load Immersive's code now so it can mount the moment the overlay covers the window.
      if (target === 'immersive') void import('../../views/Immersive');
      window.dispatchEvent(new CustomEvent('vystral:mode-switch', { detail: { target } }));

      const from = target === 'immersive' ? zoomFrom(source.rect, innerWidth, innerHeight) : { x: 0, y: 0, scale: 1 };
      dispatch({ type: 'start', target });
      root.dataset.modeSwitch = 'out';
      root.dataset.modeSwitchTo = target;
      root.dataset.modeSwitchKind = kind;
      setRun({ id, target, kind, phase: 'out', game: source.game, from, mark: null });

      try {
        await wait(timing.out);
        dispatch({ type: 'outDone' });
        // The overlay covers the window now: swap layouts and let Windows change the presenter.
        root.dataset.modeSwitch = 'hold';
        setRun((r) => (r?.id === id ? { ...r, phase: 'commit' } : r));
        await commit();
        dispatch({ type: 'committed' });
        await settle(target, timing.settleMax, () => state.skipped);
        dispatch({ type: 'settled' });
        if (state.phase === 'idle') return finish();
        root.dataset.modeSwitch = 'in';
        const mark = layoutRect(document.querySelector<HTMLElement>(target === 'immersive' ? '.imm__mark' : '.titlebar__mark'));
        setRun((r) => (r?.id === id ? { ...r, phase: 'in', mark } : r));
        await wait(timing.in);
        dispatch({ type: 'inDone' });
      } finally {
        finish();
      }
    };
    return registerModeSwitcher(switcher);
  }, []);

  return (
    <AnimatePresence>
      {run && (run.kind === 'cinematic' ? <Cinematic key={run.id} run={run} /> : <Fade key={run.id} phase={run.phase} />)}
    </AnimatePresence>
  );
}

/** Longest wait for the new layout to mount (its code is preloaded, so this is a safety net). */
const MOUNT_MAX_MS = 2500;

/**
 * Waits until the new layout is in the page and (in the app) Windows has finished resizing the
 * window: the size changed and then held still for two frames. The resize wait never exceeds
 * `maxMs`; the overlay never clears onto an empty window unless mounting takes over 2.5 s.
 */
async function settle(target: AppMode, maxMs: number, skipped: () => boolean) {
  const start = performance.now();
  const selector = target === 'immersive' ? '.imm' : '.shell';
  const native = useStore.getState().native;
  const w0 = innerWidth;
  const h0 = innerHeight;
  let resized = !native; // nothing resizes in a browser
  let stable = 0;
  let last = `${w0}x${h0}`;
  while (performance.now() - start < MOUNT_MAX_MS) {
    await nextFrame();
    const now = `${innerWidth}x${innerHeight}`;
    if (innerWidth !== w0 || innerHeight !== h0) resized = true;
    stable = now === last ? stable + 1 : 0;
    last = now;
    const mounted = !!document.querySelector(selector);
    const resizeDone = (resized && stable >= 2) || performance.now() - start >= maxMs;
    if (mounted && (skipped() || resizeDone)) break;
  }
  await nextFrame();
}

/* ------------------------------------------------------------------ visuals */

function Fade({ phase }: { phase: Run['phase'] }) {
  return (
    <motion.div
      className="mt mt--fade"
      aria-hidden
      initial={{ opacity: 0 }}
      animate={{ opacity: phase === 'in' ? 0 : 1 }}
      exit={{ opacity: 0, transition: { duration: 0.12 } }}
      transition={{ duration: phase === 'in' ? SWITCH_TIMING.fade.in / 1000 : SWITCH_TIMING.fade.out / 1000, ease: 'linear' }}
    />
  );
}

function Cinematic({ run }: { run: Run }) {
  const { phase, target, from, game, mark } = run;
  const toImmersive = target === 'immersive';
  const out = SWITCH_TIMING.cinematic.out / 1000;
  const inn = SWITCH_TIMING.cinematic.in / 1000;
  const covering = phase !== 'in';

  // The star flies into the new layout's mark (centre to centre), shrinking to its size.
  const starTo = mark
    ? { x: mark.x + mark.w / 2 - innerWidth / 2, y: mark.y + mark.h / 2 - innerHeight / 2, scale: Math.max(0.12, (mark.w * 0.62) / STAR) }
    : { x: 0, y: 0, scale: 0.4 };

  return (
    <motion.div
      className="mt"
      data-target={target}
      data-phase={phase}
      aria-hidden
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.14, ease: ease.out } }}
    >
      <motion.div
        className="mt__veil"
        initial={{ opacity: 0 }}
        animate={{ opacity: covering ? 1 : 0 }}
        transition={covering ? { duration: out, ease: [0.5, 0, 0.75, 0.4] } : { duration: inn * 0.8, ease: ease.out, delay: 0.04 }}
      />
      {game && (
        <motion.div
          className="mt__art"
          initial={toImmersive ? { x: from.x, y: from.y, scale: from.scale, opacity: 0, borderRadius: 26 } : { opacity: 0, scale: 1 }}
          animate={
            covering
              ? { x: 0, y: 0, scale: 1.035, opacity: 1, borderRadius: 0 }
              : toImmersive
                ? { x: 0, y: 0, scale: 1, opacity: 0, borderRadius: 0 }
                : { x: 0, y: 0, scale: 0.88, opacity: 0, borderRadius: 30 }
          }
          transition={
            covering
              ? {
                  duration: out,
                  ease: [0.7, 0, 0.2, 1],
                  // Leaving Immersive the art is its backdrop already: fade in slowly so the rows are seen sinking away.
                  opacity: toImmersive ? { duration: out * 0.42, ease: 'linear' } : { duration: out * 0.9, ease: [0.5, 0, 0.8, 0.5] },
                  borderRadius: { duration: out * 0.9 },
                }
              : { duration: inn, ease: ease.cinematic, opacity: { duration: inn * 0.75, ease: ease.out, delay: toImmersive ? 0.08 : 0 } }
          }
        >
          <GameCover game={game} kind="hero" eager />
          <div className="mt__art-scrim" />
        </motion.div>
      )}
      <div className="mt__vignette" />
      {covering && <div className="mt__sweep" />}
      <motion.div
        className="mt__star"
        style={{ width: STAR, height: STAR, marginLeft: -STAR / 2, marginTop: -STAR / 2 }}
        initial={{ scale: 0, opacity: 0, rotate: -60 }}
        animate={
          covering
            ? { scale: [0, 1.32, 1], opacity: 1, rotate: 0, x: 0, y: 0 }
            : { scale: starTo.scale, opacity: [1, 1, 0], rotate: 45, x: starTo.x, y: starTo.y }
        }
        transition={
          covering
            ? { delay: out * 0.42, duration: out * 0.9, ease: ease.emph, scale: { delay: out * 0.42, duration: out * 0.9, times: [0, 0.6, 1] } }
            : { duration: inn * 0.86, ease: [0.5, 0, 0.1, 1], opacity: { duration: inn * 0.86, times: [0, 0.8, 1] } }
        }
      >
        <StarMark />
      </motion.div>
      {covering && <div className="mt__burst" />}
    </motion.div>
  );
}

function StarMark() {
  return (
    <svg viewBox="0 0 120 120" className="mt__star-svg">
      <defs>
        <radialGradient id="mtStarFill" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#E6E0FF" />
        </radialGradient>
        <radialGradient id="mtStarGlow" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#C9B8FF" stopOpacity="0.9" />
          <stop offset="0.45" stopColor="#8F6BFF" stopOpacity="0.35" />
          <stop offset="1" stopColor="#5A8CFF" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="60" cy="60" r="60" fill="url(#mtStarGlow)" />
      <path d="M60,18 C64,50 70,56 102,60 C70,64 64,70 60,102 C56,70 50,64 18,60 C50,56 56,50 60,18 Z" fill="url(#mtStarFill)" />
    </svg>
  );
}
