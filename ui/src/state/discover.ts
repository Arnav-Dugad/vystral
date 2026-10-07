/**
 * Track U: React hooks for universal search. A search is started with discover.search and its sources stream in as
 * discover.results events; each channel ('bar', 'page') keeps only its newest search. Images are asked for lazily,
 * once per key and kind, and shared by every component that shows them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorMessage, on } from '../bridge/bridge';
import type { DiscoverChannel, DiscoverImage, DiscoverSearch, DiscoverStatus, DiscoverWatch } from '../bridge/types';
import { cleanQuery, isNewer } from '../lib/discover';
import { settingsSettled, useStore } from './store';

export interface DiscoverSearchState {
  /** The cleaned text being searched (null: nothing to search). */
  query: string | null;
  search: DiscoverSearch | null;
  /** Waiting for the typing to settle, or a source is still answering. */
  busy: boolean;
  error: string | null;
  loadingMore: boolean;
  loadMore: () => void;
}

export function useDiscoverSearch(text: string, channel: DiscoverChannel, { enabled, debounceMs = 260 }: { enabled: boolean; debounceMs?: number }): DiscoverSearchState {
  const cleaned = enabled ? cleanQuery(text) : null;
  const [query, setQuery] = useState<string | null>(cleaned);
  const [search, setSearch] = useState<DiscoverSearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const queryRef = useRef(query);
  queryRef.current = query;

  // Debounce what was typed.
  useEffect(() => {
    if (cleaned === query) return;
    const t = window.setTimeout(() => setQuery(cleaned), cleaned ? debounceMs : 0);
    return () => window.clearTimeout(t);
  }, [cleaned, query, debounceMs]);

  const accept = useCallback((next: DiscoverSearch) => {
    if (next.channel !== channel || next.query !== queryRef.current) return;
    setSearch((prev) => (prev && prev.query === next.query && !isNewer(prev, next) ? prev : next));
  }, [channel]);

  useEffect(() => on('discover.results', accept), [accept]);

  // Turning a source or Offline mode on or off searches again.
  const gates = useStore((s) => `${s.settings?.['discover.searchOnline']}|${s.settings?.['privacy.localOnly']}|${s.settings?.['library.fetchMetadata']}|${s.settings?.['dataSources.wikidata']}`);

  useEffect(() => {
    setError(null);
    setLoadingMore(false);
    if (!query) {
      setSearch(null);
      return;
    }
    let live = true;
    setSearch((prev) => (prev?.query === query ? prev : null));
    // Wait for a setting the user just changed (Turn on, Offline mode) to be saved before asking.
    settingsSettled()
      .then(() => (live ? call<DiscoverSearch>('discover.search', { query, channel, page: 0 }) : null))
      .then((r) => { if (live && r) accept(r); })
      .catch((err) => { if (live) setError(errorMessage(err)); });
    return () => { live = false; };
  }, [query, channel, accept, gates]);

  // The command bar's search stops when the bar closes.
  useEffect(() => () => { if (channel === 'bar') void call('discover.cancel', { channel }).catch(() => {}); }, [channel]);

  const loadMore = useCallback(() => {
    if (!search || !search.done || !search.hasMore || loadingMore || !query) return;
    setLoadingMore(true);
    call<DiscoverSearch>('discover.search', { query, channel, page: search.page + 1 })
      .then((r) => accept(r))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoadingMore(false));
  }, [search, loadingMore, query, channel, accept]);

  const busy = cleaned !== query || (!!query && (!search || !search.done) && !error);
  return { query, search: search?.query === query ? search : null, busy, error, loadingMore, loadMore };
}

export function useDiscoverStatus(): DiscoverStatus | null {
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  useEffect(() => {
    let live = true;
    // Only the newest answer counts: an older request resolving late must not bring back a stale state.
    let seq = 0;
    const ask = () => {
      const mine = ++seq;
      call<DiscoverStatus>('discover.status').then((s) => { if (live && mine === seq) setStatus(s); }).catch(() => {});
    };
    ask();
    const off = on('discover.changed', (s) => { seq++; setStatus(s); });
    // Preview has no native "changed" event for settings: ask again when settings change.
    const offSettings = on('settings.changed', ask);
    return () => { live = false; off(); offSettings(); };
  }, []);
  return status;
}

export function useWatching(): DiscoverWatch[] | null {
  const [list, setList] = useState<DiscoverWatch[] | null>(null);
  useEffect(() => {
    let live = true;
    call<DiscoverWatch[]>('discover.watching').then((l) => live && setList(l)).catch(() => live && setList([]));
    const off = on('discover.watching', setList);
    return () => { live = false; off(); };
  }, []);
  return list;
}

// ---------------- images ----------------

const images = new Map<string, Promise<DiscoverImage>>();
const resolved = new Map<string, DiscoverImage>();

/** Test hook. */
export function forgetDiscoverImages() {
  images.clear();
  resolved.clear();
}

function fetchImage(key: string, kind: string): Promise<DiscoverImage> {
  const k = `${key}|${kind}`;
  let p = images.get(k);
  if (!p) {
    p = call<DiscoverImage>('discover.image', { key, kind }, 45_000)
      .catch((): DiscoverImage => ({ url: null, reason: 'none' }))
      .then((img) => {
        resolved.set(k, img);
        // Data saver and Offline mode may change: let a later visit ask again.
        if (img.reason === 'dataSaver' || img.reason === 'offline') images.delete(k);
        return img;
      });
    images.set(k, p);
  }
  return p;
}

/**
 * The art URL for a result's image, asked for only once the element is (nearly) on screen.
 * Returns undefined while unknown, null when there is none.
 */
export function useDiscoverImage(key: string | null, kind: 'cover' | 'hero' | 'logo' | 'header', { known, enabled = true }: { known?: string | null; enabled?: boolean } = {}) {
  const [img, setImg] = useState<string | null | undefined>(() => known ?? (key ? resolved.get(`${key}|${kind}`)?.url : undefined));
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const setRef = useCallback((el: HTMLElement | null) => { ref.current = el; }, []);

  useEffect(() => {
    if (!key || known !== undefined && known !== null) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [key, known]);

  useEffect(() => {
    if (known) { setImg(known); return; }
    if (!key || !enabled || !visible) return;
    const cached = resolved.get(`${key}|${kind}`);
    if (cached) { setImg(cached.url); return; }
    let live = true;
    void fetchImage(key, kind).then((r) => live && setImg(r.url));
    return () => { live = false; };
  }, [key, kind, known, visible, enabled]);

  return { url: img, ref: setRef };
}
