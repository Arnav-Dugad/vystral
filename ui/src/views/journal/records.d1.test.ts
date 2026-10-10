import { describe, expect, it } from 'vitest';
import type { Session, TimeToBeat } from '../../bridge/types';
import { CENTURY_HOURS, computeRecords, perfOf, RECORD_IDS, recordsBrokenBy, releaseYear, unlockedSince, weekendOf } from './records';
import { recordText } from './recordText';
import { startOfDay } from './stats';

const H = 3600;
let n = 0;
function s(start: Date, seconds: number, gameId = 'g1', perf: Record<string, number> | null = null): Session {
  return {
    id: `d${++n}`, gameId, installationId: null, start: start.toISOString(), end: new Date(start.getTime() + seconds * 1000).toISOString(),
    durationSeconds: seconds, source: 'tracked', perfSummary: perf ? JSON.stringify(perf) : null,
  };
}
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
const ttb = (main: number | null, completionist: number | null = null): TimeToBeat => ({ main, extras: null, completionist, count: 10, fetched: '2026-01-01T00:00:00Z', source: 'igdb' });

describe('Track D1 records', () => {
  it('weekend warrior adds Saturday and Sunday (2026-10-03/04) and ignores weekdays', () => {
    expect(weekendOf(startOfDay(at(2026, 10, 3).getTime()))).toBe(startOfDay(at(2026, 10, 3).getTime()));
    expect(weekendOf(startOfDay(at(2026, 10, 4).getTime()))).toBe(startOfDay(at(2026, 10, 3).getTime()));
    expect(weekendOf(startOfDay(at(2026, 10, 5).getTime()))).toBeNull();
    const r = computeRecords([s(at(2026, 10, 3), 2 * H, 'a'), s(at(2026, 10, 4), 3 * H, 'b'), s(at(2026, 10, 6), 9 * H, 'c'), s(at(2026, 10, 10), 4 * H, 'a')]);
    expect(r.weekendWarrior?.value).toBe(5 * H);
    expect(r.weekendWarrior?.at).toBe(startOfDay(at(2026, 10, 3).getTime()));
    expect(r.weekendWarrior?.gameId).toBe('b');
  });

  it('marathon month and sampler use calendar months', () => {
    const r = computeRecords([
      s(at(2026, 8, 30), 4 * H, 'a'), s(at(2026, 9, 1), 2 * H, 'b'), s(at(2026, 9, 2), 2 * H, 'c'), s(at(2026, 9, 20), 1 * H, 'd'),
    ]);
    expect(r.marathonMonth?.value).toBe(5 * H);
    expect(r.marathonMonth?.at).toBe(at(2026, 9, 1, 0).getTime());
    expect(r.marathonMonth?.until).toBe(startOfDay(at(2026, 9, 30).getTime()));
    expect(r.varietyMonth?.value).toBe(3);
  });

  it('devoted is the longest run of days with one game, not just any game', () => {
    const r = computeRecords([
      s(at(2026, 5, 1), H, 'a'), s(at(2026, 5, 2), H, 'b'), s(at(2026, 5, 3), H, 'a'),
      s(at(2026, 6, 1), H, 'b'), s(at(2026, 6, 2), 2 * H, 'b'), s(at(2026, 6, 3), H, 'b'),
    ]);
    expect(r.streak?.value).toBe(3);
    expect(r.gameStreak?.value).toBe(3);
    expect(r.gameStreak?.gameId).toBe('b');
    expect(r.gameStreak?.at).toBe(startOfDay(at(2026, 6, 1).getTime()));
    // The longest session of that run opens from the badge.
    expect(r.gameStreak?.sessionId).toBe(`d${n - 1}`);
    expect(computeRecords([s(at(2026, 5, 1), H, 'a'), s(at(2026, 5, 2), H, 'b')]).gameStreak).toBeUndefined();
  });

  it('trophy day counts unlocks per local day, with or without sessions', () => {
    const r = computeRecords([], {
      achievements: [
        { gameId: 'a', unlockedAt: at(2026, 4, 1, 9).toISOString() }, { gameId: 'a', unlockedAt: at(2026, 4, 1, 23).toISOString() },
        { gameId: 'b', unlockedAt: at(2026, 4, 1, 10).toISOString() }, { gameId: 'b', unlockedAt: at(2026, 4, 2, 10).toISOString() },
        { gameId: null, unlockedAt: 'garbage' },
      ],
    });
    expect(r.achievementDay?.value).toBe(3);
    expect(r.achievementDay?.gameId).toBe('a');
    expect(r.achievementDay?.day).toBe(startOfDay(at(2026, 4, 1).getTime()));
    expect(computeRecords([]).achievementDay).toBeUndefined();
  });

  it('speedrunner compares tracked play before the finish with the estimate (main story; completionist for 100%)', () => {
    const games = new Map([
      ['fast', { status: 'beaten', statusChangedAt: at(2026, 3, 10).toISOString() }],
      ['slow', { status: 'beaten', statusChangedAt: at(2026, 3, 10).toISOString() }],
      ['full', { status: 'completed', statusChangedAt: at(2026, 3, 10).toISOString() }],
      ['open', { status: 'playing', statusChangedAt: at(2026, 3, 10).toISOString() }],
    ]);
    const list = [
      s(at(2026, 3, 1), 5 * H, 'fast'), s(at(2026, 3, 11), 50 * H, 'fast'), // after the finish: not counted
      s(at(2026, 3, 1), 20 * H, 'slow'),
      s(at(2026, 3, 1), 30 * H, 'full'),
      s(at(2026, 3, 1), 2 * H, 'open'),
    ];
    const r = computeRecords(list, { games, ttb: { fast: ttb(10 * H), slow: ttb(10 * H), full: ttb(5 * H, 60 * H), open: ttb(40 * H) } });
    expect(r.speedrun?.gameId).toBe('fast');
    expect(r.speedrun?.value).toBe(50);
    expect(recordText('speedrun', r.speedrun).value).toBe('50% of the usual time');
    // Without estimates it stays locked.
    expect(computeRecords(list, { games }).speedrun).toBeUndefined();
  });

  it('centurion marks the moment one game passed 100 hours', () => {
    const list = [s(at(2026, 1, 1), 60 * H, 'a'), s(at(2026, 1, 5), 30 * H, 'b'), s(at(2026, 2, 1), 50 * H, 'a')];
    const r = computeRecords(list);
    expect(r.century?.gameId).toBe('a');
    expect(r.century?.value).toBe(at(2026, 2, 1).getTime() + (CENTURY_HOURS - 60) * H * 1000);
    expect(computeRecords(list.slice(0, 2)).century).toBeUndefined();
  });

  it('genre devotee and time traveller read the library', () => {
    const games = new Map([
      ['a', { genres: ['Racing', 'Open World'], releaseDate: '2018-10-02' }],
      ['b', { genres: ['Racing'], releaseDate: '1998' }],
      ['c', { genres: ['Puzzle'], releaseDate: null }],
    ]);
    const r = computeRecords([s(at(2026, 1, 1), 3 * H, 'a'), s(at(2026, 1, 2), 2 * H, 'b'), s(at(2026, 1, 3), 4 * H, 'c')], { games });
    expect(r.genreHours?.label).toBe('Racing');
    expect(r.genreHours?.value).toBe(5 * H);
    expect(recordText('genreHours', r.genreHours).what).toBe('Most hours in one genre: Racing');
    expect(r.oldestGame?.value).toBe(1998);
    expect(r.oldestGame?.gameId).toBe('b');
    expect(releaseYear('nonsense')).toBeNull();
    expect(releaseYear('1802')).toBeNull();
  });

  it('frame-rate and temperature records only count measured sessions of 20 minutes or more', () => {
    const r = computeRecords([
      s(at(2026, 1, 1), H, 'a', { fpsAvg: 90, gpuTempAvgC: 70 }),
      s(at(2026, 1, 2), 10 * 60, 'b', { fpsAvg: 300, gpuTempAvgC: 40 }), // too short
      s(at(2026, 1, 3), H, 'c', { fpsAvg: 144.4, gpuTempAvgC: 58 }),
      s(at(2026, 1, 4), H, 'd', { gpuTempAvgC: 61 }),
    ]);
    expect(r.bestFps?.gameId).toBe('c');
    expect(recordText('bestFps', r.bestFps).value).toBe('144 fps');
    expect(r.coolest?.value).toBe(58);
    expect(perfOf('{"fpsAvg": -3, "gpuTempAvgC": 500}')).toEqual({ fps: null, tempC: null });
    expect(perfOf('not json')).toEqual({ fps: null, tempC: null });
  });

  it('a new best frame rate is worth a toast; records that read the library never are', () => {
    const list = [s(at(2026, 1, 1), H, 'a', { fpsAvg: 70 }), s(at(2026, 1, 8), H, 'a', { fpsAvg: 120 })];
    const broken = recordsBrokenBy(list, list[1].id).map((b) => b.id);
    expect(broken).toContain('bestFps');
    expect(broken).not.toContain('coolest');
  });

  it('the fanfare is for badges earned since the last visit only, and never on a first visit', () => {
    const records = computeRecords([s(at(2026, 1, 1), H, 'a'), s(at(2026, 1, 2), H, 'a')]);
    expect(unlockedSince(records, null)).toEqual([]);
    expect(unlockedSince(records, { longestSession: 1, first: 0 })).toEqual(expect.arrayContaining(['bestDay', 'streak', 'gameStreak']));
    expect(unlockedSince(records, { longestSession: 1, first: 0 })).not.toContain('longestSession');
  });

  it('every badge has words for both states', () => {
    for (const id of RECORD_IDS) {
      const copy = recordText(id, undefined);
      expect(copy.name.length).toBeGreaterThan(2);
      expect(copy.locked.length).toBeGreaterThan(5);
      expect(copy.value).toBe('');
    }
    expect(RECORD_IDS).toHaveLength(20);
  });
});
