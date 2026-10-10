/**
 * Track C4: Steam community tags for the whole library (Library filters, command bar). Loaded on first use; asking
 * also starts a background fill of missing tags (the backend decides whether it may), and `tags.changed` reloads.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { LibraryTags } from '../bridge/types';

interface LibraryTagsState {
  data: LibraryTags | null;
  load(): Promise<void>;
}

let subscribed = false;
let timer: number | undefined;

export const useLibraryTagsStore = create<LibraryTagsState>((set, get) => ({
  data: null,
  async load() {
    try {
      const data = await call<LibraryTags>('tags.library');
      set({ data: data && Array.isArray(data.tags) && data.games ? data : null });
    } catch {
      set({ data: null });
    }
    if (!subscribed) {
      subscribed = true;
      const reload = () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void get().load(), 300);
      };
      on('tags.changed', reload);
      on('library.changed', (e) => { if (!e || e.reason === 'scan') reload(); });
    }
  },
}));

let requested = false;

export function useLibraryTags(): LibraryTags | null {
  useEffect(() => {
    if (requested) return;
    requested = true;
    void useLibraryTagsStore.getState().load();
  }, []);
  return useLibraryTagsStore((s) => s.data);
}
