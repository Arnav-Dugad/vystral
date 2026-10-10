/**
 * Track D5: cloud availability for Discover cards. Cards ask for their key; requests made in the same moment are
 * batched into one discover.cloudMap call (answered natively from the cloud catalogues VYSTRAL already downloaded: no
 * network request). Nothing is asked while cloud play is off.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { call, on } from '../bridge/bridge';
import type { DiscoverCloudMap } from '../bridge/types';
import { useStore } from './store';

type Entry = DiscoverCloudMap['map'][string];

interface DiscoverCloudState {
  /** key → services (an empty list = asked, not listed). */
  map: Record<string, Entry>;
}

export const useDiscoverCloudStore = create<DiscoverCloudState>(() => ({ map: {} }));

const pending = new Set<string>();
let timer: number | undefined;
let subscribed = false;
/** Same shapes as DiscoverKeys.KeyPattern on the native side. */
export const DISCOVER_KEY = /^(?:steam-\d{1,10}|igdb-\d{1,12}|rawg-[a-z0-9][a-z0-9-]{0,119}|wd-Q\d{1,12})$/;

function flush() {
  timer = undefined;
  const keys = [...pending].slice(0, 120);
  for (const k of keys) pending.delete(k);
  if (!keys.length) return;
  call<DiscoverCloudMap>('discover.cloudMap', { keys })
    .then((r) => {
      const got = r && typeof r === 'object' && r.map && typeof r.map === 'object' ? r.map : {};
      useDiscoverCloudStore.setState((s) => {
        const next = { ...s.map };
        for (const k of keys) next[k] = Array.isArray(got[k]) ? got[k].filter((e) => e && (e.service === 'gfn' || e.service === 'xbox')) : [];
        return { map: next };
      });
    })
    .catch(() => {
      // Older builds (no discover.cloudMap) or a hiccup: show no badge, and don't ask again for these keys.
      useDiscoverCloudStore.setState((s) => ({ map: { ...s.map, ...Object.fromEntries(keys.map((k) => [k, [] as Entry])) } }));
    });
  if (pending.size) timer = window.setTimeout(flush, 30);
}

function subscribe() {
  if (subscribed) return;
  subscribed = true;
  const reset = () => useDiscoverCloudStore.setState({ map: {} });
  on('cloud.changed', reset);
  let last: unknown;
  on('settings.changed', (s) => {
    const k = `${s?.['cloud.enabled']}|${s?.['cloud.gfn']}|${s?.['cloud.xbox']}|${s?.['cloud.market']}`;
    if (k !== last) { last = k; reset(); }
  });
}

/** The cloud services that list a Discover result (null while unknown or cloud play is off). */
export function useDiscoverCloud(key: string | null | undefined): Entry | null {
  const enabled = useStore((s) => !!s.settings?.['cloud.enabled']);
  const entry = useDiscoverCloudStore((s) => (key ? s.map[key] : undefined));
  useEffect(() => {
    if (!enabled || !key || !DISCOVER_KEY.test(key)) return;
    subscribe();
    if (useDiscoverCloudStore.getState().map[key] !== undefined || pending.has(key)) return;
    pending.add(key);
    if (timer === undefined) timer = window.setTimeout(flush, 30);
  }, [enabled, key, entry]);
  return enabled && entry && entry.length ? entry : null;
}
