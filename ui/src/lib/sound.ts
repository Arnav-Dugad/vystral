import { useStore } from '../state/store';
import { AmbientEngine, ambientAllowed } from './ambient';
import { moodFor, type Mood } from './mood';
import { spatialSound, type SpatialKind, type SpatialSound } from './spatialSound';

/**
 * Optional UI sounds, synthesised with Web Audio (no audio files, ~0 CPU when silent).
 * Off by default; never plays while a game is running.
 *
 * With ambient sound on (`sound.ambient`, also off by default) the same calls become soft,
 * spatial sounds in the focused game's mood — panned to where the focus landed — over a quiet
 * generative bed (see lib/ambient.ts).
 */
let ctx: AudioContext | null = null;
let lastTick = 0;
/** Track T: while voice-over speaks, interface and ambient sounds drop to this share. */
export const DUCK_LEVEL = 0.3;
let duck = 1;

function play(freqs: number[], duration: number, gain: number, type: OscillatorType = 'sine') {
  const s = useStore.getState();
  if (!s.settings?.['sounds.enabled'] || s.launch?.phase === 'running') return;
  ctx ??= new AudioContext();
  const volume = (s.settings['sounds.volume'] ?? 0.4) * gain * duck;
  const t0 = ctx.currentTime;
  freqs.forEach((f, i) => {
    const osc = ctx!.createOscillator();
    const g = ctx!.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f * (1 + (Math.random() - 0.5) * 0.03), t0 + i * duration * 0.6);
    g.gain.setValueAtTime(0, t0 + i * duration * 0.6);
    g.gain.linearRampToValueAtTime(volume, t0 + i * duration * 0.6 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * duration * 0.6 + duration);
    osc.connect(g).connect(ctx!.destination);
    osc.start(t0 + i * duration * 0.6);
    osc.stop(t0 + i * duration * 0.6 + duration + 0.02);
  });
}

/* ------------------------------------------------------------------ spatial (Track L) */

let lastSpatial = 0;

/** Plays one spatial UI sound (lib/spatialSound.ts) through a mood low-pass and a stereo panner. */
function playSpatial(s: SpatialSound) {
  const st = useStore.getState();
  if (!st.settings?.['sounds.enabled'] || (st.launch && ['starting', 'waiting', 'running'].includes(st.launch.phase))) return;
  if (typeof AudioContext === 'undefined') return;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  const volume = Math.max(0, Math.min(1, st.settings['sounds.volume'] ?? 0.4)) * duck;
  const t0 = ctx.currentTime + 0.004;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = s.cutoff;
  const panner = ctx.createStereoPanner();
  panner.pan.value = s.pan;
  filter.connect(panner).connect(ctx.destination);
  for (const n of s.notes) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = s.wave;
    osc.frequency.value = n.freq;
    const at = t0 + n.at;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(n.gain * volume, at + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, at + n.dur);
    osc.connect(env).connect(filter);
    osc.start(at);
    osc.stop(at + n.dur + 0.03);
  }
  if (s.echo > 0) {
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.11;
    const wet = ctx.createGain();
    wet.gain.value = s.echo;
    panner.connect(delay).connect(wet).connect(ctx.destination);
  }
  // Nodes are garbage-collected once the oscillators stop; nothing to clean up.
}

/* ------------------------------------------------------------------ ambient */

let engine: AmbientEngine | null = null;
let watching = false;

/** Where the focus is now (keyboard/controller focus, else the Immersive highlight), in viewport pixels. */
function focusPoint(): { x: number; y: number } {
  const el = (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('[data-focused="true"]')) as HTMLElement | null;
  if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Starts or stops the ambient layer as settings, game state, visibility and window focus change. */
export function watchAmbient() {
  if (watching || typeof window === 'undefined' || !AmbientEngine.supported()) return;
  watching = true;
  const sync = () => {
    const s = useStore.getState();
    const allowed = ambientAllowed({
      ambient: !!s.settings?.['sound.ambient'],
      uiSounds: !!s.settings?.['sounds.enabled'],
      gameActive: !!s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase),
      hidden: document.visibilityState === 'hidden',
      focused: document.hasFocus(),
    });
    if (!allowed) {
      engine?.stop();
      return;
    }
    engine ??= new AmbientEngine();
    engine.setDuck(duck);
    engine.setVolume((s.settings?.['sound.ambientVolume'] ?? 0.35) * (s.settings?.['sounds.volume'] ?? 0.4) * 2.5);
    engine.setMood(moodFor(s.focusGameId ? s.gamesById.get(s.focusGameId) : null));
    engine.start();
  };
  useStore.subscribe((s, prev) => {
    if (s.settings !== prev.settings || s.launch?.phase !== prev.launch?.phase || s.focusGameId !== prev.focusGameId) sync();
  });
  document.addEventListener('visibilitychange', sync);
  addEventListener('focus', sync);
  addEventListener('blur', sync);
  sync();
}

const ambientOn = () => !!engine?.running;

/** Track T: duck (or restore) interface and ambient sounds while voice-over speaks. */
export function setSoundDuck(on: boolean) {
  duck = on ? DUCK_LEVEL : 1;
  engine?.setDuck(duck);
}

export const sound = {
  focus() {
    const now = performance.now();
    if (now - lastTick < 45) return; // throttle at fast repeat rates
    lastTick = now;
    if (ambientOn()) {
      // Read the position after this frame's focus change lands.
      requestAnimationFrame(() => {
        const p = focusPoint();
        engine?.focus(p.x, p.y);
      });
      return;
    }
    play([1320], 0.035, 0.05, 'triangle');
  },
  select() {
    if (ambientOn()) return engine!.select(focusPoint().x);
    play([660, 990], 0.07, 0.08);
  },
  /** Controller/arrow-key focus moves on desktop pages: heard only with ambient sound on. */
  spatialFocus() {
    if (ambientOn()) sound.focus();
  },
  /**
   * Track L: Immersive's spatial sounds. Panned to the travelling focus ring, pitched by row depth,
   * in the focused game's mood — with or without the ambient layer, whenever interface sounds are on.
   */
  spatial(kind: SpatialKind, mood: Mood, p: { x: number; width: number; depth: number; fromDepth?: number }) {
    const now = performance.now();
    if ((kind === 'focus' || kind === 'row') && now - lastSpatial < 45) return; // throttle at fast repeat rates
    lastSpatial = now;
    playSpatial(spatialSound(kind, mood, p));
  },
  back: () => play([740, 520], 0.06, 0.06),
  launch: () => play([392, 523, 784], 0.16, 0.08),
};
