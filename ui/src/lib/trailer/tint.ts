/**
 * "The Living Canvas follows the trailer." While a hero trailer is visibly playing, HeroTrailer
 * reads a tiny 32×18 copy of the current frame a few times a second, turns it into a palette
 * here, and publishes it; the Living Canvas eases its ambient colours (and, gently, the page
 * accent) toward it and eases back to the artwork palette when the trailer stops.
 *
 * Everything that decides *what* colour to show is pure and tested: frame filtering (black
 * fades and white flashes are ignored), clamping (dark, low-chroma ambient; a readable accent
 * with a guaranteed contrast ratio) and the smoothing (exponential approach plus a hard
 * slew-rate limit, so scene cuts can never strobe the background).
 */
import { create } from 'zustand';
import {
  DARK_SURFACE, ensureContrast, extractPalette, gamutMap, labToLch, lchToLab, oklabToRgb, parseOklch, rgbToOklab,
  type Lab, type LCh, type RGB,
} from '../color';

/** Sampling canvas size (16:9). 576 pixels is plenty for four colours and costs well under 1 ms. */
export const SAMPLE_W = 32;
export const SAMPLE_H = 18;
/** ~3 samples per second: fast enough to follow a scene, slow enough to cost nothing. */
export const SAMPLE_INTERVAL_MS = 320;

/** A palette target taken from one frame. Ambient colours are OKLab, darkest first. */
export interface TintTarget {
  ambient: Lab[];
  accent: LCh;
}

export interface TrailerTint extends TintTarget {
  gameId: string;
}

/* ------------------------------------------------------------------ gating */

export interface FollowConditions {
  /** `canvas.followTrailer` (undefined = default on). */
  setting: boolean | undefined;
  livingCanvas: boolean;
  /** Effective quality after "auto" is resolved. */
  quality: string | undefined;
  reducedMotion: boolean;
  safeMode: boolean;
  hidden: boolean;
}

/** Whether sampling may run at all (the trailer must additionally be visibly playing). */
export function followAllowed(c: FollowConditions): boolean {
  return c.setting !== false && c.livingCanvas && c.quality !== 'low' && !c.reducedMotion && !c.safeMode && !c.hidden;
}

/* ------------------------------------------------------------------ frames → palette */

/** Mean OKLab lightness and its spread (standard deviation) over opaque pixels. */
export function frameStats(data: Uint8ClampedArray): { meanL: number; spread: number } {
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const L = rgbToOklab([data[i] / 255, data[i + 1] / 255, data[i + 2] / 255])[0];
    sum += L;
    sq += L * L;
    n++;
  }
  if (!n) return { meanL: 0, spread: 0 };
  const meanL = sum / n;
  return { meanL, spread: Math.sqrt(Math.max(0, sq / n - meanL * meanL)) };
}

/**
 * Black fades, white flashes and flat title cards say nothing about the trailer's colours;
 * following them would pump the whole background, so they are skipped (the last target holds).
 */
export function isUsableFrame(s: { meanL: number; spread: number }): boolean {
  return s.meanL > 0.12 && s.meanL < 0.93 && s.spread > 0.025;
}

/** Ambient colours stay dark and quiet whatever the trailer shows. */
export const AMBIENT_L: readonly [number, number] = [0.16, 0.4];
export const AMBIENT_MAX_C = 0.08;
/** Accent bounds (before the contrast guarantee, which may only lighten it further). */
export const ACCENT_L: readonly [number, number] = [0.62, 0.84];
export const ACCENT_MAX_C = 0.16;
/** Minimum contrast of the accent against the dark surface (WCAG AA for text). */
export const ACCENT_MIN_CONTRAST = 4.5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampAmbient(lab: Lab): Lab {
  const [L, C, h] = labToLch(lab);
  return lchToLab(gamutMap([clamp(L, AMBIENT_L[0], AMBIENT_L[1]), Math.min(C, AMBIENT_MAX_C), h]));
}

export function clampAccent(lch: LCh): LCh {
  const [L, C, h] = lch;
  return ensureContrast([clamp(L, ACCENT_L[0], ACCENT_L[1]), Math.min(Math.max(0, C), ACCENT_MAX_C), h], DARK_SURFACE, ACCENT_MIN_CONTRAST);
}

/** Palette target for one sampled frame, or null when the frame should be ignored. */
export function tintFromFrame(data: Uint8ClampedArray, width: number, height: number): TintTarget | null {
  if (data.length < width * height * 4 || !isUsableFrame(frameStats(data))) return null;
  const p = extractPalette(data, width, height, 4);
  const accent = parseOklch(p.accent);
  if (!accent || p.ambient.length < 4) return null;
  return { ambient: p.ambient.slice(0, 4).map((c) => clampAmbient(rgbToOklab(c))), accent: clampAccent(accent) };
}

/* ------------------------------------------------------------------ smoothing */

export interface FollowState {
  /** Four ambient colours in OKLab, darkest first. */
  ambient: Lab[];
  accent: Lab;
  /** How much the trailer palette shows over the artwork palette (0…FOLLOW.maxWeight). */
  weight: number;
}

export const FOLLOW = {
  /** Time constant of the colour approach. */
  colorTauMs: 1400,
  /** Hard limit on how far any colour may move per second (OKLab distance). Prevents strobing on cuts. */
  maxStepPerSec: 0.16,
  /** Ease in when the trailer starts, out (slower) when it stops. */
  inTauMs: 1100,
  outTauMs: 1800,
  /** The artwork palette always shows through a little: the canvas follows, it doesn't switch. */
  maxWeight: 0.8,
  /** Longest frame step considered (a hidden window resumes calmly instead of jumping). */
  maxDtMs: 250,
} as const;

export const labDistance = (a: Lab, b: Lab) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function approach(from: Lab, to: Lab, k: number, maxStep: number): Lab {
  const next: Lab = [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k, from[2] + (to[2] - from[2]) * k];
  const d = labDistance(from, next);
  if (d <= maxStep || d === 0) return next;
  const s = maxStep / d;
  return [from[0] + (next[0] - from[0]) * s, from[1] + (next[1] - from[1]) * s, from[2] + (next[2] - from[2]) * s];
}

export function initialFollow(): FollowState {
  return { ambient: [[0.2, 0, 0], [0.24, 0, 0], [0.28, 0, 0], [0.32, 0, 0]], accent: [0.7, 0, 0], weight: 0 };
}

/**
 * Advances the follower by `dtMs` toward `target` (or back toward the artwork when null).
 * Frame-rate independent; colours never move faster than FOLLOW.maxStepPerSec.
 */
export function stepFollow(state: FollowState, target: TintTarget | null, dtMs: number): FollowState {
  const dt = clamp(dtMs, 0, FOLLOW.maxDtMs);
  if (!target) {
    const weight = state.weight * Math.exp(-dt / FOLLOW.outTauMs);
    return { ...state, weight: weight < 0.002 ? 0 : weight };
  }
  // Fully faded out: jump straight to the new target (invisible at weight 0), then fade in.
  if (state.weight === 0) {
    return { ambient: target.ambient.map((c) => c.slice() as Lab), accent: lchToLab(target.accent), weight: FOLLOW.maxWeight * (1 - Math.exp(-dt / FOLLOW.inTauMs)) };
  }
  const k = 1 - Math.exp(-dt / FOLLOW.colorTauMs);
  const maxStep = (FOLLOW.maxStepPerSec * dt) / 1000;
  const weight = FOLLOW.maxWeight + (state.weight - FOLLOW.maxWeight) * Math.exp(-dt / FOLLOW.inTauMs);
  return {
    ambient: state.ambient.map((c, i) => approach(c, target.ambient[i] ?? c, k, maxStep)),
    accent: approach(state.accent, lchToLab(target.accent), k, maxStep),
    weight,
  };
}

/** Ambient colours as sRGB for the shader. */
export function followRgb(state: FollowState): RGB[] {
  return state.ambient.map((c) => oklabToRgb(c).map((v) => clamp(v, 0, 1)) as RGB);
}

/* ------------------------------------------------------------------ shared state */

interface HeroTrailerState {
  /** Game whose hero trailer is currently visible (faded in over the artwork), or null. */
  visibleFor: string | null;
  /** Latest palette target from the playing trailer, or null. */
  tint: TrailerTint | null;
  setVisible(gameId: string, visible: boolean): void;
  setTint(tint: TrailerTint | null): void;
}

/** Tiny shared channel between HeroTrailer (producer), the Living Canvas and the hero ghost line. */
export const useHeroTrailer = create<HeroTrailerState>((set, get) => ({
  visibleFor: null,
  tint: null,
  setVisible(gameId, visible) {
    const cur = get().visibleFor;
    if (visible && cur !== gameId) set({ visibleFor: gameId });
    else if (!visible && cur === gameId) set({ visibleFor: null });
  },
  setTint(tint) {
    if (tint !== get().tint) set({ tint });
  },
}));
