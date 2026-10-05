/**
 * "Windows accent": turns the Windows accent palette into VYSTRAL's --game / --game-2 colours.
 * Prefers Windows' own lighter shades (the ones Windows itself uses for text on dark surfaces),
 * then nudges lightness until the WCAG contrast guarantee holds, exactly like artwork accents.
 */
import { contrastRatio, cssOklch, ensureContrast, gamutMap, labToLch, lchToRgb, rgbToOklab, type LCh, type RGB } from './color';

/** The panel surface every accent is checked against (matches --bg-1 in Obsidian). */
export const ACCENT_SURFACE: RGB = lchToRgb([0.165, 0.014, 282]);
export const ACCENT_MIN_CONTRAST = 4.5;
export const ACCENT2_MIN_CONTRAST = 3;

/** Parses #RRGGBB (or #RGB). Returns null for anything else. */
export function parseHex(hex: string | null | undefined): RGB | null {
  if (!hex) return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}

const toLch = (rgb: RGB): LCh => labToLch(rgbToOklab(rgb));

/**
 * Keeps an accent in the band the rest of the design is built for: light enough to read on dark
 * panels, never so light it washes out, and chroma capped so it doesn't shout.
 */
function tame([L, C, h]: LCh): LCh {
  return gamutMap([Math.min(0.86, Math.max(0.6, L)), Math.min(0.19, C), h]);
}

export interface DerivedAccent {
  accent: string;
  accent2: string;
  /** Contrast of the accent against the panel surface (≥ 4.5). */
  contrast: number;
  /** Which Windows shade was used: 'accent' or 'light1'..'light3', or 'adjusted' when none was enough on its own. */
  source: 'accent' | 'light1' | 'light2' | 'light3' | 'adjusted';
}

/**
 * Picks the first Windows shade (accent, then AccentLight1..3) that already reads on VYSTRAL's
 * panels after taming; otherwise lifts lightness until it does. The secondary colour is the next
 * lighter shade with a small hue turn, so gradients stay in the accent's family.
 */
export function deriveSystemAccent(accentHex: string, lightHexes: readonly string[] = []): DerivedAccent | null {
  const base = parseHex(accentHex);
  if (!base) return null;
  const shades = [base, ...lightHexes.map(parseHex).filter((c): c is RGB => !!c)].slice(0, 4);
  const names = ['accent', 'light1', 'light2', 'light3'] as const;

  let pick: LCh | null = null;
  let source: DerivedAccent['source'] = 'adjusted';
  // A small margin so rounding in the CSS string can never drop below the guarantee.
  const target = ACCENT_MIN_CONTRAST + 0.05;
  for (let i = 0; i < shades.length; i++) {
    const lch = tame(toLch(shades[i]));
    if (contrastRatio(lchToRgb(lch), ACCENT_SURFACE) >= target) {
      pick = lch;
      source = names[i];
      break;
    }
  }
  pick ??= ensureContrast(tame(toLch(shades[0])), ACCENT_SURFACE, target);

  const lighter = shades[Math.min(shades.length - 1, names.indexOf(source === 'adjusted' ? 'accent' : source) + 1)];
  let second = tame(toLch(lighter));
  second = [second[0], Math.max(0.04, second[1] * 0.9), (second[2] + 338) % 360];
  second = ensureContrast(second, ACCENT_SURFACE, ACCENT2_MIN_CONTRAST + 0.05);

  return {
    accent: cssOklch(pick),
    accent2: cssOklch(second),
    contrast: contrastRatio(lchToRgb(pick), ACCENT_SURFACE),
    source,
  };
}
