/**
 * Track C5: the AI status (which engine answers, providers, features) shared by every AI surface. Loaded on first
 * use, refreshed when AI-related settings change or a provider connects/disconnects. Keys never reach the page.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { AiCloudStatus, AiFeatureId, Settings } from '../bridge/types';
import { settingsSettled, useStore } from './store';

interface AiState {
  status: AiCloudStatus | null;
  error: string | null;
  refresh: () => Promise<void>;
}

let started = false;
let seq = 0;

export const useAiStore = create<AiState>((set) => ({
  status: null,
  error: null,
  refresh: async () => {
    const mine = ++seq;
    try {
      const status = await call<AiCloudStatus>('aiCloud.status');
      if (mine === seq) set({ status, error: null });
    } catch (err) {
      if (mine === seq) set({ error: err instanceof Error ? err.message : 'Couldn’t read the AI status.' });
    }
  },
}));

const AI_KEYS = (s: Settings | null) =>
  s ? Object.entries(s).filter(([k]) => k.startsWith('ai.') || k === 'privacy.localOnly').map(([k, v]) => `${k}=${String(v)}`).join('|') : '';

function start() {
  if (started) return;
  started = true;
  on('aiCloud.changed', (status) => useAiStore.setState({ status, error: null }));
  let last = AI_KEYS(useStore.getState().settings);
  useStore.subscribe((st) => {
    const next = AI_KEYS(st.settings);
    if (next !== last) {
      last = next;
      // Settings are shown optimistically: ask once the change has been saved, so the answer reflects it.
      // (One microtask later, so the save that caused this change is already counted as in flight.)
      void Promise.resolve().then(settingsSettled).then(() => useAiStore.getState().refresh());
    }
  });
  void useAiStore.getState().refresh();
}

export function useAiStatus(): AiCloudStatus | null {
  useEffect(start, []);
  return useAiStore((s) => s.status);
}

/** Whether a feature's switch is on (true until the status has loaded, so nothing flickers off). */
export function useAiFeatureOn(id: AiFeatureId): boolean {
  return useStore((s) => (s.settings ? (s.settings[`ai.features.${id}` as keyof Settings] as boolean | undefined) ?? true : true));
}
