/**
 * Track V state: your subscriptions' status, which library games your plans include (the map), the Home row, the
 * value card, and the GeForce NOW queue signal. Self-contained like the cloud store: loaded on first use and refreshed
 * on library, settings and subscription events. Nothing is asked of the bridge for the map while the lists are off.
 */
import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { CloudQueueSignal, SubsMap, SubsPick, SubsPlanId, SubsStatus, SubsValue } from '../bridge/types';
import { allowedCloudServices, hasListPlan, parsePlans, serializePlans } from '../lib/subs';
import { useStore } from './store';

interface SubsState {
  status: SubsStatus | null;
  map: SubsMap | null;
  included: SubsPick[] | null;
  value: SubsValue | null;
  queue: CloudQueueSignal | null;
  version: number;
  loadStatus(): Promise<void>;
  loadData(): Promise<void>;
}

let started = false;
let dataTimer: number | undefined;

export const useSubsStore = create<SubsState>((set) => ({
  status: null,
  map: null,
  included: null,
  value: null,
  queue: null,
  version: 0,
  async loadStatus() {
    try {
      set({ status: await call<SubsStatus>('subs.status') });
    } catch {
      /* Settings shows its own error */
    }
  },
  async loadData() {
    const [map, included, value] = await Promise.all([
      call<SubsMap>('subs.map').catch(() => ({}) as SubsMap),
      call<SubsPick[]>('subs.included').catch(() => [] as SubsPick[]),
      call<SubsValue>('subs.value').catch(() => null),
    ]);
    set((st) => ({ map: map && typeof map === 'object' ? map : {}, included: Array.isArray(included) ? included : [], value, version: st.version + 1 }));
  },
}));

function reloadSoon() {
  window.clearTimeout(dataTimer);
  dataTimer = window.setTimeout(() => void useSubsStore.getState().loadData(), 300);
}

function ensureStarted() {
  if (started) return;
  started = true;
  const s = useSubsStore.getState();
  void s.loadStatus();
  void s.loadData();
  on('subs.changed', (status) => {
    useSubsStore.setState({ status });
    reloadSoon();
  });
  on('library.changed', reloadSoon);
  on('cloud.queue', (q) => useSubsStore.setState({ queue: q && q.phase !== 'none' ? q : null }));
  on('cloud.session', (payload) => {
    if (!payload || 'ended' in payload) useSubsStore.setState({ queue: null });
  });
  void call<CloudQueueSignal | null>('cloud.queueState').then((q) => useSubsStore.setState({ queue: q ?? null })).catch(() => {});
  let last: unknown;
  on('settings.changed', (st) => {
    const key = JSON.stringify([st?.['subs.owned'], st?.['subs.catalog'], st?.['subs.price'], st?.['subs.currency'], st?.['cloud.gfnPlan'], st?.['privacy.localOnly'], st?.['cloud.market']]);
    if (key === last) return;
    last = key;
    void useSubsStore.getState().loadStatus();
    reloadSoon();
  });
}

/** Starts loading on first use (status, map, Home row and value are cheap local reads on the native side). */
function useStart() {
  useEffect(() => ensureStarted(), []);
}

/** The plans you said you have (from settings, so it's right before the status loads). */
export function usePlans(): SubsPlanId[] {
  const csv = useStore((s) => s.settings?.['subs.owned'] ?? '');
  return useMemo(() => parsePlans(csv), [csv]);
}

/** The public lists are on and a plan has one: badges and filters can exist. */
export function useSubsListed(): boolean {
  const plans = usePlans();
  const catalog = useStore((s) => !!s.settings?.['subs.catalog']);
  return catalog && hasListPlan(plans);
}

export function useSubsStatus(): SubsStatus | null {
  useStart();
  return useSubsStore((s) => s.status);
}

const EMPTY: SubsMap = {};

/** gameId → plans that include it. Empty while the lists are off. */
export function useSubsMap(): SubsMap | null {
  const listed = useSubsListed();
  useStart();
  const map = useSubsStore((s) => s.map);
  return listed ? map : EMPTY;
}

export function useSubsIncluded(): SubsPick[] | null {
  const listed = useSubsListed();
  useStart();
  const included = useSubsStore((s) => s.included);
  return listed ? included : [];
}

export function useSubsValue(): SubsValue | null {
  useStart();
  return useSubsStore((s) => s.value);
}

export function useCloudQueue(): CloudQueueSignal | null {
  useStart();
  return useSubsStore((s) => s.queue);
}

/** Which cloud services to show (null = all): only yours, once you've said, unless "show every service" is on. */
export function useAllowedCloudServices() {
  const asked = useStore((s) => !!s.settings?.['subs.asked']);
  const showAll = useStore((s) => !!s.settings?.['subs.cloudShowAll']);
  const owned = useStore((s) => s.settings?.['subs.owned'] ?? '');
  const gfn = useStore((s) => s.settings?.['cloud.gfnPlan'] ?? 'none');
  return useMemo(() => allowedCloudServices({ 'subs.asked': asked, 'subs.cloudShowAll': showAll, 'subs.owned': owned, 'cloud.gfnPlan': gfn }), [asked, showAll, owned, gfn]);
}

/** Saves the answer: plans (one per family), optionally the GeForce NOW membership, and that you were asked. */
export async function saveSubscriptions(plans: SubsPlanId[], gfnPlan?: import('../bridge/types').GfnPlanId): Promise<boolean> {
  const st = useStore.getState();
  try {
    await st.setSetting('subs.owned', serializePlans(plans));
    if (gfnPlan) await st.setSetting('cloud.gfnPlan', gfnPlan);
    await st.setSetting('subs.asked', true);
    return true;
  } catch (err) {
    st.toast({ tone: 'danger', title: 'Couldn’t save your subscriptions', body: errorMessage(err) });
    return false;
  }
}

export async function openIncluded(productId: string): Promise<void> {
  try {
    await call('subs.openStore', { productId });
  } catch (err) {
    useStore.getState().toast({ tone: 'danger', title: 'Couldn’t open the store page', body: errorMessage(err) });
  }
}
