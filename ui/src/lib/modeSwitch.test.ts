import { describe, expect, it } from 'vitest';
import {
  ENTRY_FOCUS_TTL_MS, IDLE, inputPolicy, setEntryFocus, SWITCH_TIMING, switchKind, switchReducer, takeEntryFocus, totalDuration, zoomFrom,
  type SwitchEvent, type SwitchState,
} from './modeSwitch';
import { couchSafe, couchScale, couchVars, formatSafe, formatScale, stepCouch } from './couch';
import { degreeFreq, depthDegree, MAX_DEPTH_STEPS, SPATIAL_GAIN_CAP, spatialSound } from './spatialSound';
import { MOOD_VOICES } from './ambient';

const base = { setting: true, reducedMotion: false, gameActive: false, hidden: false, safeMode: false };
const run = (events: SwitchEvent[], from: SwitchState = IDLE) => events.reduce(switchReducer, from);

describe('mode switch', () => {
  it('is cinematic by default, a crossfade under reduced motion/off/safe mode, instant during a game or when hidden', () => {
    expect(switchKind(base)).toBe('cinematic');
    expect(switchKind({ ...base, reducedMotion: true })).toBe('fade');
    expect(switchKind({ ...base, setting: false })).toBe('fade');
    expect(switchKind({ ...base, safeMode: true })).toBe('fade');
    expect(switchKind({ ...base, gameActive: true })).toBe('instant');
    expect(switchKind({ ...base, hidden: true, reducedMotion: true })).toBe('instant');
  });

  it('takes about 900 ms (plus the native resize), a crossfade about 300 ms', () => {
    expect(totalDuration('cinematic')).toBeGreaterThanOrEqual(800);
    expect(totalDuration('cinematic')).toBeLessThanOrEqual(950);
    expect(totalDuration('fade')).toBeLessThanOrEqual(320);
    expect(totalDuration('instant')).toBe(0);
    expect(SWITCH_TIMING.cinematic.settleMax).toBeLessThanOrEqual(400);
  });

  it('runs out → commit → settle → in → idle', () => {
    const steps: SwitchState[] = [];
    let s = IDLE;
    for (const e of [{ type: 'start', target: 'immersive' }, { type: 'outDone' }, { type: 'committed' }, { type: 'settled' }, { type: 'inDone' }] as SwitchEvent[]) {
      s = switchReducer(s, e);
      steps.push(s);
    }
    expect(steps.map((x) => x.phase)).toEqual(['out', 'commit', 'settle', 'in', 'idle']);
    expect(steps[0].target).toBe('immersive');
  });

  it('a skip before the commit still commits, then finishes without the rise-in; after it, it ends at once', () => {
    const skippedOut = run([{ type: 'start', target: 'desktop' }, { type: 'skip' }]);
    expect(skippedOut).toMatchObject({ phase: 'commit', skipped: true });
    expect(run([{ type: 'outDone' }, { type: 'committed' }, { type: 'settled' }], skippedOut).phase).toBe('idle');
    const settling = run([{ type: 'start', target: 'desktop' }, { type: 'outDone' }, { type: 'committed' }, { type: 'skip' }]);
    expect(settling).toMatchObject({ phase: 'settle', skipped: true });
    expect(switchReducer(settling, { type: 'settled' }).phase).toBe('idle');
    expect(run([{ type: 'start', target: 'desktop' }, { type: 'outDone' }, { type: 'committed' }, { type: 'settled' }, { type: 'skip' }]).phase).toBe('idle');
  });

  it('ignores events out of order and a second start (no stuck states)', () => {
    const s = run([{ type: 'start', target: 'immersive' }]);
    expect(switchReducer(s, { type: 'start', target: 'desktop' })).toBe(s);
    expect(switchReducer(s, { type: 'settled' })).toBe(s);
    expect(switchReducer(IDLE, { type: 'skip' })).toBe(IDLE);
    expect(switchReducer(IDLE, { type: 'inDone' })).toBe(IDLE);
  });

  it('swallows input before the commit and lets it through after', () => {
    expect(inputPolicy('idle')).toBe('none');
    expect(inputPolicy('out')).toBe('swallow');
    expect(inputPolicy('commit')).toBe('swallow');
    expect(inputPolicy('settle')).toBe('pass');
    expect(inputPolicy('in')).toBe('pass');
  });

  it('zooms from the card on screen with a uniform scale, or from a centred card', () => {
    const z = zoomFrom({ x: 100, y: 200, w: 300, h: 450 }, 1500, 900);
    expect(z.scale).toBeCloseTo(0.5);
    expect(z.x).toBe(250 - 750);
    expect(z.y).toBe(425 - 450);
    expect(zoomFrom(null, 1500, 900)).toEqual({ x: 0, y: 0, scale: 0.4 });
    expect(zoomFrom({ x: 0, y: 0, w: 1, h: 1 }, 1500, 900).scale).toBe(0.4);
    expect(zoomFrom({ x: 0, y: 0, w: 4000, h: 4000 }, 1500, 900).scale).toBe(0.9);
    expect(zoomFrom(null, 0, 0)).toEqual({ x: 0, y: 0, scale: 1 });
  });

  it('hands the zoomed-into game to Immersive for a few seconds only', () => {
    setEntryFocus('g1', 1000);
    expect(takeEntryFocus(1000 + ENTRY_FOCUS_TTL_MS - 1)).toBe('g1');
    expect(takeEntryFocus(1000 + ENTRY_FOCUS_TTL_MS + 1)).toBeNull();
    setEntryFocus(null);
    expect(takeEntryFocus()).toBeNull();
  });
});

describe('couch mode', () => {
  it('clamps scale and safe area, and steps them', () => {
    expect(couchScale(2)).toBe(1.3);
    expect(couchScale('x')).toBe(1);
    expect(couchScale(1.149)).toBe(1.15);
    expect(couchSafe(-1)).toBe(0);
    expect(couchSafe(0.2)).toBe(0.06);
    expect(stepCouch('scale', 1.3, 1)).toBe(1.3);
    expect(stepCouch('scale', 1, 1)).toBe(1.05);
    expect(stepCouch('safe', 0, 1)).toBe(0.01);
    expect(couchVars(1.1, 0.03)).toEqual({ '--couch-scale': '1.1', '--couch-safe': '0.03' });
    expect(formatScale(1.25)).toBe('125%');
    expect(formatSafe(0)).toBe('Off');
    expect(formatSafe(0.04)).toBe('4%');
  });
});

describe('spatial UI sounds', () => {
  it('pans with the ring position across the window', () => {
    expect(spatialSound('focus', 'drift', { x: 0, width: 1000, depth: 0 }).pan).toBeCloseTo(-0.8);
    expect(spatialSound('focus', 'drift', { x: 500, width: 1000, depth: 0 }).pan).toBeCloseTo(0);
    expect(spatialSound('focus', 'drift', { x: 1000, width: 1000, depth: 0 }).pan).toBeCloseTo(0.8);
    expect(spatialSound('focus', 'drift', { x: NaN, width: 1000, depth: 0 }).pan).toBe(0);
  });

  it('pitches one scale degree lower per row of depth, capped', () => {
    const f = (d: number) => spatialSound('focus', 'cosmos', { x: 0, width: 1, depth: d }).notes[0].freq;
    for (let d = 0; d < MAX_DEPTH_STEPS; d++) expect(f(d + 1)).toBeLessThan(f(d));
    expect(f(MAX_DEPTH_STEPS + 5)).toBe(f(MAX_DEPTH_STEPS));
    expect(depthDegree(-3)).toBe(depthDegree(0));
    // Negative degrees wrap into the octave below (never back up to the top of the scale).
    expect(degreeFreq('drift', -1)).toBeLessThan(degreeFreq('drift', 0));
  });

  it('follows the mood timbre and stays quiet', () => {
    for (const mood of Object.keys(MOOD_VOICES) as (keyof typeof MOOD_VOICES)[]) {
      const s = spatialSound('focus', mood, { x: 1, width: 2, depth: 1 });
      expect(s.wave).toBe(MOOD_VOICES[mood].wave);
      expect(s.cutoff).toBeGreaterThan(MOOD_VOICES[mood].cutoff);
      for (const kind of ['focus', 'row', 'edge', 'select'] as const)
        for (const n of spatialSound(kind, mood, { x: 1, width: 2, depth: 2, fromDepth: 1 }).notes) expect(n.gain).toBeLessThanOrEqual(SPATIAL_GAIN_CAP);
    }
    expect(spatialSound('focus', 'cosmos', { x: 1, width: 2, depth: 0 }).echo).toBeGreaterThan(0);
    expect(spatialSound('focus', 'velocity', { x: 1, width: 2, depth: 0 }).echo).toBe(0);
  });

  it('a row change steps from the old row pitch to the new one; an edge is a low bump', () => {
    const row = spatialSound('row', 'drift', { x: 1, width: 2, depth: 2, fromDepth: 1 });
    expect(row.notes).toHaveLength(2);
    expect(row.notes[1].freq).toBeLessThan(row.notes[0].freq);
    const edge = spatialSound('edge', 'drift', { x: 1, width: 2, depth: 0 });
    expect(edge.notes[0].freq).toBeLessThan(MOOD_VOICES.drift.root);
  });
});
