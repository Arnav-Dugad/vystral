import { call } from '../bridge/bridge';
import { useStore } from '../state/store';

/**
 * Controller haptics. The UI can only ask for a named pattern; strengths and durations live
 * natively (src/Vystral.Windows/Services/Haptics.cs), which also rate-limits and never vibrates
 * during a game. Here we add the cheap checks that keep the bridge quiet: the vibration
 * setting, controller input enabled, no game running, and — so a pad lying on the desk never
 * buzzes while someone uses the mouse — only when the last input actually came from a controller.
 */

export type HapticPattern = 'tick' | 'edge' | 'confirm' | 'hold' | 'error';

/** Mirrors the native minimum gaps so fast key-repeat doesn't flood the bridge. */
const MIN_GAP: Record<HapticPattern, number> = { tick: 45, edge: 140, confirm: 400, hold: 450, error: 500 };
const last: Partial<Record<HapticPattern, number>> = {};
let holding = false;

export function lastInputWasPad(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.input === 'pad';
}

function allowed(): boolean {
  const s = useStore.getState();
  const settings = s.settings;
  if (!settings?.['controller.vibration'] || !settings['controller.enabled']) return false;
  if (s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase)) return false;
  return lastInputWasPad();
}

export function haptic(pattern: HapticPattern): void {
  if (!allowed()) return;
  const now = performance.now();
  if (now - (last[pattern] ?? -Infinity) < MIN_GAP[pattern]) return;
  last[pattern] = now;
  holding = pattern === 'hold';
  void call('gamepad.rumble', { pattern }).catch(() => {});
}

/** Ends a running pattern early (e.g. a hold-to-confirm released before it completed). */
export function stopHaptics(): void {
  if (!holding) return;
  holding = false;
  void call('gamepad.rumble', { pattern: 'stop' }).catch(() => {});
}
