/**
 * Track O state: the cloud map (which library games a cloud service lists), the status (catalogues, meter, active
 * session) and launching. Kept out of the main store so the feature stays self-contained; loaded on first use and
 * refreshed on library, settings and cloud events.
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { CloudLaunchResult, CloudMap, CloudService, CloudSession, CloudStatus } from '../bridge/types';
import { useStore } from './store';
import { filterCloudMap } from '../lib/subs';
import { useAllowedCloudServices } from './subs';

interface CloudState {
  map: CloudMap | null;
  status: CloudStatus | null;
  active: CloudSession | null;
  /** Bumped when anything cloud-related changes, so game panels reload. */
  version: number;
  loadMap(): Promise<void>;
  loadStatus(): Promise<void>;
}

let started = false;
let mapTimer: number | undefined;

export const useCloudStore = create<CloudState>((set, get) => ({
  map: null,
  status: null,
  active: null,
  version: 0,
  async loadMap() {
    try {
      const map = await call<CloudMap>('cloud.map');
      set({ map: map && typeof map === 'object' ? map : {} });
    } catch {
      set({ map: {} });
    }
  },
  async loadStatus() {
    try {
      const status = await call<CloudStatus>('cloud.status');
      set({ status, active: status.active });
    } catch {
      /* the Settings card shows its own error */
    }
    void get();
  },
}));

function ensureStarted() {
  if (started) return;
  started = true;
  const s = useCloudStore.getState();
  void s.loadMap();
  void s.loadStatus();
  const reloadMap = () => {
    window.clearTimeout(mapTimer);
    mapTimer = window.setTimeout(() => void useCloudStore.getState().loadMap(), 400);
  };
  on('library.changed', reloadMap);
  on('cloud.changed', (status) => {
    useCloudStore.setState((st) => ({ status, active: status.active, version: st.version + 1 }));
    reloadMap();
  });
  on('cloud.session', (payload) => {
    const active = payload && !('ended' in payload) ? payload : null;
    useCloudStore.setState((st) => ({ active, version: st.version + 1 }));
    if (payload && 'ended' in payload && payload.saved) {
      useStore.getState().toast({ tone: 'success', title: 'Cloud session saved', body: 'It’s in your Journal, with time estimated from what VYSTRAL saw.' });
    }
    void useCloudStore.getState().loadStatus();
  });
  let last: unknown;
  on('settings.changed', (st) => {
    const key = JSON.stringify([st?.['cloud.enabled'], st?.['cloud.gfn'], st?.['cloud.xbox'], st?.['cloud.market'], st?.['cloud.gfnPlan'], st?.['cloud.resetDay'], st?.['cloud.browser'], st?.['privacy.localOnly']]);
    if (key !== last) {
      last = key;
      reloadMap();
      void useCloudStore.getState().loadStatus();
      useCloudStore.setState((x) => ({ version: x.version + 1 }));
    }
  });
}

/** Cloud play is turned on (from settings, so it's right before the status loads). */
export function useCloudEnabled(): boolean {
  return useStore((s) => !!s.settings?.['cloud.enabled']);
}

/** Starts loading once cloud play is on (nothing is asked of the bridge while it's off). */
function useStart(force = false) {
  const enabled = useCloudEnabled();
  useEffect(() => {
    if (enabled || force) ensureStarted();
  }, [enabled, force]);
  return enabled;
}

/** The whole map (loads it on first use). Null while loading; empty while cloud play is off. */
export function useCloudMap(): CloudMap | null {
  const enabled = useStart();
  const map = useCloudStore((s) => s.map);
  // Track V: once you've said which services you have, the others are left out (unless "show every service" is on).
  const allowed = useAllowedCloudServices();
  const shown = useMemo(() => filterCloudMap(map, allowed), [map, allowed]);
  return enabled ? shown : EMPTY;
}

const EMPTY: CloudMap = {};

/** The status (Settings always loads it, even while off, for the empty state's details). */
export function useCloudStatus(): CloudStatus | null {
  useStart(true);
  return useCloudStore((s) => s.status);
}

export function useCloudActive(): CloudSession | null {
  const enabled = useStart();
  const active = useCloudStore((s) => s.active);
  return enabled ? active : null;
}

export async function launchCloud(gameId: string, service: CloudService): Promise<CloudLaunchResult | null> {
  try {
    const r = await call<CloudLaunchResult>('cloud.launch', { gameId, service });
    useStore.getState().toast({ tone: 'info', title: r.message });
    void useCloudStore.getState().loadStatus();
    return r;
  } catch (err) {
    useStore.getState().toast({ tone: 'danger', title: 'Couldn’t open the cloud game', body: errorMessage(err) });
    return null;
  }
}

export async function endCloudSession(): Promise<void> {
  try {
    await call('cloud.endSession');
  } catch (err) {
    useStore.getState().toast({ tone: 'danger', title: 'Couldn’t end the session', body: errorMessage(err) });
  }
  void useCloudStore.getState().loadStatus();
}
