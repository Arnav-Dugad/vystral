import { describe, expect, it } from 'vitest';
import { ambientAllowed, focusPitch, freqOf, MOOD_VOICES, NOTE_GAIN_CAP, panFor, scheduleBed } from './ambient';
import type { Mood } from './mood';

const MOODS = Object.keys(MOOD_VOICES) as Mood[];
const inScale = (mood: Mood, f: number) => {
  const v = MOOD_VOICES[mood];
  const semis = 12 * Math.log2(f / v.root);
  const rel = ((Math.round(semis) % 12) + 12) % 12;
  return Math.abs(semis - Math.round(semis)) < 1e-6 && v.scale.includes(rel);
};

describe('ambient bed scheduling', () => {
  it('is deterministic for a seed and window', () => {
    expect(scheduleBed('cosmos', 42, 0, 30)).toEqual(scheduleBed('cosmos', 42, 0, 30));
    expect(scheduleBed('cosmos', 42, 0, 30)).not.toEqual(scheduleBed('cosmos', 43, 0, 30));
  });

  it('only plays notes from the mood’s scale, sorted, inside the window, quiet and panned within range', () => {
    for (const mood of MOODS) {
      const notes = scheduleBed(mood, 7, 12, 72);
      expect(notes.length).toBeGreaterThan(0);
      for (let i = 0; i < notes.length; i++) {
        const n = notes[i];
        expect(n.t).toBeGreaterThanOrEqual(12);
        expect(n.t).toBeLessThan(72);
        if (i) expect(n.t).toBeGreaterThanOrEqual(notes[i - 1].t);
        expect(inScale(mood, n.freq)).toBe(true);
        expect(n.gain).toBeLessThanOrEqual(NOTE_GAIN_CAP);
        expect(n.gain).toBeGreaterThan(0);
        expect(Math.abs(n.pan)).toBeLessThanOrEqual(0.6);
        const [lo, hi] = MOOD_VOICES[mood].length;
        expect(n.dur).toBeGreaterThanOrEqual(lo);
        expect(n.dur).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('follows each mood’s density: dread is sparse, velocity busy', () => {
    const count = (m: Mood) => scheduleBed(m, 3, 0, 600).length;
    expect(count('dread')).toBeLessThan(count('drift'));
    expect(count('velocity')).toBeGreaterThan(count('drift'));
    expect(Math.abs(count('velocity') - 100)).toBeLessThan(15); // 10 a minute for 10 minutes
  });

  it('leaves breathing room between notes', () => {
    for (const mood of MOODS) {
      const spacing = 60 / MOOD_VOICES[mood].density;
      const notes = scheduleBed(mood, 11, 0, 300);
      for (let i = 1; i < notes.length; i++) expect(notes[i].t - notes[i - 1].t).toBeGreaterThanOrEqual(spacing * 0.29);
    }
  });

  it('dread sits lowest and darkest', () => {
    expect(MOOD_VOICES.dread.root).toBeLessThan(Math.min(...MOODS.filter((m) => m !== 'dread').map((m) => MOOD_VOICES[m].root)));
    expect(MOOD_VOICES.dread.cutoff).toBeLessThan(Math.min(...MOODS.filter((m) => m !== 'dread').map((m) => MOOD_VOICES[m].cutoff)));
  });
});

describe('spatial focus sounds', () => {
  it('pans by horizontal position', () => {
    expect(panFor(0, 1000)).toBeCloseTo(-0.8);
    expect(panFor(500, 1000)).toBeCloseTo(0);
    expect(panFor(1000, 1000)).toBeCloseTo(0.8);
    expect(panFor(5000, 1000)).toBeCloseTo(0.8);
    expect(panFor(Number.NaN, 1000)).toBe(0);
    expect(panFor(10, 0)).toBe(0);
  });

  it('pitches higher for focus near the top of the screen, always in scale', () => {
    const top = focusPitch('tide', 0, 1000);
    const bottom = focusPitch('tide', 1000, 1000);
    expect(top).toBeGreaterThan(bottom);
    expect(inScale('tide', top)).toBe(true);
    expect(freqOf(MOOD_VOICES.drift, 0, 1)).toBeCloseTo(440);
  });
});

describe('when ambient sound may play', () => {
  const base = { ambient: true, uiSounds: true, gameActive: false, hidden: false, focused: true };
  it('needs ambient and UI sounds on, a visible focused window and no game', () => {
    expect(ambientAllowed(base)).toBe(true);
    expect(ambientAllowed({ ...base, ambient: false })).toBe(false);
    expect(ambientAllowed({ ...base, uiSounds: false })).toBe(false);
    expect(ambientAllowed({ ...base, gameActive: true })).toBe(false);
    expect(ambientAllowed({ ...base, hidden: true })).toBe(false);
    expect(ambientAllowed({ ...base, focused: false })).toBe(false);
  });
});
