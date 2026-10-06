/**
 * Track N: the live-tile director's browser side. Samples a cached micro-trailer in an offscreen
 * <video> (one clip at a time, between idle moments), hands small frames to director.worker.ts, and
 * stores the pick natively (keyed by the clip's bytes) so each clip is analysed once. Analysis only
 * runs while live tiles may play at all, and stops the moment they may not.
 */
import { call } from '../../bridge/bridge';
import type { LiveLoop } from '../../bridge/types';
import { FRAME_H, FRAME_W, MIN_CLIP_SECONDS, sampleTimes, type LoopPick } from '../../lib/director';

let worker: Worker | null = null;
let seq = 0;
const replies = new Map<number, (r: { pick?: LoopPick | null; error?: string }) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../../lib/director.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; pick?: LoopPick | null; error?: string }>) => {
      replies.get(e.data.id)?.(e.data);
      replies.delete(e.data.id);
    };
  }
  return worker;
}

const idle = () =>
  new Promise<void>((resolve) =>
    typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 120 }) : setTimeout(resolve, 16),
  );

function once(target: EventTarget, type: string, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      target.removeEventListener(type, onEvent);
      target.removeEventListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      if (ok) resolve();
      else reject(new Error(signal.aborted ? 'aborted' : `${type} timed out`));
    };
    const onEvent = () => done(true);
    const onError = () => done(false);
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    target.addEventListener(type, onEvent);
    target.addEventListener('error', onError);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * Analyses one clip. Resolves with the loop to play, null for "loop the whole clip", or rejects
 * (aborted, undecodable, or frames that can't be read).
 */
export async function analyseClip(src: string, signal: AbortSignal): Promise<LoopPick | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous'; // the media host allows the app's origin; frames must stay readable
  const id = ++seq;
  const w = getWorker();
  try {
    video.src = src;
    await once(video, 'loadeddata', 10_000, signal);
    const duration = video.duration;
    if (!Number.isFinite(duration) || duration < MIN_CLIP_SECONDS) return null;
    for (const t of sampleTimes(duration)) {
      if (signal.aborted) throw new Error('aborted');
      video.currentTime = t;
      await once(video, 'seeked', 3000, signal);
      const bitmap = await createImageBitmap(video, { resizeWidth: FRAME_W, resizeHeight: FRAME_H, resizeQuality: 'low' });
      w.postMessage({ type: 'frame', id, t, bitmap }, [bitmap]);
      await idle();
    }
    const reply = await new Promise<{ pick?: LoopPick | null; error?: string }>((resolve) => {
      replies.set(id, resolve);
      w.postMessage({ type: 'done', id, duration });
    });
    if (reply.error) throw new Error(reply.error);
    return reply.pick ?? null;
  } catch (err) {
    w.postMessage({ type: 'drop', id });
    replies.delete(id);
    throw err;
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/* ------------------------------------------------------------- queue */

type Waiter = { resolve: (loop: LiveLoop | null) => void; reject: (e: unknown) => void };
const queue: { gameId: string; src: string; signal: AbortSignal; waiters: Waiter[] }[] = [];
const attempted = new Set<string>();
let busy = false;

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.signal.aborted) throw new Error('aborted');
    const pick = await analyseClip(job.src, job.signal);
    const loop = pick ? { start: pick.start, duration: pick.duration } : null;
    // Stored natively against the clip's bytes; a refusal (e.g. tiles just turned off) is harmless.
    await call('liveTile.setLoop', { gameId: job.gameId, start: loop?.start ?? null, duration: loop?.duration ?? null, score: pick?.score ?? 0 }).catch(() => undefined);
    job.waiters.forEach((w) => w.resolve(loop));
  } catch (err) {
    if (job.signal.aborted) attempted.delete(job.gameId); // interrupted, not failed: may try again later
    job.waiters.forEach((w) => w.reject(err));
  } finally {
    busy = false;
    void pump();
  }
}

/**
 * Asks for a game's clip to be analysed (once per session per game; failures aren't retried until
 * the next session). Resolves with the loop, or null for the whole clip.
 */
export function directLiveTile(gameId: string, src: string, signal: AbortSignal): Promise<LiveLoop | null> {
  return new Promise((resolve, reject) => {
    const waiting = queue.find((q) => q.gameId === gameId);
    if (waiting) {
      waiting.waiters.push({ resolve, reject });
      return;
    }
    if (attempted.has(gameId)) {
      reject(new Error('already analysed this session'));
      return;
    }
    attempted.add(gameId);
    queue.push({ gameId, src, signal, waiters: [{ resolve, reject }] });
    void pump();
  });
}
