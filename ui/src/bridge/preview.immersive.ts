/**
 * Track L preview handlers: couch-mode settings and a fictional system bar (a laptop on Wi-Fi with
 * one wireless controller). `?nobattery` simulates a desktop PC; `?offline` a PC with no network.
 * Tests can change the reading through `window.__vystralPreviewSystem`.
 */
import type { Game, LaunchState, Settings, SystemStatus } from './types';

export const TRACK_L_DEFAULT_SETTINGS: Pick<Settings, 'immersive.cinematicSwitch' | 'immersive.scale' | 'immersive.safeArea' | 'immersive.tourDone'> = {
  'immersive.cinematicSwitch': true,
  'immersive.scale': 1,
  'immersive.safeArea': 0,
  'immersive.tourDone': false,
};

/** Track T: voice-over and captions (off), controller glyphs, the grid's sort. */
export const TRACK_T_DEFAULT_SETTINGS: Pick<Settings, 'voiceover.enabled' | 'voiceover.captionsOnly' | 'voiceover.voice' | 'voiceover.rate' | 'voiceover.volume' | 'controller.glyphs' | 'immersive.librarySort'> = {
  'voiceover.enabled': false,
  'voiceover.captionsOnly': false,
  'voiceover.voice': '',
  'voiceover.rate': 1,
  'voiceover.volume': 1,
  'controller.glyphs': 'auto',
  'immersive.librarySort': 'az',
};

declare global {
  interface Window {
    __vystralPreviewSystem?: { set(patch: Partial<SystemStatus>): void; calls: number };
    /** Track T: set when Immersive's guide asked to close VYSTRAL (preview only). */
    __vystralPreviewClosed?: boolean;
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
    // Track T: the guide's "Close VYSTRAL". The preview just records it.
    'window.close': () => {
      if (typeof window !== 'undefined') window.__vystralPreviewClosed = true;
      return true;
    },
    'system.status': (): SystemStatus => {
      hooks.calls++;
      return status;
    },
  };
}

/**
 * Track T: `?nowPlaying` starts the preview with the first installed game running for 42 minutes
 * (fictional), so Immersive's Now playing row and the guide's Return to game can be seen.
 */
export function previewNowPlaying(games: readonly Game[]): LaunchState | null {
  if (typeof location === 'undefined' || !new URLSearchParams(location.search).has('nowPlaying')) return null;
  const g = games.find((x) => !x.hidden && x.installations.some((i) => i.state === 'installed'));
  const inst = g?.installations.find((i) => i.state === 'installed');
  if (!g || !inst) return null;
  return {
    ticket: 'preview-now-playing', gameId: g.id, installationId: inst.id, platform: inst.platform, phase: 'running', message: null,
    sessionId: 'preview', durationSeconds: null, perfSummary: null, startedAt: new Date(Date.now() - 42 * 60_000).toISOString(),
  };
}
