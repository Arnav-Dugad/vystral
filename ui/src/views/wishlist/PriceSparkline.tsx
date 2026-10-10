import { useId } from 'react';
import type { WishlistItem } from '../../bridge/types';
import { formatMoney, sparkline, sparklineSummary } from '../../lib/wishlist';
import { useMoneyContext } from '../../state/money';

/**
 * Track W: the Steam prices VYSTRAL has seen for one game, as a step line over real time with a soft
 * fill, a dashed line at the lowest price ever (same currency only) and a dot on today's price. Draws
 * itself in once (CSS; static under reduced motion). Renders nothing with fewer than two points.
 */
export function PriceSparkline({ item, width = 168, height = 44 }: { item: WishlistItem; width?: number; height?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  useMoneyContext(); // Track D6: the whole line's labels follow the display currency
  const comparableLow = item.lowestCurrency && item.lowestCurrency === item.currency ? item.lowestCents : null;
  const s = sparkline(item.history, width, height, comparableLow);
  if (!s) return null;
  const summary = sparklineSummary(item.history, item.currency);
  return (
    <figure className="wish-spark" aria-label={summary} role="img">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden focusable="false">
        <defs>
          <linearGradient id={`ws-fill-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.32" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {s.lowY != null && <line className="wish-spark__low" x1={0} x2={width} y1={s.lowY} y2={s.lowY} />}
        <path className="wish-spark__area" d={s.area} fill={`url(#ws-fill-${id})`} />
        <path className="wish-spark__line" d={s.line} pathLength={1} />
        <circle className="wish-spark__dot" cx={s.last.x} cy={s.last.y} r={3} />
      </svg>
      <figcaption className="wish-spark__caption" aria-hidden>
        <span>{s.days >= 2 ? `${s.days} days` : 'Recent'}</span>
        {s.min !== s.max && <span className="num">{formatMoney(s.min, item.currency)}–{formatMoney(s.max, item.currency).replace(/^≈\s*/, '')}</span>}
      </figcaption>
    </figure>
  );
}
