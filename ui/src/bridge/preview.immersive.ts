/**
 * Track L preview handlers: couch-mode settings and a fictional system bar (a laptop on Wi-Fi with
 * one wireless controller). `?nobattery` simulates a desktop PC; `?offline` a PC with no network.
 * Tests can change the reading through `window.__vystralPreviewSystem`.
 */
import type { Settings, SystemStatus } from './types';

export const TRACK_L_DEFAULT_SETTINGS: Pick<Settings, 'immersive.cinematicSwitch' | 'immersive.scale' | 'immersive.safeArea' | 'immersive.tourDone'> = {
  'immersive.cinematicSwitch': true,
  'immersive.scale': 1,
  'immersive.safeArea': 0,
  'immersive.tourDone': false,
};

declare global {
  interface Window {
    __vystralPreviewSystem?: { set(patch: Partial<SystemStatus>): void; calls: number };
  }
}

export function immersivePreviewHandlers() {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  let status: SystemStatus = {
    battery: params.has('nobattery') ? null : { percent: 76, charging: false, saver: false },
    network: params.has('offline') ? { kind: 'none', bars: null, internet: false } : { kind: 'wifi', bars: 3, internet: true },
    controllers: [{ battery: 0.62, charging: false, wired: false }],
  };
  const hooks = {
    calls: 0,
    set(patch: Partial<SystemStatus>) {
      status = { ...status, ...patch };
    },
  };
  if (typeof window !== 'undefined') window.__vystralPreviewSystem = hooks;
  return {
    'system.status': (): SystemStatus => {
      hooks.calls++;
      return status;
    },
  };
}
