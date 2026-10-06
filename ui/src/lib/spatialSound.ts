/**
 * Spatial UI sounds for Immersive Mode (Track L). Pure: what to play for a focus move, a row
 * change, an edge bump or a selection — the engine in lib/sound.ts only plays what this returns.
 *
 * - **Pan** follows the travelling focus ring's centre across the screen (−0.8 left … 0.8 right).
 * - **Pitch** sits in the focused game's mood scale (lib/ambient.ts) and steps down one scale
 *   degree per row of depth (capped), so moving down the rows sounds subtly lower.
 * - **Timbre** follows the mood: its waveform, a brighter version of its low-pass, and a soft
 *   echo for the spacious moods.
 * Heard only with interface sounds on; never while a game starts or runs (checked by the player).
 */
import { MOOD_VOICES, panFor } from './ambient';
import type { Mood } from './mood';

export type SpatialKind = 'focus' | 'row' | 'edge' | 'select';

export interface SpatialNote {
  freq: number;
  /** Seconds after the first note. */
  at: number;
  dur: number;
  gain: number;
}

export interface SpatialSound {
  pan: number;
  wave: OscillatorType;
  /** Low-pass cutoff in Hz. */
  cutoff: number;
  /** Gain of a single 110 ms echo (0 = none). */
  echo: number;
  notes: SpatialNote[];
}

/** Rows deeper than this all sound the same. */
export const MAX_DEPTH_STEPS = 4;
/** Peak gain of any note before the user's volume. Kept well under the plain UI clicks. */
export const SPATIAL_GAIN_CAP = 0.11;

/** Frequency of scale degree `degree` (may be negative or past the top) above the mood's root, `octave` octaves up. */
export function degreeFreq(mood: Mood, degree: number, octave = 1): number {
  const v = MOOD_VOICES[mood];
  const n = v.scale.length;
  const oct = Math.floor(degree / n);
  const idx = degree - oct * n;
  return v.root * 2 ** ((v.scale[idx] + 12 * (octave + oct)) / 12);
}

/** The scale degree a focus move lands on at a given row depth (0 = top row): one step lower per row, capped. */
export function depthDegree(depth: number): number {
  const d = Number.isFinite(depth) ? Math.max(0, Math.min(MAX_DEPTH_STEPS, Math.floor(depth))) : 0;
  return 3 - d;
}

export function spatialSound(kind: SpatialKind, mood: Mood, p: { x: number; width: number; depth: number; fromDepth?: number }): SpatialSound {
  const voice = MOOD_VOICES[mood];
  const pan = panFor(p.x, p.width);
  const cutoff = Math.min(6000, voice.cutoff * 1.8);
  const echo = voice.reverb >= 3 ? Math.min(0.3, voice.wet * 0.45) : 0;
  const degree = depthDegree(p.depth);
  switch (kind) {
    case 'focus':
      return { pan, wave: voice.wave, cutoff, echo, notes: [{ freq: degreeFreq(mood, degree), at: 0, dur: 0.16, gain: SPATIAL_GAIN_CAP * 0.62 }] };
    case 'row': {
      // A two-note step from the row you left to the row you arrived at.
      const from = depthDegree(p.fromDepth ?? p.depth);
      return {
        pan,
        wave: voice.wave,
        cutoff,
        echo,
        notes: [
          { freq: degreeFreq(mood, from), at: 0, dur: 0.12, gain: SPATIAL_GAIN_CAP * 0.42 },
          { freq: degreeFreq(mood, degree), at: 0.055, dur: 0.2, gain: SPATIAL_GAIN_CAP * 0.66 },
        ],
      };
    }
    case 'edge':
      // A soft, low bump: the root an octave down, dark and short.
      return { pan, wave: 'sine', cutoff: Math.min(cutoff, 700), echo: 0, notes: [{ freq: degreeFreq(mood, 0, -1), at: 0, dur: 0.14, gain: SPATIAL_GAIN_CAP * 0.8 }] };
    case 'select':
      return {
        pan,
        wave: voice.wave,
        cutoff,
        echo,
        notes: [
          { freq: degreeFreq(mood, 0, 1), at: 0, dur: 0.24, gain: SPATIAL_GAIN_CAP * 0.7 },
          { freq: degreeFreq(mood, 0, 1) * 1.5, at: 0.06, dur: 0.3, gain: SPATIAL_GAIN_CAP * 0.55 },
        ],
      };
  }
}
