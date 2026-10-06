import { beforeEach, describe, expect, it } from 'vitest';
import { bestTier, FIRST_VISIT_WINDOW, isFresh, MAX_FRESH_AGE, shimmerTier, takeLastSeen } from './shimmer';
import { glyphStroke, markViewBox, opticalSize, platformFromName, STORE_MARKS } from './storeMarks';

const NOW = Date.parse('2026-10-05T12:00:00Z');

describe('shimmer tiers', () => {
  it('tints by Steam rarity: silver, gold at ≤5%, prismatic at ≤1%', () => {
    expect(shimmerTier(40)).toBe('common');
    expect(shimmerTier(null)).toBe('common');
    expect(shimmerTier(5)).toBe('rare');
    expect(shimmerTier(1)).toBe('ultra');
    expect(shimmerTier(0.2)).toBe('ultra');
  });

  it('takes the rarest of several unlocks', () => {
    expect(bestTier(['common', 'rare'])).toBe('rare');
    expect(bestTier(['rare', 'ultra', 'common'])).toBe('ultra');
    expect(bestTier([])).toBe('common');
    expect(bestTier([null, undefined])).toBe('common');
  });
});

describe('fresh unlocks', () => {
  beforeEach(() => localStorage.clear());

  it('counts unlocks after the last visit and within two weeks', () => {
    const since = NOW - 3_600_000;
    expect(isFresh(new Date(NOW - 60_000).toISOString(), since, NOW)).toBe(true);
    expect(isFresh(new Date(NOW - 7_200_000).toISOString(), since, NOW)).toBe(false);
    expect(isFresh(new Date(NOW - MAX_FRESH_AGE - 1).toISOString(), 0, NOW)).toBe(false);
    expect(isFresh(null, 0, NOW)).toBe(false);
    expect(isFresh('not a date', 0, NOW)).toBe(false);
  });

  it('remembers visits per surface; a first visit looks back one day', () => {
    expect(takeLastSeen('timeline', NOW)).toBe(NOW - FIRST_VISIT_WINDOW);
    expect(takeLastSeen('timeline', NOW + 5000)).toBe(NOW);
    expect(takeLastSeen('game:abc', NOW + 6000)).toBe(NOW + 6000 - FIRST_VISIT_WINDOW);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('vystral.achievements.lastSeen.v1', '{nope');
    expect(takeLastSeen('timeline', NOW)).toBe(NOW - FIRST_VISIT_WINDOW);
  });
});

describe('store marks', () => {
  it('has a mark for every store: licensed brand marks, and a plain glyph for games you added', () => {
    expect(STORE_MARKS.steam.kind).toBe('brand');
    expect(STORE_MARKS.epic.kind).toBe('brand');
    expect(STORE_MARKS.gog.kind).toBe('brand');
    expect(STORE_MARKS.ea.kind).toBe('brand');
    expect(STORE_MARKS.ubisoft.kind).toBe('brand');
    expect(STORE_MARKS.battlenet.kind).toBe('brand');
    expect(STORE_MARKS.xbox.kind).toBe('brand');
    expect(STORE_MARKS.manual.kind).toBe('glyph');
    for (const m of Object.values(STORE_MARKS)) if (m.kind === 'brand') expect(m.path).toMatch(/^M[\d.\-\s,a-zA-Z]+$/);
  });

  it('snaps to the four optical sizes and insets square marks a little', () => {
    expect(opticalSize(13)).toBe(14);
    expect(opticalSize(17)).toBe(16);
    expect(opticalSize(19)).toBe(20);
    expect(opticalSize(40)).toBe(24);
    expect(markViewBox(STORE_MARKS.steam, 24)).toBe('-0.9 -0.9 25.8 25.8');
    expect(markViewBox(STORE_MARKS.steam, 14)).toBe('-0.45 -0.45 24.9 24.9');
    expect(markViewBox(STORE_MARKS.xbox, 16)).toBe('-0.9 -0.9 25.8 25.8');
    expect(markViewBox(STORE_MARKS.manual, 16)).toBe('0 0 24 24');
    expect(glyphStroke(14)).toBeGreaterThan(glyphStroke(24));
  });

  it('maps search chip names back to stores', () => {
    expect(platformFromName('Steam')).toBe('steam');
    expect(platformFromName('epic games')).toBe('epic');
    expect(platformFromName('Racing')).toBeNull();
  });
});
