// Track D5: the "Free this week" shelf. The contract for freebies.get / freebies.open, built against Track D4's native
// GamerPower client (src/Vystral.Windows/DataSources/GamerPowerClient.cs). Until that lands, the browser preview
// implements it (bridge/preview.freebies.ts) and the real app answers "unavailable", which the UI treats as "nothing
// to show".

/** Where a giveaway is claimed. 'other' covers any store the client doesn't name. */
export type FreebiePlatform = 'steam' | 'epic' | 'gog' | 'prime' | 'itch' | 'ubisoft' | 'ea' | 'xbox' | 'battlenet' | 'other';

export interface FreebieItem {
  /** Opaque, stable id (GamerPower's numeric id as a string): [0-9]{1,10}. */
  id: string;
  title: string;
  platform: FreebiePlatform;
  /** The usual price as the source states it ("$19.99"), or null/absent when unknown or "N/A". */
  worth?: string | null;
  /** When the giveaway ends (ISO 8601), or null/absent when the source doesn't say. */
  endDate?: string | null;
  /** A cached image on the art host (https://art.vystral.example/…), or null: a generated cover is drawn. */
  image: string | null;
  /**
   * The official claim page (store page) as https. Shown only as its host ("store.epicgames.com"); the UI never
   * navigates to it itself: freebies.open({ id }) asks the native side to open the URL it holds, after checking
   * the host against the official store hosts.
   */
  url: string;
  /** 'game' (full game to keep) | 'dlc' | 'loot' (in-game items) | 'other'. Absent = 'game'. */
  kind?: 'game' | 'dlc' | 'loot' | 'other';
}

/**
 * call('freebies.get', { refresh? }).
 * - 'ready'   items are current.
 * - 'stale'   an older copy (Offline mode, or the source didn't answer); `items` still usable.
 * - 'off'     the opt-in is off (setting `freebies.enabled`).
 * - 'offline' Offline mode is on and nothing was saved before.
 * - 'failed'  the source couldn't be reached and nothing was saved.
 */
export interface Freebies {
  items: FreebieItem[];
  /** When the list was fetched (ISO), or null. */
  fetchedAt: string | null;
  state: 'ready' | 'stale' | 'off' | 'offline' | 'failed';
  /** rateLimited | unavailable | offline | null */
  reason?: string | null;
  /** Only the browser preview sets this: every giveaway is fictional. */
  preview?: boolean;
}
