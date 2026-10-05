/**
 * Colour science for the Living Canvas: sRGB ↔ OKLab/OKLCH, deterministic k-means palette
 * extraction, and accent selection with a guaranteed WCAG contrast ratio.
 */

export type RGB = [number, number, number]; // 0..1 sRGB
export type Lab = [number, number, number];
export type LCh = [number, number, number]; // L 0..1, C, h degrees

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToOklab([r, g, b]: RGB): Lab {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, a, b]: Lab): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

export const labToLch = ([L, a, b]: Lab): LCh => [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
export const lchToLab = ([L, C, h]: LCh): Lab => [L, C * Math.cos((h * Math.PI) / 180), C * Math.sin((h * Math.PI) / 180)];

const inGamut = (rgb: RGB) => rgb.every((c) => c >= -0.0005 && c <= 1.0005);

/** Reduces chroma until the colour fits in sRGB (keeps hue and lightness). */
export function gamutMap(lch: LCh): LCh {
  let [L, C, h] = lch;
  while (C > 0.001 && !inGamut(oklabToRgb(lchToLab([L, C, h])))) C -= 0.005;
  return [L, Math.max(0, C), h];
}

export function relativeLuminance(rgb: RGB): number {
  const [r, g, b] = rgb.map((c) => toLinear(Math.min(1, Math.max(0, c))));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export const lchToRgb = (lch: LCh): RGB => oklabToRgb(lchToLab(lch)).map((c) => Math.min(1, Math.max(0, c))) as RGB;
export const cssOklch = ([L, C, h]: LCh, alpha?: number) =>
  `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${h.toFixed(1)}${alpha == null ? '' : ` / ${alpha}`})`;

/** Reads back a colour written by {@link cssOklch} (`oklch(L C h)`); null for anything else. */
export function parseOklch(css: string | null | undefined): LCh | null {
  const m = /^oklch\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(css?.trim() ?? '');
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  return v.every(Number.isFinite) ? (v as LCh) : null;
}

/**
 * Adjusts lightness (hue and chroma preserved where possible) until the colour has at least
 * `minRatio` contrast against `surface`. Moves lighter on dark surfaces, darker on light ones.
 */
export function ensureContrast(lch: LCh, surface: RGB, minRatio: number): LCh {
  const lighter = relativeLuminance(surface) < 0.2;
  let [L, C, h] = gamutMap(lch);
  for (let i = 0; i < 60 && contrastRatio(lchToRgb([L, C, h]), surface) < minRatio; i++) {
    L = Math.min(0.99, Math.max(0.05, L + (lighter ? 0.01 : -0.01)));
    [L, C, h] = gamutMap([L, C, h]);
  }
  return [L, C, h];
}

export interface Palette {
  /** Main accent: brand-blended, contrast-checked. */
  accent: string;
  /** Secondary accent for gradients. */
  accent2: string;
  /** Four colours for the ambient shader, darkest first (linear-ish sRGB triplets 0..1). */
  ambient: RGB[];
  /** Overall warmth used by the Living Canvas mood. */
  temperature: 'warm' | 'cool' | 'neutral';
  /** Average lightness of the artwork (0..1). */
  lightness: number;
}

const BRAND_VIOLET: LCh = [0.7, 0.17, 292];
const BRAND_BLUE: LCh = [0.68, 0.15, 255];
/** The dark panel surface accents are contrast-checked against (≈ --bg-1 in Obsidian). */
export const DARK_SURFACE: RGB = lchToRgb([0.165, 0.014, 282]);

function mixHue(a: number, b: number, t: number) {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

export function mixLch(a: LCh, b: LCh, t: number): LCh {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, mixHue(a[2], b[2], t)];
}

/**
 * Deterministic k-means in OKLab over RGBA pixel data. Pixels near the centre count more
 * (subjects tend to be centred) and near-black/near-white/grey pixels count less.
 */
export function extractPalette(data: Uint8ClampedArray, width: number, height: number, k = 6): Palette {
  const points: Lab[] = [];
  const weights: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const lab = rgbToOklab([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255]);
      const dx = x / width - 0.5, dy = y / height - 0.5;
      const centre = 1.25 - Math.min(1, Math.hypot(dx, dy) * 1.6) * 0.5;
      points.push(lab);
      weights.push(centre);
    }
  }
  if (points.length === 0) return fallbackPalette();

  // Seed centroids at lightness quantiles for determinism.
  const sorted = points.map((p, i) => [p[0], i] as const).sort((a, b) => a[0] - b[0]);
  let centroids: Lab[] = Array.from({ length: k }, (_, j) => points[sorted[Math.floor(((j + 0.5) / k) * sorted.length)][1]].slice() as Lab);
  const assign = new Int32Array(points.length);
  for (let iter = 0; iter < 12; iter++) {
    for (let i = 0; i < points.length; i++) {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (points[i][0] - centroids[c][0]) ** 2 + (points[i][1] - centroids[c][1]) ** 2 + (points[i][2] - centroids[c][2]) ** 2;
        if (d < bestD) { bestD = d; best = c; }
      }
      assign[i] = best;
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const s = sums[assign[i]], w = weights[i];
      s[0] += points[i][0] * w; s[1] += points[i][1] * w; s[2] += points[i][2] * w; s[3] += w;
    }
    centroids = sums.map((s, c) => (s[3] > 0 ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centroids[c]) as Lab);
  }
  const pop = new Float64Array(k);
  for (let i = 0; i < points.length; i++) pop[assign[i]] += weights[i];
  const total = pop.reduce((a, b) => a + b, 0);

  const clusters = centroids.map((c, i) => ({ lch: labToLch(c), share: pop[i] / total })).filter((c) => c.share > 0.01);
  const lightness = clusters.reduce((a, c) => a + c.lch[0] * c.share, 0);

  // Accent: prefer populous *and* chromatic clusters; skip near-black/white/grey.
  const candidates = clusters.filter((c) => c.lch[0] > 0.18 && c.lch[0] < 0.95 && c.lch[1] > 0.035);
  const scored = candidates.map((c) => ({ ...c, score: Math.sqrt(c.share) * c.lch[1] })).sort((a, b) => b.score - a.score);

  let accent: LCh = scored[0]?.lch ?? BRAND_VIOLET;
  let accent2: LCh = scored.find((c) => Math.abs(((c.lch[2] - accent[2] + 540) % 360) - 180) > 25)?.lch ?? BRAND_BLUE;

  // Restraint: cap chroma, blend toward the brand so every game still feels like VYSTRAL.
  accent = mixLch(BRAND_VIOLET, [Math.max(0.62, Math.min(0.82, accent[0])), Math.min(0.18, accent[1]), accent[2]], 0.6);
  accent2 = mixLch(BRAND_BLUE, [Math.max(0.6, Math.min(0.8, accent2[0])), Math.min(0.16, accent2[1]), accent2[2]], 0.55);
  accent = ensureContrast(accent, DARK_SURFACE, 4.5);
  accent2 = ensureContrast(accent2, DARK_SURFACE, 3);

  // Ambient: dark, low-chroma versions of the four most populous clusters.
  const byShare = [...clusters].sort((a, b) => b.share - a.share).slice(0, 4);
  while (byShare.length < 4) byShare.push({ lch: byShare.length % 2 ? BRAND_BLUE : BRAND_VIOLET, share: 0 });
  const ambient = byShare
    .map((c) => lchToRgb(gamutMap([0.22 + Math.min(0.25, c.lch[0] * 0.25), Math.min(0.09, c.lch[1] * 0.8), c.lch[2]])))
    .sort((a, b) => relativeLuminance(a) - relativeLuminance(b));

  const warmShare = clusters.filter((c) => c.lch[1] > 0.04 && (c.lch[2] < 100 || c.lch[2] > 330)).reduce((a, c) => a + c.share, 0);
  const coolShare = clusters.filter((c) => c.lch[1] > 0.04 && c.lch[2] > 180 && c.lch[2] < 300).reduce((a, c) => a + c.share, 0);

  return {
    accent: cssOklch(accent),
    accent2: cssOklch(accent2),
    ambient,
    temperature: warmShare > coolShare * 1.3 ? 'warm' : coolShare > warmShare * 1.3 ? 'cool' : 'neutral',
    lightness,
  };
}

export function fallbackPalette(seedHue = 292): Palette {
  const accent = ensureContrast([0.7, 0.16, seedHue], DARK_SURFACE, 4.5);
  return {
    accent: cssOklch(accent),
    accent2: cssOklch(ensureContrast([0.68, 0.14, (seedHue + 320) % 360], DARK_SURFACE, 3)),
    ambient: [
      lchToRgb([0.18, 0.04, seedHue]),
      lchToRgb([0.24, 0.06, (seedHue + 340) % 360]),
      lchToRgb([0.28, 0.07, (seedHue + 20) % 360]),
      lchToRgb([0.32, 0.05, (seedHue + 300) % 360]),
    ],
    temperature: seedHue < 100 || seedHue > 330 ? 'warm' : 'cool',
    lightness: 0.3,
  };
}

/** Stable 32-bit hash for deterministic per-title visuals. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
