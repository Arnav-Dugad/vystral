import { useState } from 'react';
import { visibleWithPrefix } from './badges';
import { isNewKey, useWhatsNew } from './state';

/**
 * Whether feature `key` should show its "New" badge. With `latch`, once true it stays true for the
 * life of the component, so a row marked seen while you look at it doesn't vanish under your eyes;
 * it's simply gone next time. Without it (navigation), it disappears as soon as it's seen.
 */
export function useNewBadge(key: string, latch = false): { isNew: boolean; markSeen: () => void } {
  const live = useWhatsNew((s) => isNewKey(s, key));
  const [latched, setLatched] = useState(false);
  if (latch && live && !latched) setLatched(true);
  return { isNew: latch ? live || latched : live, markSeen: () => useWhatsNew.getState().markBadgesSeen([key]) };
}

/** True while any feature under `prefix` (e.g. "settings.privacy.") is new. Not latched. */
export function useNewBadgeGroup(prefix: string): boolean {
  return useWhatsNew((s) => visibleWithPrefix(prefix, s).length > 0);
}
