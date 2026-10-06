import { memo, useEffect, useState } from 'react';
import { Cloud } from 'lucide-react';
import type { CloudMeter as Meter, CloudService } from '../../bridge/types';
import { badgeLabel, formatHours, meterSummary, resetLabel, SERVICE_NAME } from '../../lib/cloud';
import { useCloudMap } from '../../state/cloud';
import './cloud.css';

/**
 * Generic service mark: a cloud glyph with a one-letter tag. Deliberately not either vendor's logo (a real logo
 * registry can replace it); the service is always named in text or aria-label next to it.
 */
export function CloudMark({ service, size = 16 }: { service?: CloudService; size?: number }) {
  return (
    <span className="cloud-mark" data-service={service} style={{ ['--cm' as string]: `${size}px` }} aria-hidden>
      <Cloud size={size} strokeWidth={2} />
    </span>
  );
}

/** Small badge on library cards and list rows: shows only for games a cloud service lists (cloud play on). */
export const CloudBadge = memo(function CloudBadge({ gameId }: { gameId: string }) {
  const map = useCloudMap();
  const badges = map?.[gameId];
  if (!badges?.length) return null;
  const label = badgeLabel(badges);
  return (
    <span className="cloud-badge" role="img" aria-label={label} title={label} data-likely={badges.every((b) => b.match === 'title') || undefined}>
      <Cloud size={12} strokeWidth={2.4} aria-hidden />
      {badges.length > 1 && <span className="cloud-badge__n" aria-hidden>{badges.length}</span>}
    </span>
  );
});

/**
 * The GeForce NOW hours meter. Always labelled as an estimate from sessions VYSTRAL saw; warns gently at 80% and
 * when the limit is likely reached. `compact` is the one-line version for the game page menu.
 */
export function CloudMeterView({ meter, compact }: { meter: Meter; compact?: boolean }) {
  const sum = meterSummary(meter);
  const [shown, setShown] = useState(0);
  // The fill eases in once (CSS transition on transform; instant under reduced motion).
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(sum.fraction ?? 0));
    return () => cancelAnimationFrame(id);
  }, [sum.fraction]);
  const pct = sum.fraction == null ? null : Math.round(sum.fraction * 100);
  return (
    <div className="cloud-meter" data-tone={sum.tone} data-compact={compact || undefined}>
      <div className="cloud-meter__head">
        <span className="cloud-meter__title">{sum.title}</span>
        {meter.plan !== 'none' && <span className="cloud-meter__plan">{meter.planLabel}</span>}
      </div>
      {pct != null && (
        <div
          className="cloud-meter__bar"
          role="meter"
          aria-label="GeForce NOW hours used this month (estimated)"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-valuetext={`${formatHours(meter.usedSeconds)} of ${formatHours(meter.limitSeconds ?? 0)} used, estimated`}
        >
          <span className="cloud-meter__fill" style={{ transform: `scaleX(${shown})` }} />
          <span className="cloud-meter__tick" style={{ left: '80%' }} aria-hidden />
        </div>
      )}
      {!compact && <p className="cloud-meter__detail">{sum.detail}</p>}
      <p className="cloud-meter__foot">
        Estimated from sessions VYSTRAL saw{meter.plan !== 'none' ? ` · ${resetLabel(meter)}` : ''}
      </p>
    </div>
  );
}

/** Xbox Cloud Gaming has no hour limit applied here: just the time VYSTRAL saw this cycle. */
export function XboxCloudTime({ meter }: { meter: Meter }) {
  return (
    <div className="cloud-xtime">
      <CloudMark service="xbox" size={14} />
      <span>
        {SERVICE_NAME.xbox}: <strong>{formatHours(meter.xboxSeconds)}</strong> this cycle
        {meter.xboxSessions > 0 ? ` across ${meter.xboxSessions} session${meter.xboxSessions === 1 ? '' : 's'}` : ''}
      </span>
    </div>
  );
}
