import { describe, expect, it } from 'vitest';
import {
  analyseFrames, FRAME_H, FRAME_W, frameStats, isDark, isFlat, isTitleCard, LOOP_SECONDS, loopStep, pickLoop, sampleTimes, scoreWindow, segmentFor,
  type FrameStats,
} from './director';

// Synthetic frames: solid colours, a moving colourful pattern, and white "text" on black.
type RGB = [number, number, number];
function frame(fill: (x: number, y: number) => RGB, w = FRAME_W, h = FRAME_H): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fill(x, y);
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return d;
}
const black = () => frame(() => [0, 0, 0]);
const grey = () => frame(() => [128, 128, 128]);
/** Text-like: thin white strokes every few pixels on black. */
const titleCard = () => frame((x, y) => (y > 10 && y < 16 && x % 3 === 0 ? [255, 255, 255] : [6, 6, 6]));
/** Action: saturated, high-contrast colour bands sliding sideways over time. */
const action = (t: number) => frame((x, y) => {
  const band = Math.floor((x + t * 30) / 6) % 3;
  return band === 0 ? [230, 40, 40] : band === 1 ? [30, 200, 80] : [40, 60, 220 - y];
});

const SIX = 1 / 6;

/** A clip: 0–1 s black (fade in), 1–2.5 s title card, 2.5–5 s action, 5–6 s fade to black. */
function trailer(): FrameStats[] {
  const frames = sampleTimes(6).map((t) => ({
    t,
    data: t < 1 ? black() : t < 2.5 ? titleCard() : t < 5 ? action(t) : black(),
  }));
  return analyseFrames(frames);
}

describe('frame statistics', () => {
  it('measures brightness, colour, edges and motion', () => {
    const a = frameStats(action(0), FRAME_W, FRAME_H, 0, null);
    const b = frameStats(action(0.2), FRAME_W, FRAME_H, 0.2, a.luma);
    expect(a.stats.sat).toBeGreaterThan(0.6);
    expect(a.stats.motion).toBe(0);
    expect(b.stats.motion).toBeGreaterThan(0.05);
    expect(frameStats(black(), FRAME_W, FRAME_H, 0, null).stats.luma).toBe(0);
  });

  it('recognises black, flat and title-card frames', () => {
    const s = (d: Uint8ClampedArray) => frameStats(d, FRAME_W, FRAME_H, 0, null).stats;
    expect(isDark(s(black()))).toBe(true);
    expect(isFlat(s(grey()))).toBe(true);
    expect(isTitleCard(s(titleCard()))).toBe(true);
    expect(isTitleCard(s(action(0)))).toBe(false);
    expect(isDark(s(action(0))) || isFlat(s(action(0)))).toBe(false);
  });
});

describe('choosing the loop', () => {
  it('skips fades and title cards and picks the action', () => {
    const pick = pickLoop(trailer(), 6);
    expect(pick).not.toBeNull();
    expect(pick!.duration).toBe(LOOP_SECONDS);
    expect(pick!.start).toBeGreaterThanOrEqual(2.5 - SIX);
    expect(pick!.start + pick!.duration).toBeLessThanOrEqual(5 + SIX);
  });

  it('scores motion and colour above stillness, and dull frames near zero', () => {
    const all = trailer();
    const window = (from: number) => all.filter((f) => f.t >= from && f.t <= from + 2);
    expect(scoreWindow(window(2.8))).toBeGreaterThan(scoreWindow(window(1)));
    expect(scoreWindow(window(0))).toBeLessThan(0.1);
  });

  it('prefers a window whose ends match (a smoother seam)', () => {
    const base = { contrast: 0.2, sat: 0.6, edges: 0.02, motion: 0.05 };
    const smooth = [0, 0.5, 1, 1.5, 2].map((t) => ({ ...base, t, luma: 0.5 }));
    const jumpy = smooth.map((f, i) => ({ ...f, luma: i === 4 ? 0.9 : 0.5 }));
    expect(scoreWindow(smooth)).toBeGreaterThan(scoreWindow(jumpy));
  });

  it('loops short or dull clips whole', () => {
    expect(pickLoop(trailer().filter((f) => f.t < 2.5), 2.5)).toBeNull(); // shorter than a loop and a bit
    const dull = analyseFrames(sampleTimes(6).map((t) => ({ t, data: t < 3 ? black() : titleCard() })));
    expect(pickLoop(dull, 6)).toBeNull();
    expect(pickLoop([], 10)).toBeNull();
  });

  it('samples about six frames a second, fewer for long clips', () => {
    expect(sampleTimes(3)).toHaveLength(18);
    expect(sampleTimes(60).length).toBeLessThanOrEqual(72);
    expect(sampleTimes(0)).toEqual([]);
    expect(Math.max(...sampleTimes(3))).toBeLessThan(3);
  });
});

describe('loop scheduling', () => {
  it('maps a loop onto the clip, or plays it whole', () => {
    expect(segmentFor({ start: 2.5, duration: 2 }, 6)).toEqual({ start: 2.5, end: 4.5 });
    expect(segmentFor({ start: 5, duration: 2 }, 6)).toEqual({ start: 5, end: 6 });
    expect(segmentFor({ start: 5.6, duration: 2 }, 6)).toBeNull(); // too little left
    expect(segmentFor({ start: 0, duration: 3 }, 3)).toBeNull(); // the whole clip anyway
    expect(segmentFor(null, 6)).toBeNull();
    expect(segmentFor({ start: 1, duration: 2 }, Number.NaN)).toBeNull();
  });

  it('plays inside the segment, wraps at its end and jumps in from outside', () => {
    const seg = { start: 2, end: 4 };
    expect(loopStep(2, seg)).toBe('play');
    expect(loopStep(3.9, seg)).toBe('play');
    expect(loopStep(3.95, seg)).toBe('wrap');
    expect(loopStep(4.1, seg)).toBe('wrap');
    expect(loopStep(0, seg)).toBe('seek'); // just loaded, or the browser looped the file
    expect(loopStep(5, seg)).toBe('seek');
  });
});
