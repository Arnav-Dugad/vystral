import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { DiskForecast } from '../bridge/types';

/**
 * Track P: the update-space forecast, shared by the Home warning, the game-page chip and Storage
 * Studio. Loaded on first use and kept current by the native `disk.forecast` event (the native side
 * watches Steam's manifests); a surface that opens re-asks when the copy is over a minute old.
 */
interface DiskForecastState {
  forecast: DiskForecast | null;
  loadedAt: number;
  /** Home warnings the person dismissed this run (by warning key). */
  dismissed: string[];
  dismiss(key: string): void;
}

export const useDiskForecast = create<DiskForecastState>((set, get) => ({
  forecast: null,
  loadedAt: 0,
  dismissed: [],
  dismiss(key) {
    set({ dismissed: [...get().dismissed, key] });
  },
}));

let subscribed = false;
let inflight: Promise<void> | null = null;

/** Starts listening (once) and refreshes when the copy is older than `maxAgeMs`. */
export function ensureDiskForecast(maxAgeMs = 60_000): Promise<void> {
  if (!subscribed) {
    subscribed = true;
    on('disk.forecast', (f) => {
      if (f && Array.isArray(f.drives)) useDiskForecast.setState({ forecast: f, loadedAt: Date.now() });
    });
  }
  const { loadedAt } = useDiskForecast.getState();
  if (Date.now() - loadedAt < maxAgeMs) return Promise.resolve();
  inflight ??= call<DiskForecast>('disk.forecast')
    .then((f) => {
      if (f && Array.isArray(f.drives)) useDiskForecast.setState({ forecast: f, loadedAt: Date.now() });
    })
    .catch(() => undefined) // the forecast is a nicety; surfaces simply don't show it
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
