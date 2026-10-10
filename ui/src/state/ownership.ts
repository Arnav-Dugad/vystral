import { call, on } from '../bridge/bridge';
import type { OwnershipNotice } from '../bridge/types';

/**
 * Track C1: the quiet "no longer in your Steam library" toast. The backend keeps the notice until it is read
 * (a sync can finish while VYSTRAL is in the tray), and reading clears it, so it is shown exactly once.
 */
export interface OwnershipToast {
  tone: 'info';
  title: string;
  body: string;
  action: { label: string; run: () => void };
}

export function ownershipToast(count: number, showThem: () => void): OwnershipToast {
  const n = Math.max(1, Math.floor(count));
  return {
    tone: 'info',
    title: n === 1 ? '1 game is no longer in your Steam library' : `${n} games are no longer in your Steam library`,
    body: `Refunded or removed from your account, so ${n === 1 ? 'it’s' : 'they’re'} out of your library. Play history, notes and ratings are kept, and come back if you buy ${n === 1 ? 'it' : 'them'} again.`,
    action: { label: n === 1 ? 'Show it' : 'Show them', run: showThem },
  };
}

let started = false;

export function startOwnershipNotices(show: (t: OwnershipToast) => void, showThem: () => void): void {
  if (started) return;
  started = true;
  let busy = false;
  const take = async () => {
    if (busy) return;
    busy = true;
    try {
      const notice = await call<OwnershipNotice | null>('steam.ownershipNotice');
      if (notice && notice.count > 0) show(ownershipToast(notice.count, showThem));
    } catch {
      // Older backend or offline preview: nothing to show.
    } finally {
      busy = false;
    }
  };
  on('steam.ownershipChanged', () => void take());
  void take();
}
