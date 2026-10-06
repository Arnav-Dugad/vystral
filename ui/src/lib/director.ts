/**
 * Track N: the live-tile director. Picks the most interesting ~2 s of a micro-trailer to loop, from
 * small frames sampled across the clip: lots of motion and colour wins; black frames, fades and flat
 * frames, and title cards/logos (sharp, colourless edges on a plain background) lose; a window whose
 * last frame looks like its first loops more smoothly. Pure and deterministic so it can be tested on
 * synthetic frames; director.worker.ts runs it off the main thread.
 */

/** How long the chosen loop is (seconds). */
export const LOOP_SECONDS = 2;
/** Frames are analysed at this size (16:9). Small is enough for energy, and keeps the worker cheap. */
export const FRAME_W = 48;
export const FRAME_H = 27;
/** Clips shorter than this are simply looped whole. */
export const MIN_CLIP_SECONDS = LOOP_SECONDS + 0.75;
/** Below this the best window isn't worth it: loop the whole clip instead. */
export const MIN_SCORE = 0.12;

export interface FrameStats {
  /** Time in the clip (seconds). */
  t: number;
  /** Mean luma, 0..1. */
  luma: number;
  /** Luma standard deviation, 0..~0.5. */
  contrast: number;
  /** Mean saturation, 0..1. */
  sat: number;
  /** Share of pixels on a sharp luma edge (text and logos have many). */
  edges: number;
  /** Mean absolute luma change from the previous sampled frame, 0..1 (0 for the first). */
  motion: number;
}

export interface LoopPick {
  start: number;
  duration: number;
  score: number;
}

const EDGE = 0.22;
/** A frame-to-frame change this large is a hard cut, not motion. */
export const CUT = 0.25;

/** Statistics of one RGBA frame; returns its luma plane too, for the next frame's motion. */
export function frameStats(rgba: ArrayLike<number>, w: number, h: number, t: number, prev: Float32Array | null): { stats: FrameStats; luma: Float32Array } {
  const n = w * h;
  const luma = new Float32Array(n);
  let sum = 0, sumSq = 0, sat = 0, motion = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] / 255, g = rgba[i * 4 + 1] / 255, b = rgba[i * 4 + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = l;
    sum += l;
    sumSq += l * l;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    sat += max > 0.04 ? (max - min) / max : 0;
    if (prev) motion += Math.abs(l - prev[i]);
  }
  let edges = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if ((x + 1 < w && Math.abs(luma[i] - luma[i + 1]) > EDGE) || (y + 1 < h && Math.abs(luma[i] - luma[i + w]) > EDGE)) edges++;
    }
  }
  const mean = sum / n;
  return {
    luma,
    stats: {
      t,
      luma: mean,
      contrast: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
      sat: sat / n,
      edges: edges / n,
      motion: prev ? motion / n : 0,
    },
  };
}

export const isDark = (f: FrameStats) => f.luma < 0.08;
export const isFlat = (f: FrameStats) => f.contrast < 0.035;
/** Text or a logo on a plain, colourless background (title cards, publisher logos, rating screens). */
export const isTitleCard = (f: FrameStats) => f.edges > 0.1 && f.sat < 0.2 && (f.luma < 0.3 || f.luma > 0.75);
export const isDull = (f: FrameStats) => isDark(f) || isFlat(f) || isTitleCard(f);

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** How interesting a run of frames is to loop. Roughly 0..1; can go negative for poor loops. */
export function scoreWindow(frames: readonly FrameStats[]): number {
  if (frames.length < 2) return -1;
  const dull = frames.filter(isDull).length / frames.length;
  const moves = frames.slice(1).map((f) => f.motion);
  const cuts = moves.filter((m) => m > CUT).length;
  const motion = clamp01(mean(moves.map((m) => Math.min(m, CUT))) / 0.08);
  const colour = clamp01(mean(frames.map((f) => f.sat)) / 0.5);
  const contrast = clamp01(mean(frames.map((f) => f.contrast)) / 0.25);
  const first = frames[0], last = frames[frames.length - 1];
  const seam = Math.abs(first.luma - last.luma) + Math.abs(first.sat - last.sat);
  return (0.5 * motion + 0.3 * colour + 0.2 * contrast) * (1 - dull) - 0.25 * seam - 0.08 * cuts;
}

/**
 * The best {@link LOOP_SECONDS} window, or null to loop the whole clip (short clip, too few frames,
 * or nothing scores at least {@link MIN_SCORE}). Ties go to the earlier window.
 */
export function pickLoop(frames: readonly FrameStats[], duration: number, loop = LOOP_SECONDS): LoopPick | null {
  if (!Number.isFinite(duration) || duration < loop + 0.75 || frames.length < 4) return null;
  let best: LoopPick | null = null;
  for (let i = 0; i < frames.length; i++) {
    const start = frames[i].t;
    if (start + loop > duration + 1e-6) break;
    const window = frames.filter((f) => f.t >= start - 1e-6 && f.t <= start + loop + 1e-6);
    if (window.length < 3) continue;
    const score = scoreWindow(window);
    if (!best || score > best.score + 1e-9) best = { start: Math.round(start * 100) / 100, duration: loop, score: Math.round(score * 1e4) / 1e4 };
  }
  return best && best.score >= MIN_SCORE ? best : null;
}

/** Statistics for a whole clip's sampled frames (in time order). */
export function analyseFrames(frames: readonly { t: number; data: ArrayLike<number> }[], w = FRAME_W, h = FRAME_H): FrameStats[] {
  const out: FrameStats[] = [];
  let prev: Float32Array | null = null;
  for (const f of frames) {
    const { stats, luma } = frameStats(f.data, w, h, f.t, prev);
    out.push(stats);
    prev = luma;
  }
  return out;
}

/** Where to sample: every 1/6 s, or fewer for long clips (at most `max` frames), never the very first or last instant. */
export function sampleTimes(duration: number, max = 72): number[] {
  if (!Number.isFinite(duration) || duration <= 0.2) return [];
  const step = Math.max(1 / 6, duration / max);
  const out: number[] = [];
  for (let t = 0.05; t < duration - 0.05; t += step) out.push(Math.round(t * 1000) / 1000);
  return out;
}

/* ------------------------------------------------------------- playing the loop */

export interface Segment {
  start: number;
  end: number;
}

/** The segment to loop for a clip of `duration` seconds, or null to loop the whole clip. */
export function segmentFor(loop: { start: number; duration: number } | null | undefined, duration: number): Segment | null {
  if (!loop || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(loop.start) || !Number.isFinite(loop.duration)) return null;
  const start = Math.min(Math.max(0, loop.start), duration);
  const end = Math.min(duration, start + Math.max(0, loop.duration));
  if (end - start < 0.8) return null;
  if (start <= 0.05 && end >= duration - 0.05) return null;
  return { start, end };
}

/** The crossfade at the loop point (ms). */
export const SEAM_MS = 280;

/**
 * What the player should do at playback time `t`: keep playing, wrap back to the start with a
 * crossfade (the end is reached, or about to be within a frame), or jump into the segment without
 * one (playback is outside it — e.g. just loaded, or the browser looped the file itself).
 */
export function loopStep(t: number, seg: Segment): 'play' | 'wrap' | 'seek' {
  if (t < seg.start - 0.15 || t > seg.end + 0.35) return 'seek';
  if (t >= seg.end - 0.08) return 'wrap';
  return 'play';
}
