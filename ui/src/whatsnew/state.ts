import { create } from 'zustand';
import { call } from '../bridge/bridge';
import { featureFor, isBadgeVisible, type BadgeContext } from './badges';
import type { Tour } from './tours';

/** `whatsNew.state` (AppBackend.Updates.cs; preview.updates.ts in a browser). */
export interface WhatsNewInfo {
  currentVersion: string;
  lastSeenVersion: string | null;
  firstVersion: string | null;
  seenBadges: string[];
  rollbackNotice: { from: string; to: string; at: string } | null;
}

interface WhatsNewState extends BadgeContext {
  loaded: boolean;
  lastSeenVersion: string | null;
  rollbackNotice: WhatsNewInfo['rollbackNotice'];
  /** The tour being shown (null when closed). */
  tour: Tour | null;
  load(): Promise<WhatsNewInfo | null>;
  markBadgesSeen(keys: string[]): void;
  markVersionSeen(version: string): void;
  showTour(tour: Tour): void;
  closeTour(): void;
}

let pending = new Set<string>();
let flushQueued = false;

export const useWhatsNew = create<WhatsNewState>((set, get) => ({
  loaded: false,
  current: null,
  firstVersion: null,
  lastSeenVersion: null,
  seen: new Set(),
  rollbackNotice: null,
  tour: null,

  async load() {
    try {
      const info = await call<WhatsNewInfo>('whatsNew.state');
      set({
        loaded: true,
        current: info.currentVersion,
        firstVersion: info.firstVersion,
        lastSeenVersion: info.lastSeenVersion,
        seen: new Set(info.seenBadges),
        rollbackNotice: info.rollbackNotice,
      });
      return info;
    } catch {
      set({ loaded: true });
      return null;
    }
  },

  markBadgesSeen(keys) {
    const { seen } = get();
    const fresh = keys.filter((k) => !seen.has(k));
    if (fresh.length === 0) return;
    set({ seen: new Set([...seen, ...fresh]) });
    for (const k of fresh) pending.add(k);
    // Coalesced: badges seen in the same moment are saved in one call.
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      const all = [...pending];
      pending = new Set();
      for (let i = 0; i < all.length; i += 50) void call('whatsNew.badgesSeen', { keys: all.slice(i, i + 50) }).catch(() => {});
    });
  },

  markVersionSeen(version) {
    set({ lastSeenVersion: version });
    void call('whatsNew.markSeen', { version }).catch(() => {});
  },

  showTour(tour) {
    set({ tour });
  },

  closeTour() {
    set({ tour: null });
  },
}));

export const isNewKey = (s: BadgeContext, key: string) => isBadgeVisible(featureFor(key), s);

/** Opens the newest "What's new" tour on demand (About, Updates). */
export const OPEN_WHATS_NEW = 'vystral:open-whats-new';
export const openWhatsNew = () => window.dispatchEvent(new CustomEvent(OPEN_WHATS_NEW));
