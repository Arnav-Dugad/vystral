/**
 * Track M state: the cached IGDB time-to-beat map (loaded once, refreshed when enrichment or the
 * relevant settings change) and which session replay card is open. Kept out of the main store so
 * the feature stays self-contained.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { TimeToBeat, TimeToBeatMap } from '../bridge/types';

interface RecapState {
  ttb: TimeToBeatMap | null;
  replaySessionId: string | null;
  loadTtb(): Promise<void>;
  openReplay(sessionId: string): void;
  closeReplay(): void;
}

let ttbRequested = false;
let subscribed = false;
let reloadTimer: number | undefined;

export const useRecapStore = create<RecapState>((set, get) => ({
  ttb: null,
  replaySessionId: null,
  async loadTtb() {
    try {
      const map = await call<TimeToBeatMap>('ttb.map');
      set({ ttb: map && typeof map === 'object' && map.games ? map : { games: {}, reason: 'noData' } });
    } catch {
      set({ ttb: { games: {}, reason: 'noData' } });
    }
    if (!subscribed) {
      subscribed = true;
      const reload = () => {
        window.clearTimeout(reloadTimer);
        reloadTimer = window.setTimeout(() => void get().loadTtb(), 400);
      };
      on('library.changed', (e) => {
        if (!e || e.reason === 'enrichment' || e.reason === 'session') reload();
      });
      on('dataSources.changed', reload);
      let last: unknown;
      on('settings.changed', (s) => {
        if (s?.['library.timeToBeat'] !== last) {
          last = s?.['library.timeToBeat'];
          reload();
        }
      });
    }
  },
  openReplay(sessionId) {
    if (/^[0-9a-f]{32}$/.test(sessionId) || sessionId === 'preview') set({ replaySessionId: sessionId });
  },
  closeReplay() {
    set({ replaySessionId: null });
  },
}));

function ensureTtb() {
  if (ttbRequested) return;
  ttbRequested = true;
  void useRecapStore.getState().loadTtb();
}

/** The IGDB estimate for one game, or undefined (also while loading). Triggers the one-time load. */
export function useTimeToBeat(gameId: string): TimeToBeat | undefined {
  useEffect(ensureTtb, []);
  return useRecapStore((s) => s.ttb?.games[gameId]);
}

/** The whole map (for sorting), loading it on first use. */
export function useTimeToBeatMap(): TimeToBeatMap | null {
  useEffect(ensureTtb, []);
  return useRecapStore((s) => s.ttb);
}

export const openReplay = (sessionId: string) => useRecapStore.getState().openReplay(sessionId);
