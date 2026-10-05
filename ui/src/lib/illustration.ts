/**
 * Empty-state illustrations: palette derivation and deterministic geometry. Pure, so both are
 * unit-tested; components/ui/EmptyArt.tsx only draws what these return.
 */
import { contrastRatio, cssOklch, ensureContrast, gamutMap, hashString, lchToRgb, type LCh, type RGB } from './color';

export type ArtKind = 'constellation' | 'hills' | 'orbits' | 'tide' | 'shelf' | 'trophy';
export type ArtTheme = 'obsidian' | 'oled' | 'light' | 'contrast';

export interface IllustrationPalette {
  /** Strongest strokes and the focal dots; ≥3:1 against the panel surface (non-text graphics). */
  ink: string;
  /** Secondary shapes, hue-shifted a little from the accent so the art isn't monochrome. */
  mid: string;
  /** Background shapes; deliberately low contrast. */
  faint: string;
  /** Soft halo behind the focal point (translucent). */
  glow: string;
  /** Highlights ("stars"). */
  star: string;
  /** High-contrast theme: flat, solid, no hue except the theme's own accent. */
  flat: boolean;
}

const BRAND_VIOLET: LCh = [0.7, 0.17, 292];

/** Panel surfaces (≈ --bg-1) per theme; the art sits on these. */
export const ART_SURFACES: Record<ArtTheme, RGB> = {
  obsidian: lchToRgb([0.165, 0.014, 282]),
  oled: lchToRgb([0.11, 0.006, 282]),
  light: lchToRgb([0.99, 0.003, 282]),
  contrast: [0, 0, 0],
};

const hue = (h: number) => ((h % 360) + 360) % 360;

/**
 * Tones for an illustration from the current accent (or brand violet). Chroma is capped so a
 * neon cover can't make an empty page shout; the ink tone is pushed until it has 3:1 contrast
 * with the theme's panel surface; light themes get darker inks and pale fills.
 */
export function illustrationPalette(accent: LCh | null | undefined, theme: ArtTheme = 'obsidian'): IllustrationPalette {
  if (theme === 'contrast') {
    return { ink: 'oklch(1 0 0)', mid: 'oklch(0.88 0.16 100)', faint: 'oklch(0.55 0 0)', glow: 'oklch(0.88 0.16 100 / 0)', star: 'oklch(1 0 0)', flat: true };
  }
  const [, c0, h0] = accent && accent.every(Number.isFinite) ? accent : BRAND_VIOLET;
  const c = Math.min(Math.max(c0, 0.04), 0.16);
  const surface = ART_SURFACES[theme];
  const light = theme === 'light';
  const ink = ensureContrast(gamutMap(light ? [0.48, c, h0] : [0.8, Math.min(c, 0.13), h0]), surface, 3);
  const mid = gamutMap(light ? [0.62, c * 0.85, hue(h0 + 26)] : [0.62, c * 0.85, hue(h0 + 26)]);
  const faint = gamutMap(light ? [0.88, c * 0.45, hue(h0 - 18)] : [0.36, c * 0.55, hue(h0 - 18)]);
  const star = light ? gamutMap([0.36, c * 0.6, h0]) : gamutMap([0.96, 0.03, h0]);
  return {
    ink: cssOklch(ink),
    mid: cssOklch(mid),
    faint: cssOklch(faint),
    glow: cssOklch(gamutMap([light ? 0.7 : 0.72, c, h0]), light ? 0.22 : 0.32),
    star: cssOklch(star),
    flat: false,
  };
}

/** Contrast of the ink tone against its surface (exposed for tests and the design doc). */
export function inkContrast(accent: LCh | null, theme: ArtTheme): number {
  const p = illustrationPalette(accent, theme);
  const m = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)/.exec(p.ink)!;
  return contrastRatio(lchToRgb([Number(m[1]), Number(m[2]), Number(m[3])]), ART_SURFACES[theme]);
}

const CALM: ArtKind[] = ['constellation', 'hills', 'orbits', 'tide'];

/** A calm illustration chosen from a stable seed (the empty state's title). */
export function artKindFor(seed: string): ArtKind {
  return CALM[hashString(seed) % CALM.length];
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

export interface Star { x: number; y: number; r: number; bright: boolean }

/**
 * A constellation in a 168×120 box that keeps the centre (where the icon sits) clear: points in a
 * ring around it, each linked to its nearest neighbour so it reads as a figure, not noise.
 */
export function constellation(seed: string, count = 11): { stars: Star[]; links: [number, number][] } {
  const r = rng(hashString(seed));
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.5;
    const rx = 52 + r() * 24;
    const ry = 34 + r() * 18;
    stars.push({ x: 84 + Math.cos(a) * rx, y: 60 + Math.sin(a) * ry, r: 1 + r() * 1.6, bright: r() > 0.72 });
  }
  const links: [number, number][] = [];
  for (let i = 0; i < stars.length; i++) {
    const j = (i + 1) % stars.length;
    if (r() > 0.35) links.push([i, j]);
  }
  return { stars, links };
}

/** Three layered hill silhouettes (back to front) as SVG paths in a 168×120 box. */
export function hills(seed: string): string[] {
  const r = rng(hashString(seed) ^ 0x9e3779b9);
  return [0, 1, 2].map((layer) => {
    const base = 74 + layer * 13;
    const amp = 12 - layer * 3 + r() * 4;
    const phase = r() * Math.PI * 2;
    const freq = 1.2 + layer * 0.5 + r() * 0.4;
    const pts: string[] = [];
    for (let x = 0; x <= 168; x += 12) {
      const y = base - Math.sin((x / 168) * Math.PI * freq + phase) * amp - Math.sin((x / 168) * Math.PI * 3.1 + phase * 2) * amp * 0.25;
      pts.push(`${x} ${y.toFixed(1)}`);
    }
    return `M0 120 L${pts.join(' L')} L168 120 Z`;
  });
}
