import { describe, it, expect } from 'vitest';
import type { Session } from '../../bridge/types';
import {
  addDays, computeTotals, currentStreak, dailyTotals, genreTotals, groupByDay, inRange, longestStreak, milestones,
  normalizeSessions, playtimeBuckets, splitAcrossDays, startOfDay, takeGroups, topGames, yearInReview, type JSession,
} from './stats';

// Local-time constructors keep these tests independent of the machine's time zone.
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
let seq = 0;
const s = (gameId: string, start: number, seconds: number, hasMetrics = false): JSession => ({ id: `s${++seq}`, gameId, startMs: start, seconds, hasMetrics });
const H = 3600;

describe('normalizeSessions', () => {
  it('keeps only tracked sessions with valid starts, newest first', () => {
    const base: Omit<Session, 'id' | 'start' | 'source'> = { gameId: 'g', installationId: null, end: null, durationSeconds: 60, perfSummary: null };
    const list: Session[] = [
      { ...base, id: 'a', start: new Date(at(2026, 1, 1)).toISOString(), source: 'tracked' },
      { ...base, id: 'b', start: new Date(at(2026, 1, 3)).toISOString(), source: 'tracked', perfSummary: '{}' },
      { ...base, id: 'c', start: new Date(at(2026, 1, 2)).toISOString(), source: 'imported' },
      { ...base, id: 'd', start: 'not a date', source: 'tracked' },
      { ...base, id: 'e', start: new Date(at(2026, 1, 2)).toISOString(), source: 'tracked', durationSeconds: -5 },
    ];
    const out = normalizeSessions(list);
    expect(out.map((x) => x.id)).toEqual(['b', 'e', 'a']);
    expect(out[0].hasMetrics).toBe(true);
    expect(out[1].seconds).toBe(0);
  });
});

describe('splitAcrossDays', () => {
  it('splits a session that crosses midnight', () => {
    const parts = splitAcrossDays(at(2026, 3, 10, 23, 0), 2 * H);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ dayStart: startOfDay(at(2026, 3, 10)), seconds: H });
    expect(parts[1]).toEqual({ dayStart: startOfDay(at(2026, 3, 11)), seconds: H });
  });
  it('keeps a zero-length session as a played day', () => {
    expect(splitAcrossDays(at(2026, 3, 10), 0)).toEqual([{ dayStart: startOfDay(at(2026, 3, 10)), seconds: 0 }]);
  });
});

describe('totals and streaks', () => {
  const now = at(2026, 5, 20, 18);
  const list = [
    s('a', at(2026, 5, 20, 9), H),
    s('b', at(2026, 5, 19, 9), 3 * H),
    s('a', at(2026, 5, 18, 9), 2 * H),
    s('a', at(2026, 5, 10, 9), H),
  ];

  it('sums totals and finds the longest session', () => {
    const t = computeTotals(list);
    expect(t.seconds).toBe(7 * H);
    expect(t.sessions).toBe(4);
    expect(t.games).toBe(2);
    expect(t.activeDays).toBe(4);
    expect(t.longest?.gameId).toBe('b');
  });

  it('counts the current streak ending today', () => {
    expect(currentStreak(list, now)).toBe(3);
  });

  it('keeps a streak alive when the last play was yesterday', () => {
    expect(currentStreak(list, at(2026, 5, 21, 8))).toBe(3);
    expect(currentStreak(list, at(2026, 5, 22, 8))).toBe(0);
  });

  it('finds the longest streak', () => {
    expect(longestStreak(list)).toEqual({ days: 3, endDay: startOfDay(at(2026, 5, 20)) });
  });

  it('filters by rolling range', () => {
    expect(inRange(list, 'week', now)).toHaveLength(3);
    expect(inRange(list, 'month', now)).toHaveLength(4);
    expect(inRange(list, 'all', now)).toHaveLength(4);
  });
});

describe('playtimeBuckets', () => {
  const now = at(2026, 5, 20, 18);
  it('builds 7 daily buckets ending today for a week', () => {
    const { buckets, unit } = playtimeBuckets([s('a', at(2026, 5, 20, 9), H), s('a', at(2026, 5, 14, 9), H), s('a', at(2026, 5, 13, 9), H)], 'week', now);
    expect(unit).toBe('day');
    expect(buckets).toHaveLength(7);
    expect(buckets[6].start).toBe(startOfDay(now));
    expect(buckets[6].seconds).toBe(H);
    expect(buckets[0].start).toBe(startOfDay(at(2026, 5, 14)));
    expect(buckets[0].seconds).toBe(H);
    expect(buckets.reduce((n, b) => n + b.seconds, 0)).toBe(2 * H);
  });

  it('has 365 daily buckets for a year', () => {
    expect(playtimeBuckets([], 'year', now).buckets).toHaveLength(365);
  });

  it('switches to weekly buckets for long all-time histories', () => {
    const list = [s('a', at(2024, 1, 1, 9), H), s('a', at(2026, 5, 20, 9), 2 * H)];
    const { buckets, unit } = playtimeBuckets(list, 'all', now);
    expect(unit).toBe('week');
    expect(buckets[buckets.length - 1].end).toBe(addDays(startOfDay(now), 1));
    expect(buckets.reduce((n, b) => n + b.seconds, 0)).toBe(3 * H);
    expect(buckets.reduce((n, b) => n + b.sessions, 0)).toBe(2);
  });

  it('shows at least 30 days for a short all-time history', () => {
    expect(playtimeBuckets([s('a', at(2026, 5, 19), H)], 'all', now).buckets).toHaveLength(30);
  });
});

describe('games, genres and timeline', () => {
  const list = [s('a', at(2026, 1, 3, 20), H), s('b', at(2026, 1, 3, 10), 4 * H), s('a', at(2026, 1, 2, 10), 2 * H)];

  it('ranks games by tracked time', () => {
    const top = topGames(list);
    expect(top.map((g) => g.gameId)).toEqual(['b', 'a']);
    expect(top[1]).toMatchObject({ seconds: 3 * H, sessions: 2 });
  });

  it('weights genres by tracked time', () => {
    const genres = genreTotals(list, (id) => (id === 'a' ? ['RPG', 'Fantasy'] : id === 'b' ? ['RPG'] : undefined));
    expect(genres[0]).toEqual({ genre: 'RPG', seconds: 7 * H, games: 2 });
    expect(genres[1]).toEqual({ genre: 'Fantasy', seconds: 3 * H, games: 1 });
  });

  it('groups sessions by day, newest first, without splitting days when paginating', () => {
    const groups = groupByDay(list);
    expect(groups).toHaveLength(2);
    expect(groups[0].sessions.map((x) => x.gameId)).toEqual(['a', 'b']);
    expect(groups[0].seconds).toBe(5 * H);
    const page = takeGroups(groups, 1);
    expect(page.shown).toHaveLength(1);
    expect(page.shownSessions).toBe(2);
  });

  it('handles 10k sessions quickly', () => {
    const big: JSession[] = [];
    for (let i = 0; i < 10_000; i++) big.push(s(`g${i % 50}`, at(2026, 1, 1) + i * 3 * H * 1000, 1800));
    const t0 = performance.now();
    groupByDay(big);
    playtimeBuckets(big, 'all', at(2030, 1, 1));
    milestones(big);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('milestones', () => {
  it('returns nothing without sessions', () => {
    expect(milestones([])).toEqual([]);
  });

  it('derives milestones from recorded sessions only', () => {
    const list = [
      s('a', at(2026, 1, 1, 10), 6 * H),
      s('a', at(2026, 1, 2, 10), 6 * H), // crosses 10h after 4h into this session
      s('b', at(2026, 2, 1, 10), 2 * H),
      s('b', at(2026, 2, 2, 10), H),
      s('b', at(2026, 2, 3, 10), H),
    ];
    const ms = milestones(list);
    const kinds = ms.map((m) => m.kind);
    expect(kinds[0]).toBe('first');
    const ten = ms.find((m) => m.kind === 'gameHours');
    expect(ten).toMatchObject({ gameId: 'a', hours: 10, at: at(2026, 1, 2, 14) });
    expect(ms.find((m) => m.kind === 'longestSession')).toMatchObject({ gameId: 'a', seconds: 6 * H });
    expect(ms.find((m) => m.kind === 'topMonth')).toMatchObject({ seconds: 12 * H });
    expect(ms.find((m) => m.kind === 'longestStreak')).toMatchObject({ days: 3 });
    expect(kinds).not.toContain('totalHours');
    // chronological
    expect(ms.map((m) => m.at)).toEqual(ms.map((m) => m.at).slice().sort((x, y) => x - y));
  });

  it('skips most-played month when there is only one month', () => {
    expect(milestones([s('a', at(2026, 1, 1), H)]).some((m) => m.kind === 'topMonth')).toBe(false);
  });

  it('marks session-count milestones', () => {
    const list = Array.from({ length: 100 }, (_, i) => s('a', at(2026, 1, 1) + i * 1000 * H, 60));
    expect(milestones(list).find((m) => m.kind === 'sessionCount')).toMatchObject({ count: 100, at: list[99].startMs });
  });
});

describe('yearInReview', () => {
  const genres = () => ['Racing'];
  it('is null when nothing was tracked that year', () => {
    expect(yearInReview([s('a', at(2025, 6, 1), H)], 2026, genres)).toBeNull();
  });
  it('summarises the year from recorded data', () => {
    const list = [s('a', at(2026, 3, 1), H), s('b', at(2026, 3, 2), 3 * H), s('a', at(2026, 7, 1), H), s('a', at(2025, 7, 1), 9 * H)];
    const r = yearInReview(list, 2026, genres)!;
    expect(r.seconds).toBe(5 * H);
    expect(r.sessions).toBe(3);
    expect(r.games).toBe(2);
    expect(r.busiestMonth).toBe(2);
    expect(r.topGame?.gameId).toBe('b');
    expect(r.topGenre).toMatchObject({ genre: 'Racing', seconds: 5 * H });
    expect(r.activeDays).toBe(3);
    expect(r.longestStreakDays).toBe(2);
  });
});

describe('dailyTotals', () => {
  it('attributes cross-midnight play to both days', () => {
    const map = dailyTotals([s('a', at(2026, 1, 1, 23, 30), H)]);
    expect([...map.values()]).toEqual([1800, 1800]);
  });
});
