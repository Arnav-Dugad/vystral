import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { call } from '../../bridge/bridge';
import type { Game, LiveLoop, LiveTileInfo, NetworkStatus } from '../../bridge/types';
import { liveTileBlock, MIN_VISIBLE, pickPlaying, REST_MS, rotate, type LiveBlock, type TileSnapshot } from '../../lib/liveTiles';
import { loopStep, segmentFor, SEAM_MS, type Segment } from '../../lib/director';
import { directLiveTile } from './liveDirector';
import { effectiveQuality } from '../../lib/trailer/policy';
import { useReducedMotion, useStore } from '../../state/store';
import './live-tile.css';

/* ------------------------------------------------------------- scheduler */

const tiles = new Map<string, TileSnapshot>();
const listeners = new Map<string, (playing: boolean) => void>();
let playing = new Set<string>();
let frame = 0;
let rotation: number | undefined;

function schedule() {
  if (frame || typeof requestAnimationFrame === 'undefined') return;
  frame = requestAnimationFrame(run);
}

function run() {
  frame = 0;
  const now = performance.now();
  for (const t of rotate([...tiles.values()], now)) tiles.set(t.key, t);
  const next = new Set(pickPlaying([...tiles.values()], now));
  for (const key of playing) {
    if (next.has(key)) continue;
    const t = tiles.get(key);
    if (t) tiles.set(key, { ...t, playingSince: null, lastPlayedAt: t.playingSince != null ? now : t.lastPlayedAt });
    listeners.get(key)?.(false);
  }
  for (const key of next) {
    if (playing.has(key)) continue;
    const t = tiles.get(key);
    if (t) tiles.set(key, { ...t, playingSince: now });
    listeners.get(key)?.(true);
  }
  playing = next;
  // Re-check every few seconds while anything plays, so long stints hand over to waiting tiles.
  if (playing.size && rotation === undefined) rotation = window.setInterval(schedule, 4000);
  if (!playing.size && rotation !== undefined) {
    window.clearInterval(rotation);
    rotation = undefined;
  }
}

function update(key: string, patch: Partial<TileSnapshot>) {
  const t = tiles.get(key);
  if (!t) return;
  tiles.set(key, { ...t, ...patch });
  schedule();
}

/* ------------------------------------------------------------- sources */

const sources = new Map<string, Promise<LiveTileInfo>>();

/** One bridge call per game per session for answers that won't change; transient refusals are asked again later. */
function liveSource(gameId: string): Promise<LiveTileInfo> {
  let p = sources.get(gameId);
  if (!p) {
    p = call<LiveTileInfo>('liveTile.get', { gameId }, 120_000).catch(() => ({ gameId, src: null, reason: 'notChecked' as const }));
    sources.set(gameId, p);
    void p.then((info) => {
      if (!info.src && info.reason !== 'none' && info.reason !== 'noSteamApp') sources.delete(gameId);
    });
  }
  return p;
}

/** Track N: remembers the director's pick so every tile of this game (and later mounts) loops it. */
function rememberLoop(gameId: string, loop: LiveLoop | null) {
  const p = sources.get(gameId);
  if (p) sources.set(gameId, p.then((info) => ({ ...info, loop, directed: true })));
}

/* ------------------------------------------------------------- conditions */

let hiddenNow = typeof document !== 'undefined' && document.visibilityState === 'hidden';
const hiddenSubs = new Set<() => void>();
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    hiddenNow = document.visibilityState === 'hidden';
    hiddenSubs.forEach((f) => f());
  });
const useHidden = () =>
  useSyncExternalStore(
    (f) => (hiddenSubs.add(f), () => void hiddenSubs.delete(f)),
    () => hiddenNow,
  );

let network: NetworkStatus | null = null;
let networkFor: unknown = null;
const networkSubs = new Set<() => void>();
function refreshNetwork(settings: unknown) {
  if (networkFor === settings) return;
  networkFor = settings;
  void call<NetworkStatus>('network.status')
    .then((n) => {
      network = n;
      networkSubs.forEach((f) => f());
    })
    .catch(() => undefined);
}

/** Data saver as the native side sees it (manual, or automatic on a metered connection). */
function useDataSaver(): boolean {
  const settings = useStore((s) => s.settings);
  useEffect(() => refreshNetwork(settings), [settings]);
  const n = useSyncExternalStore(
    (f) => (networkSubs.add(f), () => void networkSubs.delete(f)),
    () => network,
  );
  return !!settings?.['dataSaver.enabled'] || !!n?.dataSaverActive;
}

/** Why Home tiles can't animate right now, or null. */
export function useLiveBlock(): LiveBlock | null {
  const settings = useStore((s) => s.settings);
  const gameActive = useStore((s) => !!s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase));
  const safeMode = useStore((s) => !!s.info?.safeMode);
  const reduce = useReducedMotion();
  const hidden = useHidden();
  const dataSaver = useDataSaver();
  return liveTileBlock({
    setting: settings?.['home.liveTiles'] ?? true,
    dataSaver,
    offline: !!settings?.['privacy.localOnly'],
    reducedMotion: reduce,
    quality: effectiveQuality(settings?.['appearance.quality'], typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 8),
    gameActive,
    hidden,
    safeMode,
  });
}

/* ------------------------------------------------------------- layer */

const FADE_MS = 650;

/**
 * Sits inside a tile's frame, over the cover. While the tile is at least half on screen it asks
 * for the game's micro-trailer; when the scheduler gives it a slot it plays it muted and looped,
 * crossfading in from the still cover, and fades back out when it loses the slot (scrolled away,
 * another tile hovered, its turn is up, a game starts, the window hides).
 */
export function LiveLayer({ game }: { game: Game }) {
  const block = useLiveBlock();
  const key = useId();
  const ref = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [slot, setSlot] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  // Track N: the director's loop for this clip (undefined = not analysed yet), and the segment it maps to once the clip's length is known.
  const [loop, setLoop] = useState<LiveLoop | null | undefined>(undefined);
  const [seg, setSeg] = useState<Segment | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const seam = useRef<HTMLCanvasElement>(null);
  const steam = game.installations.some((i) => i.platform === 'steam');
  const enabled = steam && block === null;

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    tiles.set(key, { key, ratio: 0, hasVideo: false, hovered: false, order: 0, playingSince: null, restUntil: 0, lastPlayedAt: 0 });
    listeners.set(key, setSlot);
    let asked = false;
    let alive = true;
    const io = new IntersectionObserver(
      ([e]) => {
        const r = e.boundingClientRect;
        update(key, { ratio: e.intersectionRatio, order: Math.round(r.top / 8) * 100_000 + Math.round(r.left) });
        if (!asked && e.intersectionRatio >= MIN_VISIBLE) {
          asked = true;
          void liveSource(game.id).then((info) => {
            if (!alive || !info.src) return;
            setSrc(info.src);
            setLoop(info.directed ? (info.loop ?? null) : undefined);
            update(key, { hasVideo: true });
          });
        }
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(el);
    const host = el.closest<HTMLElement>('.card, .tile') ?? el.parentElement!;
    const on = () => update(key, { hovered: true });
    // Hover-out pauses: the tile rests and its slot goes to the next one on screen.
    const off = () => update(key, playing.has(key) ? { hovered: false, restUntil: performance.now() + REST_MS } : { hovered: false });
    host.addEventListener('pointerenter', on);
    host.addEventListener('pointerleave', off);
    host.addEventListener('focusin', on);
    host.addEventListener('focusout', off);
    return () => {
      alive = false;
      io.disconnect();
      host.removeEventListener('pointerenter', on);
      host.removeEventListener('pointerleave', off);
      host.removeEventListener('focusin', on);
      host.removeEventListener('focusout', off);
      tiles.delete(key);
      listeners.delete(key);
      if (playing.delete(key)) schedule();
      setSlot(false);
    };
  }, [enabled, key, game.id]);

  // Mount the video when the tile gets a slot; fade out and release the decoder when it loses it.
  useEffect(() => {
    if (slot && src) {
      setMounted(true);
      return;
    }
    setShown(false);
    video.current?.pause();
    const t = window.setTimeout(() => setMounted(false), FADE_MS);
    return () => window.clearTimeout(t);
  }, [slot, src]);

  useEffect(() => {
    const v = video.current;
    if (mounted && slot && v) void v.play().catch(() => undefined);
  }, [mounted, slot]);

  // Track N: once a clip has played for a moment, ask the director for its best ~2 s (once per clip).
  useEffect(() => {
    if (!enabled || !src || loop !== undefined || !shown) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setAnalysing(true);
      directLiveTile(game.id, src, ctl.signal)
        .then((l) => {
          rememberLoop(game.id, l);
          if (!ctl.signal.aborted) setLoop(l);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!ctl.signal.aborted) setAnalysing(false);
        });
    }, 1200);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
      setAnalysing(false);
    };
  }, [enabled, src, loop, shown, game.id]);

  // Map the loop to this clip once its length is known.
  useEffect(() => {
    const v = video.current;
    if (!mounted || !v) return;
    const apply = () => setSeg(segmentFor(loop, v.duration));
    apply();
    v.addEventListener('loadedmetadata', apply);
    return () => v.removeEventListener('loadedmetadata', apply);
  }, [mounted, loop]);

  // Play only the segment: at its end, freeze the last frame on a canvas, jump back, and dissolve the
  // canvas into the restarted segment (one decoder per tile, no visible jump).
  useEffect(() => {
    const v = video.current;
    if (!mounted || !slot || !v || !seg) return;
    let alive = true;
    let handle = 0;
    const rvfc = typeof v.requestVideoFrameCallback === 'function';
    const seamOn = () => {
      const c = seam.current;
      if (!c || !v.videoWidth) return;
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      try {
        c.getContext('2d')?.drawImage(v, 0, 0);
        c.dataset.on = 'true';
      } catch {
        /* no seam is fine */
      }
    };
    const seamOff = () => requestAnimationFrame(() => {
      if (seam.current) delete seam.current.dataset.on;
    });
    const next = () => {
      handle = rvfc ? v.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };
    function tick() {
      if (!alive || !v || !seg) return;
      const step = loopStep(v.currentTime, seg);
      if (step !== 'play' && !v.seeking) {
        seamOn(); // also when the browser looped the file itself or the clip was playing whole: never a visible jump
        v.currentTime = seg.start;
        v.addEventListener('seeked', seamOff, { once: true });
      }
      next();
    }
    if (v.readyState >= 1 && loopStep(v.currentTime, seg) === 'seek') {
      seamOn();
      v.currentTime = seg.start;
      v.addEventListener('seeked', seamOff, { once: true });
    }
    next();
    return () => {
      alive = false;
      if (rvfc) v.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      v.removeEventListener('seeked', seamOff);
    };
  }, [mounted, slot, seg]);

  if (!steam) return null;
  return (
    <div
      ref={ref}
      className="live-layer"
      data-playing={shown || undefined}
      data-director={src ? (seg ? 'segment' : analysing ? 'analysing' : loop === undefined ? undefined : 'full') : undefined}
      data-loop-start={seg ? seg.start.toFixed(2) : undefined}
      data-loop-end={seg ? seg.end.toFixed(2) : undefined}
      style={{ ['--seam-ms' as string]: `${SEAM_MS}ms` }}
      aria-hidden
    >
      {mounted && src && (
        <video
          ref={video}
          className="live-layer__video"
          src={src}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          onPlaying={() => setShown(true)}
          onError={() => {
            setShown(false);
            setSrc(null);
            update(key, { hasVideo: false });
          }}
        />
      )}
      {mounted && src && seg && <canvas ref={seam} className="live-layer__seam" />}
    </div>
  );
}

/** For tests: which tiles hold a slot right now. */
export function livePlayingCount(): number {
  return playing.size;
}
