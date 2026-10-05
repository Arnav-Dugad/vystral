import { describe, expect, it } from 'vitest';
import type { GameStatus, StatusHistoryEntry } from '../../bridge/types';
import {
  backlogSeries, currentCounts, DAILY_LIMIT, describeBacklog, finishedInYear, normalizeHistory, timeToBeat, type StatusEvent,
} from './backlog';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const ev = (gameId: string, status: GameStatus | null, ms: number): StatusEvent => ({ gameId, status, atMs: ms });

describe('normalizeHistory', () => {
  it('parses, drops bad timestamps and sorts stably', () => {
    const list: StatusHistoryEntry[] = [
      { gameId: 'b', status: 'playing', at: new Date(at(2026, 2, 1)).toISOString() },
      { gameId: 'a', status: 'backlog', at: 'nonsense' },
      { gameId: 'a', status: 'backlog', at: new Date(at(2026, 1, 1)).toISOString() },
      { gameId: 'c', status: null, at: new Date(at(2026, 2, 1)).toISOString() },
    ];
    expect(normalizeHistory(list).map((e) => e.gameId)).toEqual(['a', 'b', 'c']);
  });
});

describe('currentCounts', () => {
  it('counts each status and ignores games without one', () => {
    expect(currentCounts([{ status: 'backlog' }, { status: 'backlog' }, { status: null }, {}, { status: 'completed' }])).toEqual({
      backlog: 2, playing: 0, beaten: 0, completed: 1, abandoned: 0,
    });
  });
});

describe('backlogSeries', () => {
  it('is empty without history', () => {
    expect(backlogSeries([], at(2026, 3, 1)).points).toEqual([]);
  });

  it('holds end-of-day state for every day through today', () => {
    const events = [
      ev('a', 'backlog', at(2026, 3, 1, 9)),
      ev('b', 'backlog', at(2026, 3, 1, 20)),
      ev('a', 'playing', at(2026, 3, 3)),
      ev('a', 'beaten', at(2026, 3, 4)),
      ev('b', null, at(2026, 3, 4, 23)),
    ];
    const s = backlogSeries(events, at(2026, 3, 5));
    expect(s.unit).toBe('day');
    expect(s.points.map((p) => [p.backlog, p.playing, p.finished])).toEqual([
      [2, 0, 0], // Mar 1
      [2, 0, 0], // Mar 2
      [1, 1, 0], // Mar 3
      [0, 0, 1], // Mar 4
      [0, 0, 1], // Mar 5 (today)
    ]);
    expect(s.points[0].start).toBe(new Date(2026, 2, 1).getTime());
  });

  it('never double-counts a game that changes status repeatedly in a day', () => {
    const d = at(2026, 4, 1, 1);
    const s = backlogSeries([ev('a', 'backlog', d), ev('a', 'playing', d + 1000), ev('a', 'backlog', d + 2000)], at(2026, 4, 1, 22));
    expect(s.points).toHaveLength(1);
    expect(s.points[0]).toMatchObject({ backlog: 1, playing: 0 });
  });

  it('switches to weekly points for long histories', () => {
    const s = backlogSeries([ev('a', 'backlog', at(2025, 1, 1))], at(2026, 1, 1));
    expect(s.unit).toBe('week');
    expect(s.points.length).toBeGreaterThan(50);
    expect(s.points.length).toBeLessThan(54);
    expect(s.points.every((p) => p.backlog === 1)).toBe(true);
    expect(backlogSeries([ev('a', 'backlog', at(2026, 1, 1))], at(2026, 1, 1) + (DAILY_LIMIT - 1) * 86_400_000).unit).toBe('day');
  });

  it('is DST-safe: one point per calendar day across the clock change', () => {
    // Covers both northern and southern hemisphere transitions in any test time zone.
    const s = backlogSeries([ev('a', 'backlog', at(2026, 3, 1))], at(2026, 4, 30));
    const days = new Set(s.points.map((p) => new Date(p.start).toDateString()));
    expect(days.size).toBe(s.points.length);
    expect(s.points.length).toBe(61);
  });
});

describe('finishedInYear', () => {
  const events = [
    ev('a', 'playing', at(2025, 12, 1)),
    ev('a', 'beaten', at(2025, 12, 20)), // last year
    ev('b', 'beaten', at(2026, 2, 1)),
    ev('b', 'completed', at(2026, 5, 1)),
    ev('c', 'beaten', at(2026, 3, 1)),
    ev('c', 'playing', at(2026, 3, 2)), // un-finished since
    ev('d', 'completed', at(2026, 8, 9)),
  ];
  const current: Record<string, GameStatus> = { a: 'beaten', b: 'completed', c: 'playing', d: 'completed' };

  it('lists the first finish this year for games still finished, newest first, with their current status', () => {
    expect(finishedInYear(events, 2026, (id) => current[id])).toEqual([
      { gameId: 'd', status: 'completed', atMs: at(2026, 8, 9) },
      { gameId: 'b', status: 'completed', atMs: at(2026, 2, 1) },
    ]);
  });

  it('respects the year boundary', () => {
    expect(finishedInYear(events, 2025, (id) => current[id]).map((f) => f.gameId)).toEqual(['a']);
  });
});

describe('timeToBeat', () => {
  it('is empty when nothing went from Playing to finished', () => {
    expect(timeToBeat([ev('a', 'beaten', at(2026, 1, 1))], [])).toEqual({ games: 0, avgDays: null, trackedGames: 0, avgTrackedSeconds: null });
  });

  it('averages days and tracked time between the first Playing and the first finish after it', () => {
    const events = [
      ev('a', 'backlog', at(2026, 1, 1)),
      ev('a', 'playing', at(2026, 1, 10)),
      ev('a', 'abandoned', at(2026, 1, 12)),
      ev('a', 'playing', at(2026, 1, 15)),
      ev('a', 'beaten', at(2026, 1, 20)), // 10 days from first Playing
      ev('a', 'completed', at(2026, 2, 20)), // ignored: already counted
      ev('b', 'playing', at(2026, 3, 1)),
      ev('b', 'completed', at(2026, 3, 21)), // 20 days, no tracked sessions
    ];
    const sessions = [
      { gameId: 'a', startMs: at(2026, 1, 9), seconds: 999 }, // before Playing
      { gameId: 'a', startMs: at(2026, 1, 11), seconds: 3600 },
      { gameId: 'a', startMs: at(2026, 1, 16), seconds: 7200 },
      { gameId: 'a', startMs: at(2026, 1, 25), seconds: 999 }, // after Beaten
    ];
    const r = timeToBeat(events, sessions);
    expect(r.games).toBe(2);
    expect(r.avgDays).toBeCloseTo(15, 0);
    expect(r.trackedGames).toBe(1);
    expect(r.avgTrackedSeconds).toBe(10800);
  });
});

describe('describeBacklog', () => {
  it('summarises trend and peak in words', () => {
    const s = backlogSeries([ev('a', 'backlog', at(2026, 1, 1)), ev('b', 'backlog', at(2026, 1, 2)), ev('a', 'beaten', at(2026, 1, 3))], at(2026, 1, 3));
    const text = describeBacklog(s, (ms) => new Date(ms).toISOString().slice(0, 10));
    expect(text).toContain('1 now, unchanged from 1');
    expect(text).toContain('Peak 2');
  });
});
