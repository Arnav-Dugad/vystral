/**
 * Ambient sound design: a soft, procedurally generated bed and spatial focus sounds that follow
 * the focused game's Living Canvas mood. No audio files — oscillators, filtered noise and a
 * synthesized reverb. The pure parts (voices, note scheduling, panning) are unit-tested; the
 * engine at the bottom only plays what they return.
 *
 * Off by default (`sound.ambient`), and only ever audible when UI sounds are on, the window is
 * visible and focused, and no game is starting or running. When silent the AudioContext is
 * suspended, so it costs nothing.
 */
import type { Mood } from './mood';

export interface MoodVoice {
  /** Root frequency in Hz. */
  root: number;
  /** Scale degrees in semitones above the root. */
  scale: number[];
  wave: OscillatorType;
  /** Low-pass cutoff (Hz) for everything in this mood. */
  cutoff: number;
  /** Noise bed level (0 = none) and its own low-pass cutoff. */
  noise: number;
  noiseCutoff: number;
  /** Reverb tail (seconds) and wet mix. */
  reverb: number;
  wet: number;
  /** Bed notes per minute. */
  density: number;
  /** Note length range (seconds). */
  length: [number, number];
}

export const MOOD_VOICES: Record<Mood, MoodVoice> = {
  // Slow flowing light: warm major pentatonic, sine, open space.
  drift: { root: 220, scale: [0, 2, 4, 7, 9], wave: 'sine', cutoff: 1800, noise: 0, noiseCutoff: 600, reverb: 3, wet: 0.45, density: 6, length: [3.5, 6] },
  // Light trails: brighter minor pentatonic, triangle, shorter notes, a little more movement.
  velocity: { root: 246.94, scale: [0, 3, 5, 7, 10], wave: 'triangle', cutoff: 3000, noise: 0.012, noiseCutoff: 2400, reverb: 1.8, wet: 0.3, density: 10, length: [1.2, 2.6] },
  // Distant stars: lydian shimmer, long tails.
  cosmos: { root: 174.61, scale: [0, 2, 4, 6, 7, 11], wave: 'sine', cutoff: 2600, noise: 0.006, noiseCutoff: 5000, reverb: 5.2, wet: 0.62, density: 5, length: [4, 7] },
  // Rising motes: dorian, warm triangle, faint crackle.
  ember: { root: 196, scale: [0, 2, 3, 7, 9], wave: 'triangle', cutoff: 1400, noise: 0.018, noiseCutoff: 3200, reverb: 2.6, wet: 0.4, density: 6, length: [2.5, 5] },
  // Low fog: sparse, dark, a semitone and a tritone, rumble underneath.
  dread: { root: 110, scale: [0, 1, 6, 7], wave: 'sine', cutoff: 650, noise: 0.03, noiseCutoff: 260, reverb: 4.6, wet: 0.55, density: 3, length: [5, 9] },
  // Calm waves: gentle major, surf-like noise.
  tide: { root: 261.63, scale: [0, 2, 4, 7, 9], wave: 'sine', cutoff: 1500, noise: 0.024, noiseCutoff: 900, reverb: 3.4, wet: 0.5, density: 5, length: [3, 5.5] },
};

export interface NoteEvent {
  /** Seconds from the start of the schedule. */
  t: number;
  freq: number;
  dur: number;
  gain: number;
  /** -1 (left) … 1 (right). */
  pan: number;
}

/** Peak gain of any single bed note before the master volume (keeps the bed far below UI sounds). */
export const NOTE_GAIN_CAP = 0.09;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

export const freqOf = (voice: MoodVoice, degree: number, octave = 0) =>
  voice.root * 2 ** ((voice.scale[((degree % voice.scale.length) + voice.scale.length) % voice.scale.length] + 12 * octave) / 12);

/**
 * Deterministic bed notes for one mood between `from` and `to` seconds. Notes are spaced by the
 * mood's density (with ±35% jitter, never closer than 1.2 s), walk the scale by small steps so it
 * sounds like a slow melody rather than random beeps, sit in two octaves, and drift across the
 * stereo field. The same seed and window always give the same notes.
 */
export function scheduleBed(mood: Mood, seed: number, from: number, to: number): NoteEvent[] {
  const voice = MOOD_VOICES[mood];
  const spacing = 60 / voice.density;
  const r = rng(seed ^ (Math.floor(from / spacing) * 2654435761));
  const out: NoteEvent[] = [];
  // Start on the next slot boundary so consecutive windows tile without gaps or overlaps.
  let t = Math.ceil(from / spacing) * spacing;
  let degree = Math.floor(r() * voice.scale.length);
  while (t < to) {
    const jitter = (r() - 0.5) * 0.7 * spacing;
    const at = Math.max(from, t + jitter);
    if (at < to) {
      degree += [-2, -1, 1, 1, 2][Math.floor(r() * 5)];
      const octave = degree < 0 ? -1 : degree >= voice.scale.length ? 1 : 0;
      const [lo, hi] = voice.length;
      out.push({
        t: at,
        freq: freqOf(voice, degree, Math.max(-1, Math.min(0, octave))),
        dur: lo + r() * (hi - lo),
        gain: NOTE_GAIN_CAP * (0.45 + r() * 0.55),
        pan: Math.sin(at * 0.21 + seed) * 0.6,
      });
      degree = ((degree % voice.scale.length) + voice.scale.length) % voice.scale.length;
    }
    t += Math.max(1.2, spacing);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Stereo position for something at horizontal pixel `x` in a window `width` wide (−0.8 … 0.8). */
export function panFor(x: number, width: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(width) || width <= 0) return 0;
  return Math.max(-0.8, Math.min(0.8, (x / width) * 1.6 - 0.8));
}

/** The pitch of a focus move: higher on the screen sounds a scale step higher. */
export function focusPitch(mood: Mood, y: number, height: number): number {
  const voice = MOOD_VOICES[mood];
  const steps = voice.scale.length;
  const rel = height > 0 ? 1 - Math.max(0, Math.min(1, y / height)) : 0.5;
  return freqOf(voice, Math.round(rel * (steps - 1)), 1);
}

/** When the ambient layer may be audible. */
export interface AmbientConditions {
  ambient: boolean;
  uiSounds: boolean;
  gameActive: boolean;
  hidden: boolean;
  focused: boolean;
}

export function ambientAllowed(c: AmbientConditions): boolean {
  return c.ambient && c.uiSounds && !c.gameActive && !c.hidden && c.focused;
}

/* --------------------------------------------------------------------- engine */

/** One stereo impulse response of decaying noise: a cheap, convincing room. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const r = rng(0x5eed);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (r() * 2 - 1) * (1 - i / length) ** 2.6;
  }
  return buffer;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const length = ctx.sampleRate * 2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const r = rng(0xbed);
  let last = 0;
  for (let i = 0; i < length; i++) {
    last = last * 0.97 + (r() * 2 - 1) * 0.03; // brown-ish: softer than white noise
    data[i] = last * 6;
  }
  return buffer;
}

const LOOKAHEAD = 6; // seconds of bed scheduled ahead
const TICK_MS = 2000;

/**
 * The Web Audio graph: notes → mood low-pass → (dry + reverb) → master. The noise bed has its own
 * low-pass. Mood changes glide over ~2 s; starting and stopping fade over ~1.2 s, then the context
 * is suspended.
 */
export class AmbientEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private filter!: BiquadFilterNode;
  private dry!: GainNode;
  private wet!: GainNode;
  private reverb!: ConvolverNode;
  private noiseGain!: GainNode;
  private noiseFilter!: BiquadFilterNode;
  private timer: number | undefined;
  private scheduledTo = 0;
  private origin = 0;
  private reverbFor: number | null = null;
  private active = false;
  mood: Mood = 'drift';
  volume = 0.35;
  private readonly seed = Math.floor(Math.random() * 1e9);

  static supported(): boolean {
    return typeof AudioContext !== 'undefined';
  }

  private ensure(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.reverb = ctx.createConvolver();
    this.filter.connect(this.dry).connect(this.master);
    this.filter.connect(this.reverb).connect(this.wet).connect(this.master);
    this.master.connect(ctx.destination);
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer(ctx);
    noise.loop = true;
    this.noiseFilter = ctx.createBiquadFilter();
    this.noiseFilter.type = 'lowpass';
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = 0;
    noise.connect(this.noiseFilter).connect(this.noiseGain).connect(this.dry);
    noise.start();
    this.ctx = ctx;
    this.origin = ctx.currentTime;
    this.applyMood(0);
    return ctx;
  }

  /** Master level: the bed is deliberately quiet, a fraction of the UI sound level. */
  private level() {
    return Math.max(0, Math.min(1, this.volume)) * 0.5;
  }

  private applyMood(glide: number) {
    if (!this.ctx) return;
    const v = MOOD_VOICES[this.mood];
    const t = this.ctx.currentTime;
    const tc = Math.max(0.01, glide / 3);
    this.filter.frequency.setTargetAtTime(v.cutoff, t, tc);
    this.noiseFilter.frequency.setTargetAtTime(v.noiseCutoff, t, tc);
    this.noiseGain.gain.setTargetAtTime(v.noise, t, tc);
    this.dry.gain.setTargetAtTime(1 - v.wet * 0.6, t, tc);
    this.wet.gain.setTargetAtTime(v.wet, t, tc);
    if (this.reverbFor !== v.reverb) {
      this.reverb.buffer = impulse(this.ctx, v.reverb);
      this.reverbFor = v.reverb;
    }
  }

  setMood(mood: Mood) {
    if (mood === this.mood) return;
    this.mood = mood;
    this.applyMood(2);
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.ctx && this.active) this.master.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.2);
  }

  start() {
    if (!AmbientEngine.supported() || this.active) return;
    const ctx = this.ensure();
    this.active = true;
    void ctx.resume();
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(this.level(), ctx.currentTime, 0.4);
    this.scheduledTo = Math.max(this.scheduledTo, ctx.currentTime - this.origin);
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (!this.ctx || !this.active) return;
    this.active = false;
    window.clearInterval(this.timer);
    const ctx = this.ctx;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setTargetAtTime(0, ctx.currentTime, 0.35);
    window.setTimeout(() => {
      if (!this.active) void ctx.suspend();
    }, 1400);
  }

  get running() {
    return this.active;
  }

  private tick() {
    if (!this.ctx || !this.active) return;
    const now = this.ctx.currentTime - this.origin;
    if (this.scheduledTo < now) this.scheduledTo = now;
    const until = now + LOOKAHEAD;
    for (const n of scheduleBed(this.mood, this.seed, this.scheduledTo, until)) this.note(n.t + this.origin, n.freq, n.dur, n.gain, n.pan);
    this.scheduledTo = until;
  }

  private note(at: number, freq: number, dur: number, gain: number, pan: number, attack = 0.9) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    const panner = ctx.createStereoPanner();
    osc.type = MOOD_VOICES[this.mood].wave;
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() - 0.5) * 8;
    panner.pan.value = pan;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + Math.min(attack, dur / 2));
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(env).connect(panner).connect(this.filter);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  /** A focus move: a short tone in the mood's scale, placed where the focus landed. */
  focus(x: number, y: number) {
    if (!this.ctx || !this.active) return;
    const w = typeof innerWidth === 'number' ? innerWidth : 1;
    const h = typeof innerHeight === 'number' ? innerHeight : 1;
    this.note(this.ctx.currentTime + 0.005, focusPitch(this.mood, y, h), 0.32, 0.12, panFor(x, w), 0.008);
  }

  /** A selection: two notes a fifth apart, centred on the element. */
  select(x: number) {
    if (!this.ctx || !this.active) return;
    const v = MOOD_VOICES[this.mood];
    const t = this.ctx.currentTime + 0.005;
    const pan = panFor(x, typeof innerWidth === 'number' ? innerWidth : 1);
    this.note(t, freqOf(v, 0, 1), 0.45, 0.11, pan, 0.008);
    this.note(t + 0.07, freqOf(v, 0, 1) * 1.5, 0.5, 0.09, pan, 0.008);
  }
}
