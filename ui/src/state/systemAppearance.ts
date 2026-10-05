import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { SystemAppearance } from '../bridge/types';

/**
 * Track G: Windows accent colour and window backdrop state, pushed by the shell as `system.accent`.
 * Kept out of the main store so it can evolve without touching shared state.
 */
interface SystemAppearanceState {
  appearance: SystemAppearance | null;
}

export const useSystemAppearance = create<SystemAppearanceState>(() => ({ appearance: null }));

const isAppearance = (a: unknown): a is SystemAppearance =>
  !!a && typeof a === 'object' && typeof (a as SystemAppearance).accent === 'string' && Array.isArray((a as SystemAppearance).accentLight);

function accept(a: unknown): SystemAppearance | null {
  if (!isAppearance(a)) return null;
  useSystemAppearance.setState({ appearance: a });
  return a;
}

let started = false;

/** Subscribes to `system.accent` and loads the current state. Safe to call more than once. */
export function startSystemAppearance() {
  if (started) return;
  started = true;
  on('system.accent', accept);
  call<SystemAppearance>('system.accent').then(accept, () => {});
}

/** Asks the shell for (or to drop) the Mica backdrop. Resolves to what the window now draws. */
export async function requestBackdrop(value: boolean): Promise<SystemAppearance | null> {
  try {
    return accept(await call<SystemAppearance>('window.backdrop', { value }));
  } catch {
    return null;
  }
}
