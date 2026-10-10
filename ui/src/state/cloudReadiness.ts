/**
 * Track D5: the cloud readiness check (cloud.readiness). Measured only when you press "Check my connection"; the last
 * result is kept by the app for a day so the game page's advice can use it.
 */
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { call, errorMessage } from '../bridge/bridge';
import type { CloudReadiness } from '../bridge/types';
import { readinessFresh } from '../lib/cloudPlus';

interface ReadinessState {
  data: CloudReadiness | null;
  running: boolean;
  error: string | null;
  loaded: boolean;
}

export const useReadinessStore = create<ReadinessState>(() => ({ data: null, running: false, error: null, loaded: false }));

let asked = false;

function valid(r: unknown): r is CloudReadiness {
  const x = r as CloudReadiness;
  return !!x && typeof x === 'object' && typeof x.checkedAt === 'string' && Array.isArray(x.probes) && typeof x.level === 'string';
}

/** The last readiness result (fresh: under a day old) and a way to run the check. */
export function useCloudReadiness() {
  const state = useReadinessStore();
  useEffect(() => {
    if (asked) return;
    asked = true;
    call<CloudReadiness | null>('cloud.readiness', { run: false })
      .then((r) => useReadinessStore.setState({ data: valid(r) ? r : null, loaded: true }))
      .catch(() => useReadinessStore.setState({ loaded: true }));
  }, []);
  const run = useCallback(async () => {
    if (useReadinessStore.getState().running) return;
    useReadinessStore.setState({ running: true, error: null });
    try {
      const r = await call<CloudReadiness>('cloud.readiness', { run: true }, 60_000);
      useReadinessStore.setState({ data: valid(r) ? r : null, running: false });
    } catch (err) {
      useReadinessStore.setState({ running: false, error: errorMessage(err) });
    }
  }, []);
  const fresh = readinessFresh(state.data, Date.now()) ? state.data : null;
  return { ...state, fresh, run };
}
