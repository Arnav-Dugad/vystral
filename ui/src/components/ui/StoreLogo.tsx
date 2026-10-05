import { memo, type CSSProperties } from 'react';
import type { PlatformKey } from '../../bridge/types';
import { PLATFORM_NAMES } from '../../lib/format';
import { markViewBox, monogramStroke, opticalSize, STORE_MARKS } from '../../lib/storeMarks';
import './store-logo.css';

/**
 * A store's mark, monochrome (currentColor) by default. `brand` tints it with the store's hue
 * (also shown on hover/selection by the surrounding CSS, never in High contrast). It names itself
 * (role="img") unless `decorative`, for places where the store's name is already written next to it.
 */
export const StoreLogo = memo(function StoreLogo({
  platform,
  size = 16,
  decorative,
  brand,
  className = '',
}: {
  platform: PlatformKey;
  size?: number;
  decorative?: boolean;
  brand?: boolean;
  className?: string;
}) {
  const mark = STORE_MARKS[platform] ?? STORE_MARKS.manual;
  const optical = opticalSize(size);
  const name = PLATFORM_NAMES[platform] ?? 'Store';
  const a11y = decorative ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': name };
  return (
    <svg
      className={`store-logo ${className}`}
      data-platform={platform}
      data-kind={mark.kind}
      data-brand={brand || undefined}
      width={size}
      height={size}
      viewBox={markViewBox(mark, optical)}
      focusable="false"
      style={{ ['--pc' as string]: `var(--p-${platform})` } as CSSProperties}
      {...a11y}
    >
      {!decorative && <title>{name}</title>}
      {mark.kind === 'brand' && <path d={mark.path} fill="currentColor" />}
      {mark.kind === 'monogram' && (
        // Neutral monogram (no official Xbox mark is available under a usable licence): a rounded
        // square, deliberately not the Xbox sphere, with a plain X.
        <g fill="none" stroke="currentColor" strokeWidth={monogramStroke(optical)} strokeLinecap="round">
          <rect x={2} y={2} width={20} height={20} rx={6} strokeWidth={monogramStroke(optical) * 0.75} />
          <path d="M8.2 8.2 15.8 15.8M15.8 8.2 8.2 15.8" />
        </g>
      )}
      {mark.kind === 'glyph' && (
        // Added by you: a folder with a plus — a description, not a brand.
        <g fill="none" stroke="currentColor" strokeWidth={monogramStroke(optical) * 0.8} strokeLinejoin="round" strokeLinecap="round">
          <path d="M3 7.5a2 2 0 0 1 2-2h4.2l2 2.2H19a2 2 0 0 1 2 2V17.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M12 11v6M9 14h6" />
        </g>
      )}
    </svg>
  );
});

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
