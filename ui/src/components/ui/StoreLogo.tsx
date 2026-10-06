import { memo, type CSSProperties } from 'react';
import type { PlatformKey } from '../../bridge/types';
import { PLATFORM_NAMES } from '../../lib/format';
import { glyphStroke, markViewBox, opticalSize, STORE_MARKS, type OpticalSize, type StoreMark } from '../../lib/storeMarks';
import { logoMotion, type LogoMotion } from '../../lib/logoMotion';
import './store-logo.css';

/**
 * A store's mark, monochrome (currentColor) by default. `brand` tints it with the store's hue
 * (also shown on hover/selection by the surrounding CSS, never in High contrast). It names itself
 * (role="img") unless `decorative`, for places where the store's name is already written next to it.
 * `motion` (Track N) is for marks inside something interactive — a filter, a store card, a version
 * row: when that control is hovered or focused, the mark draws itself in its brand colour.
 */
export const StoreLogo = memo(function StoreLogo({
  platform,
  size = 16,
  decorative,
  brand,
  motion,
  className = '',
}: {
  platform: PlatformKey;
  size?: number;
  decorative?: boolean;
  brand?: boolean;
  motion?: boolean;
  className?: string;
}) {
  return (
    <LogoSvg
      mark={STORE_MARKS[platform] ?? STORE_MARKS.manual}
      name={PLATFORM_NAMES[platform] ?? 'Store'}
      hue={`var(--p-${platform})`}
      attrs={{ 'data-platform': platform }}
      size={size}
      decorative={decorative}
      brand={brand}
      motion={motion}
      className={`store-logo ${className}`}
    />
  );
});

/**
 * Track R: the drawing shared by store marks (StoreLogo) and service marks (ServiceLogo): the mark on
 * its optical-size viewBox, named or decorative, with the draw-on ink copy when `motion` is set.
 */
export function LogoSvg({
  mark, name, hue, attrs, size, decorative, brand, motion, className,
}: {
  mark: StoreMark;
  name: string;
  hue: string;
  attrs?: Record<string, string>;
  size: number;
  decorative?: boolean;
  brand?: boolean;
  motion?: boolean;
  className: string;
}) {
  const optical = opticalSize(size);
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name };
  const kind = logoMotion(mark, { interactive: !!motion });
  return (
    <svg
      className={className}
      {...attrs}
      data-kind={mark.kind}
      data-brand={brand || undefined}
      data-motion={kind === 'none' ? undefined : kind}
      width={size}
      height={size}
      viewBox={markViewBox(mark, optical)}
      focusable="false"
      style={{ ['--pc' as string]: hue } as CSSProperties}
      {...a11y}
    >
      {!decorative && <title>{name}</title>}
      <MarkShapes mark={mark} optical={optical} />
      {kind !== 'none' && (
        <g className="store-logo__ink" aria-hidden>
          <MarkShapes mark={mark} optical={optical} ink={kind} />
        </g>
      )}
    </svg>
  );
}

/** The mark's geometry. As ink (Track N) every shape gets pathLength=1 so CSS can draw it with one dash. */
function MarkShapes({ mark, optical, ink }: { mark: StoreMark; optical: OpticalSize; ink?: LogoMotion }) {
  const len = ink ? { pathLength: 1 } : {};
  if (mark.kind === 'brand') {
    return <path d={mark.path} fill="currentColor" className={ink ? 'store-logo__shape' : undefined} {...(ink === 'trace' ? len : {})} />;
  }
  // Added by you: a folder with a plus — a description, not a brand.
  return (
    <g fill="none" stroke="currentColor" strokeWidth={glyphStroke(optical) * 0.8} strokeLinejoin="round" strokeLinecap="round">
      <path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" className={ink ? 'store-logo__shape' : undefined} {...len} />
      <path d="M12 11v6M9 14h6" className={ink ? 'store-logo__shape' : undefined} {...len} />
    </g>
  );
}

/** The marks of every store a game is in, in a stable order, each named for assistive technology. */
export function StoreLogos({ platforms, size = 14, brand, decorative }: { platforms: readonly PlatformKey[]; size?: number; brand?: boolean; decorative?: boolean }) {
  const unique = [...new Set(platforms)];
  if (unique.length === 0) return null;
  return (
    <span className="store-logos" aria-hidden={decorative || undefined}>
      {unique.map((p) => (
        <StoreLogo key={p} platform={p} size={size} brand={brand} decorative={decorative} />
      ))}
    </span>
  );
}
