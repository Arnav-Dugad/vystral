/**
 * Plays a Steam HLS trailer through Media Source Extensions (WebView2 has no native HLS).
 * Steam's segments are already fragmented MP4, so each track's init segment and chunks are
 * appended as-is to one SourceBuffer per track. Fetching stays at most ~24 s ahead of the
 * playhead, so pausing (or leaving the page) stops the download too. Every URL comes from the
 * same-origin-checked proxy (https://media.vystral.example/trailer/…), never from Steam directly.
 *
 * Why not hls.js: it would work (Apache-2.0, ~120 KB gzipped, lazy-loadable), but Steam's
 * trailers have a single fixed shape, and ~200 lines of MSE avoid a dependency, its worker
 * (CSP) and its ABR machinery we don't want for a muted, capped, buffered-ahead hero loop.
 */
import { parseMaster, parseMedia, pickAudio, pickVariant, resolveUri, type HlsMedia } from './hls';

const AHEAD_SECONDS = 24;

export interface AttachedTrailer {
  hasAudio: boolean;
  /** True once the whole trailer is buffered and nothing was evicted, so a loop needs no re-download. */
  canLoop(): boolean;
  destroy(): void;
}

export class TrailerError extends Error {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const onAbort = () => {
      window.clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    // Remove the abort listener when the timer wins: a paused trailer sleeps in a loop.
    const t = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

async function getText(url: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal, credentials: 'omit' });
  if (!res.ok) throw new TrailerError(`Trailer playlist unavailable (${res.status})`);
  return res.text();
}

async function getBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal, credentials: 'omit' });
  if (!res.ok) throw new TrailerError(`Trailer segment unavailable (${res.status})`);
  return res.arrayBuffer();
}

function waitEvent(target: EventTarget, name: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); };
    const cleanup = () => { target.removeEventListener(name, done); signal.removeEventListener('abort', abort); };
    target.addEventListener(name, done, { once: true });
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function attachHlsTrailer(video: HTMLVideoElement, masterUrl: string, maxHeight: number, signal: AbortSignal): Promise<AttachedTrailer> {
  if (typeof MediaSource === 'undefined') throw new TrailerError('Media Source Extensions are unavailable');
  const master = parseMaster(await getText(masterUrl, signal));
  if (!master) throw new TrailerError('Unrecognised trailer playlist');
  const variant = pickVariant(master.variants, maxHeight, (m) => MediaSource.isTypeSupported(m));
  if (!variant?.videoCodec) throw new TrailerError('No playable trailer variant');
  const audioRendition = pickAudio(master, variant);
  const audioMime = audioRendition && variant.audioCodec ? `audio/mp4; codecs="${variant.audioCodec}"` : null;

  const videoUrl = resolveUri(masterUrl, variant.uri);
  const audioUrl = audioRendition && audioMime && MediaSource.isTypeSupported(audioMime) ? resolveUri(masterUrl, audioRendition.uri) : null;
  const [videoList, audioList] = await Promise.all([
    getText(videoUrl, signal).then(parseMedia),
    audioUrl ? getText(audioUrl, signal).then(parseMedia).catch(() => null) : Promise.resolve(null),
  ]);
  if (!videoList) throw new TrailerError('Unrecognised trailer playlist');

  const ms = new MediaSource();
  const objectUrl = URL.createObjectURL(ms);
  let evicted = false;
  let complete = false;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    URL.revokeObjectURL(objectUrl);
    video.removeAttribute('src');
    video.load();
  };
  signal.addEventListener('abort', cleanup, { once: true });
  video.src = objectUrl;
  await waitEvent(ms, 'sourceopen', signal);
  ms.duration = Math.max(videoList.totalDuration, audioList?.totalDuration ?? 0);

  const feed = async (list: HlsMedia, playlistUrl: string, mime: string) => {
    const sb = ms.addSourceBuffer(mime);
    const append = async (data: ArrayBuffer) => {
      for (let attempt = 0; ; attempt++) {
        try {
          sb.appendBuffer(data);
          await waitEvent(sb, 'updateend', signal);
          return;
        } catch (err) {
          if (!(err instanceof DOMException) || err.name !== 'QuotaExceededError' || attempt > 0) throw err;
          // Out of room: drop what has already been watched and try once more. Before 4 s there is
          // nothing behind the playhead to drop (and remove(0, 0) would throw), so give up instead.
          const watched = video.currentTime - 4;
          if (!(watched > 0)) throw err;
          evicted = true;
          sb.remove(0, watched);
          await waitEvent(sb, 'updateend', signal);
        }
      }
    };
    if (list.init) await append(await getBytes(resolveUri(playlistUrl, list.init), signal));
    let start = 0;
    for (const seg of list.segments) {
      while (start - video.currentTime > AHEAD_SECONDS) await sleep(500, signal);
      await append(await getBytes(resolveUri(playlistUrl, seg.uri), signal));
      start += seg.duration;
    }
  };

  const videoMime = `video/mp4; codecs="${variant.videoCodec}"`;
  const tracks = [feed(videoList, videoUrl, videoMime)];
  if (audioList && audioUrl && audioMime) tracks.push(feed(audioList, audioUrl, audioMime));
  void Promise.all(tracks)
    .then(() => {
      if (ms.readyState === 'open') ms.endOfStream();
      complete = true;
    })
    .catch((err: unknown) => {
      if (signal.aborted) return;
      console.warn('[trailer] stopped buffering', err);
      if (ms.readyState === 'open') {
        try { ms.endOfStream('network'); } catch { /* already closed */ }
      }
    });

  return {
    hasAudio: tracks.length > 1,
    canLoop: () => complete && !evicted,
    destroy: cleanup,
  };
}
