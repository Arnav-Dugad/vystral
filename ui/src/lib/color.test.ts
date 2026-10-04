import { describe, expect, it } from 'vitest';
import { contrastRatio, ensureContrast, extractPalette, fallbackPalette, labToLch, lchToRgb, oklabToRgb, rgbToOklab, type RGB } from './color';

const DARK_SURFACE = lchToRgb([0.165, 0.014, 282]);

function parseOklch(css: string): [number, number, number] {
  const m = css.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)/)!;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function image(colors: RGB[], size = 32): Uint8ClampedArray {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const c = colors[Math.floor((i / (size * size)) * colors.length)];
    data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], i * 4);
  }
  return data;
}

describe('OKLab conversion', () => {
  it('round-trips sRGB', () => {
    for (const c of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.5, 0.5, 0.5], [0.1, 0.6, 0.9]] as RGB[]) {
      const back = oklabToRgb(rgbToOklab(c));
      back.forEach((v, i) => expect(v).toBeCloseTo(c[i], 4));
    }
  });

  it('gives white L≈1 and black L≈0', () => {
    expect(labToLch(rgbToOklab([1, 1, 1]))[0]).toBeCloseTo(1, 3);
    expect(labToLch(rgbToOklab([0, 0, 0]))[0]).toBeCloseTo(0, 3);
  });
});

describe('contrast', () => {
  it('matches the WCAG reference for black on white', () => {
    expect(contrastRatio([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 1);
  });

  it('ensureContrast lifts a dark accent until it is readable', () => {
    const fixed = ensureContrast([0.3, 0.15, 290], DARK_SURFACE, 4.5);
    expect(contrastRatio(lchToRgb(fixed), DARK_SURFACE)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('extractPalette', () => {
  it('always produces an accent with ≥4.5:1 contrast on the dark surface', () => {
    const cases: RGB[][] = [
      [[0.05, 0.6, 0.25], [0.02, 0.02, 0.02]],          // saturated green + black
      [[0.95, 0.95, 0.9], [0.9, 0.85, 0.8]],            // near-white artwork
      [[0.1, 0.1, 0.12]],                               // almost black
      [[0.8, 0.2, 0.1], [0.1, 0.2, 0.8], [0.9, 0.8, 0.1]],
    ];
    for (const colors of cases) {
      const p = extractPalette(image(colors), 32, 32);
      expect(contrastRatio(lchToRgb(parseOklch(p.accent)), DARK_SURFACE)).toBeGreaterThanOrEqual(4.45);
      expect(p.ambient).toHaveLength(4);
    }
  });

  it('is deterministic', () => {
    const data = image([[0.8, 0.3, 0.1], [0.1, 0.3, 0.7]]);
    expect(extractPalette(data, 32, 32)).toEqual(extractPalette(data, 32, 32));
  });

  it('classifies warm artwork', () => {
    expect(extractPalette(image([[0.9, 0.4, 0.1], [0.8, 0.2, 0.1]]), 32, 32).temperature).toBe('warm');
  });

  it('fallback palette is readable for every hue', () => {
    for (let h = 0; h < 360; h += 30) {
      const p = fallbackPalette(h);
      expect(contrastRatio(lchToRgb(parseOklch(p.accent)), DARK_SURFACE)).toBeGreaterThanOrEqual(4.45);
    }
  });
});
