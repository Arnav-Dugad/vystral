import { describe, expect, it } from 'vitest';
import { liveTileBlock, MAX_PLAYING, pickPlaying, REST_MS, rotate, STINT_MS, type LiveConditions, type TileSnapshot } from './liveTiles';

const OK: LiveConditions = { setting: true, dataSaver: false, offline: false, reducedMotion: false, quality: 'balanced', gameActive: false, hidden: false, safeMode: false };

function tile(key: string, over: Partial<TileSnapshot> = {}): TileSnapshot {
  return { key, ratio: 1, hasVideo: true, hovered: false, order: Number(key.replace(/\D/g, '')) || 0, playingSince: null, restUntil: 0, lastPlayedAt: 0, ...over };
}

describe('live tile conditions', () => {
  it('animates only when nothing says otherwise', () => {
    expect(liveTileBlock(OK)).toBeNull();
    expect(liveTileBlock({ ...OK, setting: false })).toBe('off');
    expect(liveTileBlock({ ...OK, dataSaver: true })).toBe('dataSaver');
    expect(liveTileBlock({ ...OK, offline: true })).toBe('offline');
    expect(liveTileBlock({ ...OK, gameActive: true })).toBe('gameActive');
    expect(liveTileBlock({ ...OK, hidden: true })).toBe('hidden');
    expect(liveTileBlock({ ...OK, reducedMotion: true })).toBe('reducedMotion');
    expect(liveTileBlock({ ...OK, quality: 'low' })).toBe('lowQuality');
    expect(liveTileBlock({ ...OK, safeMode: true })).toBe('safeMode');
  });
});

describe('which tiles play', () => {
  it('plays at most two, in reading order, and only tiles at least half on screen with a video', () => {
    const tiles = [tile('t3'), tile('t1'), tile('t2'), tile('t0', { ratio: 0.4 }), tile('t4', { hasVideo: false })];
    expect(pickPlaying(tiles, 0)).toEqual(['t1', 't2']);
    expect(MAX_PLAYING).toBe(2);
  });

  it('gives a hovered tile a slot immediately', () => {
    const tiles = [tile('t1', { playingSince: 0 }), tile('t2', { playingSince: 0 }), tile('t9', { hovered: true })];
    expect(pickPlaying(tiles, 10)).toEqual(['t9', 't1']);
  });

  it('keeps what is already playing instead of flickering to a new tile', () => {
    const tiles = [tile('t1'), tile('t2'), tile('t3', { playingSince: 5 }), tile('t4', { playingSince: 5 })];
    expect(pickPlaying(tiles, 10)).toEqual(['t3', 't4']);
  });

  it('skips resting tiles and prefers the least recently played', () => {
    const tiles = [tile('t1', { restUntil: 1000 }), tile('t2', { lastPlayedAt: 500 }), tile('t3', { lastPlayedAt: 100 }), tile('t4')];
    expect(pickPlaying(tiles, 900)).toEqual(['t4', 't3']);
    // A hovered tile plays even while resting.
    expect(pickPlaying([tile('t1', { restUntil: 1000, hovered: true })], 900)).toEqual(['t1']);
  });

  it('nothing plays when nothing is eligible', () => {
    expect(pickPlaying([tile('t1', { ratio: 0 }), tile('t2', { hasVideo: false })], 0)).toEqual([]);
  });
});

describe('taking turns', () => {
  it('ends a long stint when another tile is waiting, and lets it rest', () => {
    const now = STINT_MS + 1;
    const out = rotate([tile('t1', { playingSince: 0 }), tile('t2')], now);
    expect(out[0]).toMatchObject({ playingSince: null, lastPlayedAt: now, restUntil: now + REST_MS });
    expect(pickPlaying(out, now)).toEqual(['t2']);
  });

  it('keeps playing when nobody is waiting, or while hovered', () => {
    const lonely = [tile('t1', { playingSince: 0 })];
    expect(rotate(lonely, STINT_MS * 3)[0].playingSince).toBe(0);
    const hovered = [tile('t1', { playingSince: 0, hovered: true }), tile('t2')];
    expect(rotate(hovered, STINT_MS * 3)[0].playingSince).toBe(0);
  });

  it('does not mutate its input', () => {
    const input = [tile('t1', { playingSince: 0 }), tile('t2')];
    rotate(input, STINT_MS + 1);
    expect(input[0].playingSince).toBe(0);
  });
});
