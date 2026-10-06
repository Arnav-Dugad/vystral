/// <reference lib="webworker" />
import { FRAME_H, FRAME_W, frameStats, pickLoop, type FrameStats } from './director';

// Track N: the live-tile director's analysis, off the main thread. The page sends small frames
// (ImageBitmaps, transferred) as it samples a clip, then asks for the pick.
type Msg =
  | { type: 'frame'; id: number; t: number; bitmap: ImageBitmap }
  | { type: 'done'; id: number; duration: number }
  | { type: 'drop'; id: number };

const runs = new Map<number, { stats: FrameStats[]; prev: Float32Array | null }>();
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const failed = new Set<number>();

self.onmessage = (e: MessageEvent<Msg>) => {
  const m = e.data;
  if (m.type === 'drop') {
    runs.delete(m.id);
    failed.delete(m.id);
    return;
  }
  if (m.type === 'frame') {
    if (failed.has(m.id)) {
      m.bitmap.close();
      return;
    }
    try {
      canvas ??= new OffscreenCanvas(FRAME_W, FRAME_H);
      ctx ??= canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no 2d context');
      ctx.drawImage(m.bitmap, 0, 0, FRAME_W, FRAME_H);
      const { data } = ctx.getImageData(0, 0, FRAME_W, FRAME_H);
      const run = runs.get(m.id) ?? { stats: [], prev: null };
      const { stats, luma } = frameStats(data, FRAME_W, FRAME_H, m.t, run.prev);
      run.stats.push(stats);
      run.prev = luma;
      runs.set(m.id, run);
    } catch (err) {
      runs.delete(m.id);
      failed.add(m.id);
      (self as unknown as Worker).postMessage({ id: m.id, error: String(err) });
    } finally {
      m.bitmap.close();
    }
    return;
  }
  const run = runs.get(m.id);
  runs.delete(m.id);
  if (failed.delete(m.id)) return; // the error was already reported
  (self as unknown as Worker).postMessage({ id: m.id, pick: pickLoop(run?.stats ?? [], m.duration), frames: run?.stats.length ?? 0 });
};
