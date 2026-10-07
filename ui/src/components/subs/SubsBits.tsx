import { memo } from 'react';
import { Hourglass } from 'lucide-react';
import type { SubsBadge as Badge } from '../../bridge/types';
import { badgeLabel, badgeText, FAMILY, leavingLabel } from '../../lib/subs';
import { useSubsMap } from '../../state/subs';
import { ServiceLogo } from '../ui/ServiceLogo';
import './subs.css';

/**
 * Small badge on library cards and list rows: the plan's mark for games your subscriptions include, amber with
 * "Leaving" when Game Pass lists it as leaving soon. Renders nothing while the public lists are off.
 */
export const SubsBadge = memo(function SubsBadge({ gameId }: { gameId: string }) {
  const map = useSubsMap();
  const badges = map?.[gameId];
  if (!badges?.length) return null;
  const leaving = badges.find((b) => b.leaving);
  const label = badgeLabel(badges);
  const first = badges[0];
  return (
    <span className="subs-badge" role="img" aria-label={label} title={label} data-leaving={leaving ? true : undefined}
      data-likely={badges.every((b) => b.match === 'title') || undefined}>
      <ServiceLogo service={FAMILY[first.family]?.mark ?? 'game-pass'} size={12} decorative />
      {leaving ? <><span className="subs-badge__dot" aria-hidden />Leaving</> : <span aria-hidden>{FAMILY[first.family]?.name ?? first.planName}</span>}
    </span>
  );
});

/** Game page: "Included with your Game Pass Ultimate" and, when it applies, "Leaves around 16 Oct". */
export function SubsGamePills({ gameId }: { gameId: string }) {
  const map = useSubsMap();
  const badges = map?.[gameId];
  if (!badges?.length) return null;
  return <SubsPillsView badges={badges} />;
}

export function SubsPillsView({ badges, now = Date.now() }: { badges: Badge[]; now?: number }) {
  const t = badgeText(badges);
  if (!t) return null;
  const leaving = badges.find((b) => b.leaving);
  return (
    <div className="subs-pills" data-testid="subs-pills">
      <span className="subs-pill" title={t.likely ? 'Matched by name: the store’s page shows the final answer.' : undefined}>
        <ServiceLogo service={FAMILY[badges[0].family]?.mark ?? 'game-pass'} size={16} decorative />
        <span>{t.long}</span>
      </span>
      {leaving && (
        <span className="subs-pill" data-leaving>
          <Hourglass size={14} aria-hidden />
          <span>
            {leavingLabel(leaving.leavingEnd, now, undefined, 'Game Pass')}
            {leaving.leavingEnd && <small> · from the Store listing</small>}
          </span>
        </span>
      )}
    </div>
  );
}
