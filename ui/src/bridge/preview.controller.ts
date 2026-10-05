/**
 * Preview backend, controller track: vibration is a no-op that records what the UI asked for,
 * and tests can inject controller events (there is no Windows.Gaming.Input in a browser).
 * Only used outside the VYSTRAL app.
 */
import { BridgeError } from './bridge';

type Emit = (name: string, payload: unknown) => void;

const PATTERNS = new Set(['tick', 'edge', 'confirm', 'hold', 'error', 'stop']);

export interface PreviewControllerHooks {
  /** Every vibration pattern requested, in order. */
  rumbles: string[];
  /** Simulates a native controller event (gamepad.button / gamepad.scroll / gamepad.connection only). */
  emit(name: string, payload: unknown): void;
}

declare global {
  interface Window {
    __vystralPreviewController?: PreviewControllerHooks;
  }
}

export function controllerPreviewHandlers(ctx: { emit: () => Emit }) {
  const hooks: PreviewControllerHooks = {
    rumbles: [],
    emit(name, payload) {
      if (!name.startsWith('gamepad.')) throw new Error('Only gamepad.* events can be simulated.');
      ctx.emit()(name, payload);
    },
  };
  if (typeof window !== 'undefined') window.__vystralPreviewController = hooks;
  return {
    'gamepad.rumble': (p: { pattern?: unknown }) => {
      if (typeof p?.pattern !== 'string' || !PATTERNS.has(p.pattern)) throw new BridgeError('invalid', 'Unknown vibration pattern.');
      hooks.rumbles.push(p.pattern);
      return false; // no controller in preview, so nothing actually played
    },
  };
}
