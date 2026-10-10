/**
 * Track D5: skeletons and placeholders that shimmer in a game's own hue. Where VYSTRAL already knows a game's
 * palette (the existing artwork analysis, cached), a container gets `data-skel-tint` and `--skel-tint`; every
 * `.skeleton` inside mixes that colour into its shimmer (ui.css). High contrast keeps neutral skeletons.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { Game } from '../bridge/types';
import { paletteFor, peekPalette } from './palette';

/** A CSS colour that is safe to put in a custom property (an oklch()/rgb()/hex the palette code produced). */
export function safeTint(color: string | null | undefined): string | null {
  if (!color) return null;
  const c = color.trim();
  return /^(oklch|rgb|rgba|hsl|hsla)\([0-9.\s,%/+-]+\)$/i.test(c) || /^#[0-9a-f]{3,8}$/i.test(c) ? c : null;
}

/** Props for the container: `data-skel-tint` plus the custom property, or nothing while the palette is unknown. */
export function tintProps(color: string | null | undefined): { 'data-skel-tint'?: ''; style?: CSSProperties } {
  const c = safeTint(color);
  return c ? { 'data-skel-tint': '', style: { ['--skel-tint' as string]: c } } : {};
}

/** The game's accent once known (immediately when cached; otherwise after the palette worker answers). */
export function useGameTint(game: Game | null | undefined): string | null {
  const [tint, setTint] = useState<string | null>(() => (game ? peekPalette(game)?.accent ?? null : null));
  useEffect(() => {
    if (!game) return setTint(null);
    const known = peekPalette(game)?.accent;
    if (known) return setTint(known);
    let alive = true;
    void paletteFor(game).then((p) => alive && setTint(p.accent)).catch(() => undefined);
    return () => { alive = false; };
  }, [game]);
  return tint;
}
