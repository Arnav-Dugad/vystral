/**
 * Track D5: "Free this week" — the giveaways list from freebies.get (Track D4's GamerPower client; the browser preview
 * fakes it). Loaded once while the opt-in is on, refreshed by freebies.changed and when the opt-in changes. A real app
 * without the native client yet simply shows nothing.
 */
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { call, errorMessage, on } from '../bridge/bridge';
import type { Freebies } from '../bridge/types';
import { cleanFreebies } from '../lib/freebies';
import { settingsSettled, useStore } from './store';

interface FreebiesState {
  data: Freebies | null;
  loading: boolean;
  error: string | null;
  load(refresh?: boolean): Promise<void>;
}

let started = false;
let seq = 0;

export const useFreebiesStore = create<FreebiesState>((set) => ({
  data: null,
  loading: false,
  error: null,
  async load(refresh = false) {
    const mine = ++seq;
    set({ loading: true, error: null });
    try {
      await settingsSettled();
      const raw = await call<Freebies>('freebies.get', { refresh }, 45_000);
      if (mine !== seq) return;
      // An app without the native client answers something that isn't a list: nothing to show, quietly.
      set({ data: cleanFreebies(raw), loading: false });
    } catch (err) {
      if (mine !== seq) return;
      const code = (err as { code?: string }).code;
      // 'unknown' = this build has no giveaways client yet: show nothing rather than an error.
      set({ loading: false, data: null, error: code === 'unknown' ? null : errorMessage(err) });
    }
  },
}));

function ensureStarted() {
  if (started) return;
  started = true;
  on('freebies.changed', (d) => useFreebiesStore.setState({ data: cleanFreebies(d), loading: false }));
  let last: unknown;
  on('settings.changed', (s) => {
    const key = `${s?.['freebies.enabled']}|${s?.['privacy.localOnly']}`;
    if (key === last) return;
    last = key;
    void useFreebiesStore.getState().load();
  });
}

/** The giveaways (loads on first use while the opt-in is on). */
export function useFreebies(): FreebiesState & { enabled: boolean } {
  const enabled = useStore((s) => !!s.settings?.['freebies.enabled']);
  const state = useFreebiesStore();
  useEffect(() => {
    ensureStarted();
    if (enabled && !state.data && !state.loading) void useFreebiesStore.getState().load();
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, enabled };
}

/** Opens a giveaway's official claim page in your browser (the native side holds and checks the URL). */
export function useClaim() {
  const toast = useStore((s) => s.toast);
  return useCallback(async (id: string, title: string) => {
    try {
      await call('freebies.open', { id });
      toast({ tone: 'info', title: `Opening ${title} in your browser`, body: 'Claim it on the store’s own page. VYSTRAL never signs in or claims anything for you.' });
    } catch (err) {
      toast({ tone: 'warning', title: 'Couldn’t open the giveaway', body: errorMessage(err) });
    }
  }, [toast]);
}
