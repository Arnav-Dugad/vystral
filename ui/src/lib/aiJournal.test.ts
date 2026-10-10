import { describe, expect, it } from 'vitest';
import type { JournalResult } from '../bridge/types';
import { chartBars, describeSpec, formatJournalValue, labelEvery, READY_QUESTIONS } from './aiJournal';

const result = (over: Partial<JournalResult> = {}): JournalResult => ({
  spec: { metric: 'playtime', groupBy: 'game', from: '2026-08-01', to: '2026-08-31', gameIds: [], genres: [], platforms: [], sort: 'desc', limit: 10 },
  rows: [
    { key: 'a', label: 'Ashen Crown', value: 7200, gameId: 'a' },
    { key: 'b', label: 'Nebula Drift', value: 1800, gameId: 'b' },
    { key: 'c', label: 'Idle', value: 0, gameId: null },
  ],
  unit: 'seconds', chart: 'bar', total: 9000, sessions: 3, games: 2, rangeLabel: 'August 2026', description: 'Playtime by game · August 2026', notes: [], unmatched: [],
  ...over,
});

describe('Ask the Journal helpers', () => {
  it('ready-made questions are fixed, valid specs that need no AI', () => {
    expect(READY_QUESTIONS.length).toBeGreaterThanOrEqual(5);
    for (const q of READY_QUESTIONS) {
      expect(q.spec.metric).toBeDefined();
      expect(q.spec.groupBy).toBeDefined();
      expect(q.spec.preset).toBeDefined();
    }
    expect(new Set(READY_QUESTIONS.map((q) => q.id)).size).toBe(READY_QUESTIONS.length);
  });

  it('formats values in the result’s unit', () => {
    expect(formatJournalValue(7200, 'seconds')).toBe('2h');
    expect(formatJournalValue(30, 'seconds')).toBe('under 1m');
    expect(formatJournalValue(1, 'count')).toBe('1 session');
    expect(formatJournalValue(4, 'days')).toBe('4 days');
  });

  it('scales bars to the largest value and keeps zero empty', () => {
    const bars = chartBars(result());
    expect(bars.map((b) => b.share)).toEqual([1, 0.25, 0]);
    expect(bars[0].text).toBe('2h');
    expect(chartBars(result({ rows: [{ key: 'z', label: 'Z', value: 0, gameId: null }] }))[0].share).toBe(0);
  });

  it('labels every nth column when there are many', () => {
    expect(labelEvery(7)).toBe(1);
    expect(labelEvery(24)).toBe(3);
    expect(labelEvery(31)).toBe(5);
    expect(labelEvery(120)).toBe(15);
  });

  it('describes the query that was used', () => {
    expect(describeSpec(result(), () => '?')).toEqual(['Playtime by game', 'August 2026', 'Top 10']);
    const r = result({ spec: { ...result().spec, groupBy: 'weekday', gameIds: ['a'], genres: ['RPG'] }, rangeLabel: 'all time' });
    expect(describeSpec(r, (id) => (id === 'a' ? 'Ashen Crown' : '?'))).toEqual(['Playtime by day of the week', 'All time', 'Ashen Crown', 'RPG']);
  });
});
