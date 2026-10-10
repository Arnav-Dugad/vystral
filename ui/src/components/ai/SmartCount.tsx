import { useMemo } from 'react';
import { matchesSmartFilter, parseSmartFilter } from '../../lib/smartFilter';
import { useTimeToBeatMap } from '../../state/recap';
import { useSubsMap } from '../../state/subs';
import { useStore } from '../../state/store';

/** Track C5: a smart collection's live game count in the sidebar (rule collections have no stored members). */
export function SmartCount({ rule }: { rule: string }) {
  const games = useStore((s) => s.library.games);
  const ttb = useTimeToBeatMap();
  const subs = useSubsMap();
  const n = useMemo(() => {
    const f = parseSmartFilter(rule);
    if (!f) return 0;
    const ctx = { ttb: ttb?.games ?? null, subs: subs as Record<string, unknown[]> | null };
    let count = 0;
    for (const g of games) if (matchesSmartFilter(g, f, ctx)) count++;
    return count;
  }, [rule, games, ttb, subs]);
  return <span className="nav-item__count">{n}</span>;
}
