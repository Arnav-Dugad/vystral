/**
 * Track C6: the data behind Immersive Discover — the search you ran (on the existing 'page' channel: the desktop
 * Discover page is never on screen at the same time), your Watching list, and the Steam wishlist when it's on and
 * already loaded. Nothing is asked for until the Discover section is first opened.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { DiscoverStatus, DiscoverWatch, Game, Wishlist, WishlistItem } from '../../bridge/types';
import { voiceOver } from '../../lib/voiceover';
import { useDiscoverSearch } from '../../state/discover';
import { useStore } from '../../state/store';
import { discoverRows } from './discoverRows';
import type { Row } from './rows';

export interface ImmDiscover {
  rows: Row[];
  query: string | null;
  setQuery: (q: string | null) => void;
  loadMore: () => void;
  retry: () => void;
  watchingKeys: ReadonlySet<string>;
  /** Turns watching a game on or off; resolves to the new state, or null when it couldn't be saved. */
  setWatching: (key: string, title: string, on: boolean) => Promise<boolean | null>;
  status: DiscoverStatus | null;
}

/** The last search, kept while VYSTRAL runs so coming back to Immersive shows it again. */
let lastQuery: string | null = null;

export function useImmDiscover(visible: readonly Game[], opened: boolean): ImmDiscover {
  const [query, setQueryState] = useState<string | null>(() => lastQuery);
  useEffect(() => { lastQuery = query; }, [query]);
  const online = useDiscoverSearch(query ?? '', 'page', { enabled: !!query, debounceMs: 0 });

  // Status, Watching and the wishlist: only once the section has been opened.
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [watching, setWatchingList] = useState<DiscoverWatch[] | null>(null);
  const [wishlist, setWishlist] = useState<WishlistItem[] | null>(null);
  const wishOn = useStore((s) => !!s.settings?.['wishlist.sync']);

  useEffect(() => {
    if (!opened) return;
    let live = true;
    let seq = 0;
    const ask = () => {
      const mine = ++seq;
      call<DiscoverStatus>('discover.status').then((s) => { if (live && mine === seq) setStatus(s); }).catch(() => {});
    };
    ask();
    call<DiscoverWatch[]>('discover.watching').then((l) => live && setWatchingList(Array.isArray(l) ? l : [])).catch(() => live && setWatchingList([]));
    const offs = [
      on('discover.changed', (s) => { seq++; if (live) setStatus(s); }),
      on('settings.changed', ask),
      on('discover.watching', (l) => live && setWatchingList(Array.isArray(l) ? l : [])),
    ];
    return () => { live = false; offs.forEach((off) => off()); };
  }, [opened]);

  useEffect(() => {
    if (!opened || !wishOn) {
      setWishlist(null);
      return;
    }
    let live = true;
    // Only what's already loaded: Immersive never starts a wishlist refresh on its own.
    const load = () => call<Wishlist>('wishlist.get').then((w) => live && setWishlist(w?.status === 'ok' && Array.isArray(w.items) ? w.items : null)).catch(() => {});
    void load();
    const off = on('wishlist.changed', () => void load());
    return () => { live = false; off(); };
  }, [opened, wishOn]);

  const reason = status?.reason === 'offline' || status?.reason === 'off' ? status.reason : (online.search?.reason === 'offline' || online.search?.reason === 'off' ? online.search.reason : null);

  const rows = useMemo(
    () => discoverRows({
      query, search: online.search, busy: online.busy, error: online.error, loadingMore: online.loadingMore, reason,
      preview: !!status?.preview, watching, wishlist, library: visible,
    }),
    [query, online.search, online.busy, online.error, online.loadingMore, reason, status?.preview, watching, wishlist, visible],
  );

  const watchingKeys = useMemo(() => new Set((watching ?? []).map((w) => w.key)), [watching]);

  const setQuery = useCallback((q: string | null) => setQueryState(q), []);
  // The same text again: clear it for a moment so the search runs anew.
  const retry = useCallback(() => {
    const q = query;
    if (!q) return;
    setQueryState(null);
    window.setTimeout(() => setQueryState(q), 60);
  }, [query]);

  const setWatching = useCallback(async (key: string, title: string, turnOn: boolean) => {
    try {
      const list = await call<DiscoverWatch[]>('discover.watch', { key, on: turnOn });
      if (Array.isArray(list)) setWatchingList(list);
      voiceOver.say(turnOn ? `Watching ${title}` : `Stopped watching ${title}`, 'notice');
      return turnOn;
    } catch (err) {
      useStore.getState().toast({ tone: 'warning', title: 'Couldn’t update Watching', body: errorMessage(err) });
      return null;
    }
  }, []);

  const loadMore = online.loadMore;
  return useMemo(
    () => ({ rows, query, setQuery, loadMore, retry, watchingKeys, setWatching, status }),
    [rows, query, setQuery, loadMore, retry, watchingKeys, setWatching, status],
  );
}
