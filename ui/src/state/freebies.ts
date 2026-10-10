/**
 * Track D5: "Free this week" — the giveaways from Track D4's freebies.get (GamerPower and Epic's free-games feed, each
 * opt-in under Data sources). Loaded once while a source is on, again when those settings change; images are asked
 * for lazily (freebies.image) once a card is near the screen. Claiming opens the store's own page (freebies.open).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
      set({ data: cleanFreebies(raw), loading: false });
    } catch (err) {
      if (mine !== seq) return;
      // 'unknown' = a build without the giveaways client: show nothing rather than an error.
      const code = (err as { code?: string }).code;
      set({ loading: false, data: null, error: code === 'unknown' ? null : errorMessage(err) });
    }
  },
}));

function ensureStarted() {
  if (started) return;
  started = true;
  let last: unknown;
  on('settings.changed', (s) => {
    const key = `${s?.['dataSources.gamerpower']}|${s?.['dataSources.epicFreeGames']}|${s?.['privacy.localOnly']}`;
    if (key === last) return;
    last = key;
    void useFreebiesStore.getState().load();
  });
}

/** The giveaways (loads on first use while a source is on). `enabled` = GamerPower or Epic's feed is on. */
export function useFreebies(): FreebiesState & { enabled: boolean } {
  const enabled = useStore((s) => !!(s.settings?.['dataSources.gamerpower'] || s.settings?.['dataSources.epicFreeGames']));
  const state = useFreebiesStore();
  useEffect(() => {
    ensureStarted();
    if (enabled && !useFreebiesStore.getState().data && !useFreebiesStore.getState().loading) void useFreebiesStore.getState().load();
  }, [enabled]);
  return { ...state, enabled };
}

/** Opens a giveaway's own store page in your browser (the native side holds the URL; the page never sends one). */
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

const images = new Map<string, Promise<string | null>>();

/** A giveaway's cached image, asked for once the card is near the screen. Undefined while unknown. */
export function useFreebieImage(id: string, known: string | null, hasImage: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(known ?? (hasImage ? undefined : null));
  useEffect(() => {
    if (known || !hasImage) return;
    const el = ref.current;
    let alive = true;
    const ask = () => {
      let p = images.get(id);
      if (!p) {
        p = call<string | null>('freebies.image', { id }, 30_000)
          .then((u) => (typeof u === 'string' && u.startsWith('https://art.vystral.example/') ? u : null))
          .catch(() => null);
        images.set(id, p);
      }
      void p.then((u) => { if (alive) setUrl(u); });
    };
    if (!el || typeof IntersectionObserver === 'undefined') { ask(); return () => { alive = false; }; }
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { io.disconnect(); ask(); } }, { rootMargin: '400px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [id, known, hasImage]);
  return { ref, url: known ?? url };
}
