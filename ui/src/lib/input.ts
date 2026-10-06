import { on } from '../bridge/bridge';
import type { GamepadButton } from '../bridge/types';
import { moveFocus, type Dir } from './spatial';
import { useStore } from '../state/store';
import { haptic } from './haptics';

/**
 * Translates controller input (forwarded natively via Windows.Gaming.Input) into navigation.
 * Directions auto-repeat: 380ms initial delay, then 110ms accelerating to 55ms.
 * Views can claim input (e.g. Immersive Mode, the Constellation) by registering a handler.
 */

export type PadHandler = (button: GamepadButton, repeat: boolean) => boolean;

const handlers: PadHandler[] = [];
const held = new Map<GamepadButton, number>();
const DIRS: Partial<Record<GamepadButton, Dir>> = { Up: 'up', Down: 'down', Left: 'left', Right: 'right' };

export function pushPadHandler(h: PadHandler): () => void {
  handlers.push(h);
  return () => {
    const i = handlers.lastIndexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

let started = false;

export function startInput() {
  if (started) return;
  started = true;
  on('gamepad.button', ({ button, pressed }) => {
    const settings = useStore.getState().settings;
    if (settings && !settings['controller.enabled']) return;
    document.documentElement.dataset.input = 'pad';
    if (!pressed) {
      window.clearTimeout(held.get(button));
      held.delete(button);
      return;
    }
    dispatch(button, false);
    if (DIRS[button] || button === 'LT' || button === 'RT') {
      let delay = 380;
      const repeat = () => {
        dispatch(button, true);
        delay = Math.max(55, delay === 380 ? 110 : delay * 0.88);
        held.set(button, window.setTimeout(repeat, delay));
      };
      held.set(button, window.setTimeout(repeat, delay));
    }
  });
  on('gamepad.scroll', ({ value }) => {
    const scroller = document.querySelector<HTMLElement>('[data-scroll-main]');
    scroller?.scrollBy({ top: value * 38, behavior: 'auto' });
  });
  on('gamepad.connection', ({ count }) => {
    // A controller came or went: stop any auto-repeat a vanished pad left running.
    for (const t of held.values()) window.clearTimeout(t);
    held.clear();
    useStore.getState().toast({ tone: 'info', title: count > 0 ? 'Controller connected' : 'Controller disconnected' });
  });
  // Zero-movement mousemoves (content moving under a still cursor) aren't the user picking up the mouse.
  window.addEventListener('mousemove', (e) => {
    if (e.movementX === 0 && e.movementY === 0) return;
    document.documentElement.dataset.input = 'mouse';
  }, { passive: true });
  window.addEventListener('keydown', () => (document.documentElement.dataset.input = 'keyboard'), { passive: true });
}

function dispatch(button: GamepadButton, repeat: boolean) {
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i](button, repeat)) return;
  defaultHandler(button, repeat);
}

function defaultHandler(button: GamepadButton, repeat: boolean) {
  const s = useStore.getState();
  const dir = DIRS[button];
  if (dir) {
    moveFocus(dir);
    return;
  }
  if (repeat) return;
  const active = document.activeElement as HTMLElement | null;
  switch (button) {
    case 'A':
      if (active && active !== document.body) {
        active.click();
        haptic('tick');
      } else moveFocus('down');
      break;
    case 'B':
      if (document.querySelector('[data-dialog-open], [data-menu-open]')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      } else if (s.commandOpen) s.setCommandOpen(false);
      else s.goBack();
      break;
    case 'Y':
      s.setCommandOpen(!s.commandOpen);
      break;
    case 'X':
    case 'View':
      active?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true }));
      break;
    case 'Menu':
      void s.setMode(s.window.mode === 'immersive' ? 'desktop' : 'immersive');
      break;
    case 'LB':
      s.goBack();
      break;
    case 'RB':
      s.goForward();
      break;
    case 'LT':
    case 'RT':
      document.querySelector<HTMLElement>('[data-scroll-main]')?.scrollBy({ top: (button === 'LT' ? -1 : 1) * innerHeight * 0.8, behavior: 'smooth' });
      break;
  }
}
