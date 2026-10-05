import { describe, expect, it } from 'vitest';
import { isObserved, sessionOrigin } from './sessions';
import { normalizeSessions } from '../views/journal/stats';
import type { Session } from '../bridge/types';

describe('session sources', () => {
  it('counts every observed source and never store playtime', () => {
    expect(['tracked', 'detected', 'background'].every(isObserved)).toBe(true);
    expect(isObserved('imported')).toBe(false);
    expect(isObserved(undefined)).toBe(false);
  });

  it('labels only sessions VYSTRAL did not launch', () => {
    expect(sessionOrigin('tracked')).toBeNull();
    expect(sessionOrigin('background')?.label).toBe('Background');
    expect(sessionOrigin('detected')?.label).toBe('Detected');
  });

  it('includes background and detected sessions in the journal, with their origin', () => {
    const base: Omit<Session, 'id' | 'start' | 'source'> = { gameId: 'g', installationId: null, end: null, durationSeconds: 120, perfSummary: null };
    const list = normalizeSessions([
      { ...base, id: 'a', start: '2026-10-01T10:00:00Z', source: 'tracked' },
      { ...base, id: 'b', start: '2026-10-02T10:00:00Z', source: 'background' },
      { ...base, id: 'c', start: '2026-10-03T10:00:00Z', source: 'detected' },
      { ...base, id: 'd', start: '2026-10-04T10:00:00Z', source: 'imported' },
    ]);
    expect(list.map((s) => s.id)).toEqual(['c', 'b', 'a']);
    expect(list.map((s) => s.source)).toEqual(['detected', 'background', 'tracked']);
  });
});
