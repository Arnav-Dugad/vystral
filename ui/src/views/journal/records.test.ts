import { describe, expect, it } from 'vitest';
import type { Session } from '../../bridge/types';
import {
  CELEBRATE_FLOOR, computeRecords, finishedSessions, improvedSince, nightScore, recordsBrokenBy, scoresOf, startOfWeek,
} from './records';
import { recordText } from './recordText';

const H = 3600;
let n = 0;
/** A finished session starting at a local wall-clock time. */
function s(start: Date, seconds: number, gameId = 'g1', extra: Partial<Session> = {}): Session {
  return {
    id: `s${++n}`, gameId, installationId: null, start: start.toISOString(), end: new Date(start.getTime() + seconds * 1000).toISOString(),
    durationSeconds: seconds, source: 'tracked', perfSummary: null, ...extra,
  };
}
const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min);
/** Node's environment (the time zone is read from TZ at each date call). */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;

describe('finishedSessions', () => {
  it('leaves out open, imported, zero-length and unparseable sessions', () => {
    const list = [
      s(at(2026, 3, 1), H),
      s(at(2026, 3, 2), H, 'g1', { end: null }),
      s(at(2026, 3, 3), H, 'g1', { source: 'imported' }),
      s(at(2026, 3, 4), 0),
      { ...s(at(2026, 3, 5), H), start: 'not a date' },
    ];
    expect(finishedSessions(list).map((x) => x.startMs)).toEqual([at(2026, 3, 1).getTime()]);
  });

  it('keeps detected, background and cloud sessions', () => {
    const list = [s(at(2026, 3, 1), H, 'a', { source: 'detected' }), s(at(2026, 3, 2), H, 'b', { source: 'background' }), s(at(2026, 3, 3), H, 'c', { source: 'cloud-gfn' })];
    expect(finishedSessions(list)).toHaveLength(3);
  });
});

describe('computeRecords', () => {
  it('has nothing to show without finished sessions', () => {
    expect(computeRecords([])).toEqual({});
    expect(computeRecords([s(at(2026, 3, 1), H, 'g', { end: null })])).toEqual({});
  });

  it('an open session never sets a record', () => {
    const r = computeRecords([s(at(2026, 3, 1), H), s(at(2026, 3, 2), 9 * H, 'g2', { end: null })]);
    expect(r.longestSession?.value).toBe(H);
    expect(r.bestDay?.value).toBe(H);
  });

  it('finds the longest session, the first session and who set them', () => {
    const a = s(at(2026, 1, 10, 20), 2 * H, 'alpha');
    const b = s(at(2026, 2, 3, 18), 5 * H, 'beta');
    const c = s(at(2026, 2, 4, 18), 5 * H, 'gamma'); // a tie doesn't take the record
    const r = computeRecords([c, b, a]);
    expect(r.longestSession).toMatchObject({ value: 5 * H, gameId: 'beta', sessionId: b.id });
    expect(r.first).toMatchObject({ gameId: 'alpha', sessionId: a.id, value: at(2026, 1, 10, 20).getTime() });
  });

  it('splits a session across midnight for the best day', () => {
    // 22:00 → 03:00: 2 h on the 1st, 3 h on the 2nd.
    const night = s(at(2026, 3, 1, 22), 5 * H, 'owl');
    const r = computeRecords([night, s(at(2026, 3, 1, 10), 30 * 60, 'day')]);
    expect(r.bestDay).toMatchObject({ value: 3 * H, day: at(2026, 3, 2, 0).getTime(), gameId: 'owl', sessionId: night.id });
    // The longest session is still the whole session.
    expect(r.longestSession?.value).toBe(5 * H);
  });

  it('counts weeks from Monday, splitting a session that crosses into a new week', () => {
    // Sunday 1 March 2026 22:00 → Monday 02:00.
    const cross = s(at(2026, 3, 1, 22), 4 * H, 'x');
    expect(new Date(startOfWeek(at(2026, 3, 1).getTime())).getDay()).toBe(1);
    const r = computeRecords([cross, s(at(2026, 3, 3, 12), H, 'y'), s(at(2026, 3, 4, 12), H, 'z')]);
    // Monday's week: 2 h of x + y + z = 4 h and three games; Sunday's week: 2 h of x.
    expect(r.bestWeek).toMatchObject({ value: 4 * H, at: at(2026, 3, 2, 0).getTime() });
    expect(r.varietyWeek).toMatchObject({ value: 3, at: at(2026, 3, 2, 0).getTime() });
  });

  it('measures the longest streak of days, counting a night session for both days', () => {
    const list = [
      s(at(2026, 4, 1, 23), 2 * H, 'a'), // 1st and 2nd
      s(at(2026, 4, 3, 12), H, 'b'),
      s(at(2026, 4, 4, 12), 3 * H, 'b'),
      s(at(2026, 4, 10, 12), H, 'c'),
      s(at(2026, 4, 11, 12), H, 'c'),
    ];
    const r = computeRecords(list);
    expect(r.streak).toMatchObject({ value: 4, at: at(2026, 4, 1, 0).getTime(), until: at(2026, 4, 4, 0).getTime(), gameId: 'b' });
    expect(r.streak?.sessionId).toBe(list[2].id);
  });

  it('needs two days in a row for a streak', () => {
    expect(computeRecords([s(at(2026, 4, 1), H), s(at(2026, 4, 3), H)]).streak).toBeUndefined();
  });

  it('night owl: the latest finish, where 02:00 beats 23:30, and daytime finishes never count', () => {
    const late = s(at(2026, 5, 1, 21, 30), 2 * H); // ends 23:30
    const later = s(at(2026, 5, 2, 23), 3 * H); // ends 02:00 next day
    const day = s(at(2026, 5, 3, 13), 2 * H); // ends 15:00
    const r = computeRecords([late, later, day]);
    expect(r.nightOwl).toMatchObject({ value: 120, sessionId: later.id, day: at(2026, 5, 2, 0).getTime() });
    expect(computeRecords([day]).nightOwl).toBeUndefined();
    expect(nightScore(2 * 60)).toBeGreaterThan(nightScore(23 * 60 + 30));
  });

  it('early bird: the earliest start between 4 and 9 in the morning', () => {
    const r = computeRecords([s(at(2026, 5, 1, 8, 15), H), s(at(2026, 5, 2, 6, 40), H), s(at(2026, 5, 3, 2), H)]);
    expect(r.earlyBird?.value).toBe(6 * 60 + 40);
    expect(computeRecords([s(at(2026, 5, 3, 9, 30), H)]).earlyBird).toBeUndefined();
  });

  it('comeback: the longest time away from one game, at least 30 days', () => {
    const list = [s(at(2026, 1, 1), H, 'a'), s(at(2026, 1, 20), H, 'b'), s(at(2026, 3, 15), H, 'a'), s(at(2026, 2, 10), H, 'b')];
    const r = computeRecords(list);
    expect(r.comeback).toMatchObject({ value: 73, gameId: 'a', sessionId: list[2].id });
    expect(computeRecords([s(at(2026, 1, 1), H, 'a'), s(at(2026, 1, 20), H, 'a')]).comeback).toBeUndefined();
  });

  it('uses the local time zone for days and night hours', () => {
    const prev = env.TZ;
    try {
      // 2026-06-01 03:30 UTC: 23:30 on 31 May in New York, 05:30 on 1 June in Berlin (not a night finish there).
      const list: Session[] = [{
        id: 'tz', gameId: 'g', installationId: null, start: '2026-06-01T01:30:00.000Z', end: '2026-06-01T03:30:00.000Z',
        durationSeconds: 2 * H, source: 'tracked', perfSummary: null,
      }];
      env.TZ = 'America/New_York';
      const ny = computeRecords(list);
      expect(ny.nightOwl?.value).toBe(23 * 60 + 30);
      expect(new Date(ny.bestDay!.day).getDate()).toBe(31);
      env.TZ = 'Europe/Berlin';
      const berlin = computeRecords(list);
      expect(berlin.nightOwl?.value).toBe(5 * 60 + 30);
      expect(berlin.earlyBird).toBeUndefined(); // started 03:30, before 04:00
      expect(new Date(berlin.bestDay!.day).getDate()).toBe(1);
    } finally {
      if (prev === undefined) delete env.TZ;
      else env.TZ = prev;
    }
  });
});

describe('recordsBrokenBy', () => {
  const history = () => [s(at(2026, 6, 1, 18), 2 * H, 'a'), s(at(2026, 6, 8, 18), 90 * 60, 'b')];

  it('celebrates only a strict improvement, above the floor, by that session', () => {
    const list = history();
    const fresh = s(at(2026, 6, 15, 12), 3 * H, 'c');
    const broken = recordsBrokenBy([...list, fresh], fresh.id).map((b) => b.id);
    expect(broken).toContain('longestSession');
    expect(broken).toContain('bestDay');
    const longest = recordsBrokenBy([...list, fresh], fresh.id).find((b) => b.id === 'longestSession')!;
    expect(longest.before.value).toBe(2 * H);
    expect(longest.after.value).toBe(3 * H);
  });

  it('a tie is not a new record', () => {
    const list = history();
    const tie = s(at(2026, 6, 15, 12), 2 * H, 'c');
    expect(recordsBrokenBy([...list, tie], tie.id).map((b) => b.id)).not.toContain('longestSession');
  });

  it('the first record ever is not celebrated, nor tiny ones', () => {
    const only = s(at(2026, 6, 1, 18), 5 * H);
    expect(recordsBrokenBy([only], only.id)).toEqual([]);
    const tiny = [s(at(2026, 6, 1, 12), 5 * 60), s(at(2026, 6, 8, 12), 10 * 60)];
    expect(recordsBrokenBy(tiny, tiny[1].id)).toEqual([]);
    expect(CELEBRATE_FLOOR.longestSession).toBeGreaterThan(10 * 60);
  });

  it('ignores open or unknown sessions', () => {
    const list = history();
    const open = s(at(2026, 6, 15, 12), 6 * H, 'c', { end: null });
    expect(recordsBrokenBy([...list, open], open.id)).toEqual([]);
    expect(recordsBrokenBy(list, 'nope')).toEqual([]);
  });

  it('notices a longer streak and a later night', () => {
    const list = [
      s(at(2026, 7, 1, 20), H, 'a'), s(at(2026, 7, 2, 20), H, 'a'), s(at(2026, 7, 3, 20), H, 'a'),
      s(at(2026, 7, 10, 21), 2 * H, 'b'), // ends 23:00
    ];
    const next = s(at(2026, 7, 4, 22), 2.5 * H, 'a'); // day four, ends 00:30
    const ids = recordsBrokenBy([...list, next], next.id).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['streak', 'nightOwl']));
  });
});

describe('new since last visit', () => {
  it('marks only records whose score went up, and nothing on the first visit', () => {
    const r = computeRecords([s(at(2026, 6, 1, 18), 2 * H), s(at(2026, 6, 2, 18), 3 * H)]);
    expect(improvedSince(r, null).size).toBe(0);
    const seen = scoresOf(r);
    expect(improvedSince(r, seen).size).toBe(0);
    expect([...improvedSince(r, { ...seen, longestSession: H })]).toEqual(['longestSession']);
  });
});

describe('recordText', () => {
  it('words values plainly', () => {
    const r = computeRecords([s(at(2026, 6, 1, 22), 4 * H + 20 * 60, 'a'), s(at(2026, 6, 2, 22), H, 'a')]);
    expect(recordText('longestSession', r.longestSession).value).toBe('4h 20m');
    expect(recordText('streak', r.streak).value).toBe('2 days');
    expect(recordText('nightOwl', r.nightOwl).value).toMatch(/2:20|02:20/);
    expect(recordText('comeback', undefined).locked).toMatch(/30 days/);
  });
});
