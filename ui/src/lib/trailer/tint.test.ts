import { describe, expect, it } from 'vitest';
import { contrastRatio, DARK_SURFACE, labToLch, lchToRgb, rgbToOklab, type Lab, type RGB } from '../color';
import {
  ACCENT_MIN_CONTRAST, AMBIENT_L, AMBIENT_MAX_C, clampAccent, clampAmbient, FOLLOW, followAllowed, frameStats, initialFollow, isUsableFrame,
  labDistance, SAMPLE_H, SAMPLE_W, stepFollow, tintFromFrame, type FollowState, type TintTarget,
} from './tint';

/** A SAMPLE_W×SAMPLE_H frame made of vertical colour bands. */
function frame(colors: RGB[]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(SAMPLE_W * SAMPLE_H * 4);
  for (let y = 0; y < SAMPLE_H; y++)
    for (let x = 0; x < SAMPLE_W; x++) {
      const c = colors[Math.floor((x / SAMPLE_W) * colors.length)];
      data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], (y * SAMPLE_W + x) * 4);
    }
  return data;
}

const target = (L: number, a: number, b: number, accent: [number, number, number] = [0.72, 0.14, 30]): TintTarget => ({
  ambient: [0, 1, 2, 3].map((i) => [L + i * 0.03, a, b] as Lab),
  accent,
});

describe('frame filtering', () => {
  it('skips black fades, white flashes and flat cards', () => {
    expect(isUsableFrame(frameStats(frame([[0, 0, 0]])))).toBe(false);
    expect(isUsableFrame(frameStats(frame([[1, 1, 1]])))).toBe(false);
    expect(isUsableFrame(frameStats(frame([[0.4, 0.3, 0.6]])))).toBe(false);
    expect(tintFromFrame(frame([[0.02, 0.02, 0.03]]), SAMPLE_W, SAMPLE_H)).toBeNull();
  });

  it('accepts a real scene and returns four ambient colours plus an accent', () => {
    const t = tintFromFrame(frame([[0.1, 0.2, 0.5], [0.9, 0.5, 0.1], [0.2, 0.6, 0.3], [0.7, 0.1, 0.2]]), SAMPLE_W, SAMPLE_H);
    expect(t).not.toBeNull();
    expect(t!.ambient).toHaveLength(4);
    expect(t!.accent).toHaveLength(3);
  });

  it('rejects truncated data', () => {
    expect(tintFromFrame(new Uint8ClampedArray(16), SAMPLE_W, SAMPLE_H)).toBeNull();
  });
});

describe('clamping keeps it tasteful and readable', () => {
  it('ambient stays dark and low-chroma for any input', () => {
    for (const rgb of [[1, 1, 1], [0, 0, 0], [1, 0, 0], [0, 1, 0], [0.1, 0.1, 1], [1, 0, 1]] as RGB[]) {
      const [L, C] = labToLch(clampAmbient(rgbToOklab(rgb)));
      expect(L).toBeGreaterThanOrEqual(AMBIENT_L[0] - 1e-6);
      expect(L).toBeLessThanOrEqual(AMBIENT_L[1] + 1e-6);
      expect(C).toBeLessThanOrEqual(AMBIENT_MAX_C + 1e-6);
    }
  });

  it('accent always meets the contrast guarantee against the dark surface', () => {
    for (const lch of [[0.05, 0.3, 20], [0.99, 0.01, 90], [0.5, 0.4, 140], [0.3, 0.2, 260], [0.62, 0.2, 300]] as [number, number, number][]) {
      const out = clampAccent(lch);
      expect(contrastRatio(lchToRgb(out), DARK_SURFACE)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST - 0.01);
      expect(out[1]).toBeLessThanOrEqual(0.16 + 1e-6);
    }
  });

  it('frames of pure saturated colour still yield a readable accent', () => {
    const t = tintFromFrame(frame([[1, 0, 0], [0, 0, 1], [0.05, 0.05, 0.05], [0.6, 0.6, 0.6]]), SAMPLE_W, SAMPLE_H)!;
    expect(contrastRatio(lchToRgb(t.accent), DARK_SURFACE)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST - 0.01);
  });
});

describe('smoothing never strobes', () => {
  it('snaps to the first target while invisible, then fades in', () => {
    const t = target(0.3, 0.02, -0.03);
    const s = stepFollow(initialFollow(), t, 33);
    expect(labDistance(s.ambient[0], t.ambient[0])).toBe(0);
    expect(s.weight).toBeGreaterThan(0);
    expect(s.weight).toBeLessThan(0.1);
  });

  it('limits how far colours move per second, however hard the cut', () => {
    let s = stepFollow(initialFollow(), target(0.18, -0.06, 0.06), 33);
    s = { ...s, weight: 0.5 };
    const cut = target(0.4, 0.06, -0.06);
    for (let i = 0; i < 30; i++) {
      const next = stepFollow(s, cut, 33);
      for (let c = 0; c < 4; c++) expect(labDistance(s.ambient[c], next.ambient[c])).toBeLessThanOrEqual((FOLLOW.maxStepPerSec * 33) / 1000 + 1e-9);
      s = next;
    }
  });

  it('converges on a steady target and approaches the maximum weight', () => {
    const t = target(0.3, 0.03, 0.01);
    let s = stepFollow(initialFollow(), target(0.2, -0.03, 0), 33);
    for (let i = 0; i < 30 * 12; i++) s = stepFollow(s, t, 33);
    expect(labDistance(s.ambient[2], t.ambient[2])).toBeLessThan(0.002);
    expect(s.weight).toBeGreaterThan(FOLLOW.maxWeight - 0.01);
    expect(s.weight).toBeLessThanOrEqual(FOLLOW.maxWeight);
  });

  it('eases back to the artwork when the trailer stops, slower than it came in', () => {
    let s: FollowState = { ...stepFollow(initialFollow(), target(0.3, 0, 0), 33), weight: FOLLOW.maxWeight };
    const half = (() => {
      let t = 0;
      while (s.weight > FOLLOW.maxWeight / 2) {
        s = stepFollow(s, null, 33);
        t += 33;
      }
      return t;
    })();
    expect(half).toBeGreaterThan(900);
    for (let i = 0; i < 400; i++) s = stepFollow(s, null, 33);
    expect(s.weight).toBe(0);
  });

  it('is frame-rate independent and ignores long stalls', () => {
    const t = target(0.35, 0.02, 0.02);
    let a = { ...stepFollow(initialFollow(), target(0.25, 0, 0), 16), weight: 0.4 };
    let b = { ...a };
    for (let i = 0; i < 60; i++) a = stepFollow(a, t, 16);
    for (let i = 0; i < 30; i++) b = stepFollow(b, t, 32);
    expect(Math.abs(a.weight - b.weight)).toBeLessThan(0.01);
    expect(labDistance(a.ambient[0], b.ambient[0])).toBeLessThan(0.01);
    const stalled = stepFollow(a, null, 60_000);
    expect(stalled.weight).toBeGreaterThan(a.weight * 0.8);
  });
});

describe('gating', () => {
  const ok = { setting: undefined, livingCanvas: true, quality: 'balanced', reducedMotion: false, safeMode: false, hidden: false };
  it('runs by default and stops for every opt-out', () => {
    expect(followAllowed(ok)).toBe(true);
    expect(followAllowed({ ...ok, setting: false })).toBe(false);
    expect(followAllowed({ ...ok, livingCanvas: false })).toBe(false);
    expect(followAllowed({ ...ok, quality: 'low' })).toBe(false);
    expect(followAllowed({ ...ok, reducedMotion: true })).toBe(false);
    expect(followAllowed({ ...ok, safeMode: true })).toBe(false);
    expect(followAllowed({ ...ok, hidden: true })).toBe(false);
  });
});
