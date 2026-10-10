import { describe, expect, it } from 'vitest';
import type { LibraryTag } from '../bridge/types';
import {
  compact, extractTags, hasAllTags, priceChart, pricePosition, ratingRows, releaseAge, reviewTone, timelineYears, trendText, weeklyPlay,
} from './gamePage';

describe('review snapshot', () => {
  it('uses Steam’s colour bands', () => {
    expect(reviewTone(98)).toBe('ok');
    expect(reviewTone(70)).toBe('ok');
    expect(reviewTone(69.9)).toBe('warn');
    expect(reviewTone(40)).toBe('warn');
    expect(reviewTone(12)).toBe('danger');
    expect(reviewTone(null)).toBeNull();
  });

  it('says how the last 30 days compare', () => {
    expect(trendText({ trend: 'up', trendPoints: 5 })).toBe('Up 5 points in the last 30 days');
    expect(trendText({ trend: 'down', trendPoints: -1 })).toBe('Down 1 point in the last 30 days');
    expect(trendText({ trend: 'down', trendPoints: -3.46 })).toBe('Down 3.5 points in the last 30 days');
    expect(trendText({ trend: 'steady', trendPoints: 0.4 })).toBe('Steady in the last 30 days');
    expect(trendText({ trend: null, trendPoints: null })).toBeNull();
  });

  it('compacts big counts', () => {
    expect(compact(950)).toBe('950');
    expect(compact(2239)).toBe('2.2K');
    expect(compact(468106)).toBe('468K');
    expect(compact(1_250_000)).toBe('1.3M');
  });
});

describe('sessions sparkline', () => {
  const now = new Date(2026, 2, 11, 12).getTime(); // Wednesday 11 Mar 2026
  it('buckets play time by week, this week last', () => {
    const weeks = weeklyPlay([
      { start: new Date(2026, 2, 9, 20).toISOString(), durationSeconds: 3600 }, // Monday this week
      { start: new Date(2026, 2, 10, 20).toISOString(), durationSeconds: 1800 },
      { start: new Date(2026, 2, 4, 20).toISOString(), durationSeconds: 600 }, // last week
      { start: new Date(2025, 0, 1).toISOString(), durationSeconds: 99999 }, // too old
      { start: 'nonsense', durationSeconds: 5 },
    ], 12, now);
    expect(weeks).toHaveLength(12);
    expect(weeks[11]).toMatchObject({ start: '2026-03-09', seconds: 5400, sessions: 2 });
    expect(weeks[10]).toMatchObject({ start: '2026-03-02', seconds: 600, sessions: 1 });
    expect(weeks.slice(0, 10).every((w) => w.seconds === 0)).toBe(true);
  });
});

describe('price', () => {
  it('places today’s price between the lowest ever and the regular price', () => {
    expect(pricePosition(1000, 500, 2000)).toBeCloseTo(1 / 3);
    expect(pricePosition(400, 500, 2000)).toBe(0); // below the recorded low: clamped
    expect(pricePosition(1000, 2000, 2000)).toBeNull();
    expect(pricePosition(null, 500, 2000)).toBeNull();
  });

  it('draws a step line over real time and needs two points', () => {
    const today = Date.UTC(2026, 2, 10);
    expect(priceChart([{ day: '2026-03-01', cents: 999 }], 200, 60, null, today)).toBeNull();
    const c = priceChart([{ day: '2026-03-01', cents: 1999 }, { day: '2026-03-05', cents: 999 }], 200, 60, 499, today)!;
    expect(c.points).toHaveLength(2);
    expect(c.points[0].x).toBe(0);
    expect(c.line.endsWith('H200')).toBe(true); // runs on to today
    expect(c.lowY).toBeGreaterThan(c.points[1].y); // the lowest ever sits below today's price
    expect(c.ticks.map((t) => t.cents)).toEqual([1999, 499]);
    expect(c.days).toBe(9);
  });
});

describe('ratings', () => {
  it('puts every score on one 0–100 scale with its source, and never invents one', () => {
    const rows = ratingRows({ igdbCritics: 88.4, igdbCriticsCount: 12, rawgUsers: 4.2, rawgUsersCount: 900, metacritic: 95, steamPercent: 98.7, steamTotal: 468106 });
    expect(rows.map((r) => [r.key, r.value, r.display])).toEqual([
      ['critics', 88.4, '88'], ['users', 84, '4.2/5'], ['metacritic', 95, '95'], ['steam', 98.7, '99%'],
    ]);
    expect(ratingRows({ igdbTotal: 75 }).map((r) => r.label)).toEqual(['Overall']);
    expect(ratingRows({ metacritic: 0, igdbCritics: 140, rawgUsers: 9 })).toEqual([]);
  });
});

describe('release age', () => {
  const now = new Date(2026, 9, 10);
  it('reads full dates, months and years', () => {
    expect(releaseAge('2011-04-18', now)).toBe('15 years ago');
    expect(releaseAge('2026-03-01', now)).toBe('7 months ago');
    expect(releaseAge('2026', now)).toBe('this year');
    expect(releaseAge('2027-06-01', now)).toBe('in 8 months');
    expect(releaseAge('garbage', now)).toBeNull();
    expect(releaseAge(null, now)).toBeNull();
  });
});

describe('franchise timeline', () => {
  it('folds long gaps and puts unannounced dates last', () => {
    expect(timelineYears([2007, 2011, 2011, 2012, null])).toEqual([2007, 'gap', 2011, 2012, 'tba']);
    expect(timelineYears([2020, 2022])).toEqual([2020, 2022]);
  });
});

describe('community tags as filters', () => {
  const tags: LibraryTag[] = [
    { id: 1, name: 'Roguelike', count: 4 }, { id: 2, name: 'Co-op', count: 9 }, { id: 3, name: 'Open World', count: 6 },
    { id: 4, name: 'Open World Survival Craft', count: 2 }, { id: 5, name: 'Souls-like', count: 1 },
  ];

  it('matches games with every selected tag', () => {
    const games = { a: [1, 2], b: [2] };
    expect(hasAllTags('a', [1, 2], games)).toBe(true);
    expect(hasAllTags('b', [1, 2], games)).toBe(false);
    expect(hasAllTags('c', [2], games)).toBe(false);
    expect(hasAllTags('c', [], games)).toBe(true);
  });

  it('understands “tagged …”, “#…” and “tag:…” and leaves the rest of the filter', () => {
    expect(extractTags('steam tagged roguelike under 10 gb', tags)).toEqual({ text: 'steam under 10 gb', ids: [1], names: ['Roguelike'] });
    expect(extractTags('#co-op racing', tags)).toEqual({ text: 'racing', ids: [2], names: ['Co-op'] });
    expect(extractTags('tag:"open world" installed', tags)).toEqual({ text: 'installed', ids: [3], names: ['Open World'] });
    expect(extractTags('with tag open world survival craft', tags).ids).toEqual([4]); // the longest name wins
    expect(extractTags('#souls-like', tags).ids).toEqual([5]);
  });

  it('ignores names that aren’t tags in the library', () => {
    expect(extractTags('#nonsense tagged unknown thing', tags)).toEqual({ text: '#nonsense tagged unknown thing', ids: [], names: [] });
    expect(extractTags('tagged roguelike', [])).toEqual({ text: 'tagged roguelike', ids: [], names: [] });
  });
});
