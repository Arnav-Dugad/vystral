import { useStore } from '../state/store';
import { AmbientEngine, ambientAllowed } from './ambient';
import { moodFor } from './mood';

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

function play(freqs: number[], duration: number, gain: number, type: OscillatorType = 'sine') {
  const s = useStore.getState();
  if (!s.settings?.['sounds.enabled'] || s.launch?.phase === 'running') return;
  ctx ??= new AudioContext();
  const volume = (s.settings['sounds.volume'] ?? 0.4) * gain;
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

/* ------------------------------------------------------------------ ambient */

let engine: AmbientEngine | null = null;
let watching = false;

/** Where the focus is now (keyboard/controller focus, else the Immersive highlight), in viewport pixels. */
function focusPoint(): { x: number; y: number } {
  const el = (document.activeElement && document.activeElement !== document.body ? document.activeElement : document.querySelector('[data-focused]')) as HTMLElement | null;
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
  back: () => play([740, 520], 0.06, 0.06),
  launch: () => play([392, 523, 784], 0.16, 0.08),
};
