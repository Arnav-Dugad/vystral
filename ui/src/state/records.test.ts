import { describe, expect, it } from 'vitest';
import type { Session } from '../bridge/types';
import { recordsBrokenBy } from '../views/journal/records';
import { recordToast } from './records';

const H = 3600;
const s = (id: string, start: Date, seconds: number, gameId = 'g'): Session => ({
  id, gameId, installationId: null, start: start.toISOString(), end: new Date(start.getTime() + seconds * 1000).toISOString(),
  durationSeconds: seconds, source: 'tracked', perfSummary: null,
});

describe('recordToast', () => {
  it('names one broken record and what it beat', () => {
    const list = [s('a', new Date(2026, 5, 1, 18), 2 * H), s('b', new Date(2026, 5, 20, 12), 3 * H + 30 * 60)];
    const broken = recordsBrokenBy(list, 'b').filter((x) => x.id === 'longestSession');
    const t = recordToast(broken, 'Starfall');
    expect(t.title).toBe('New personal record: Marathon');
    expect(t.body).toBe('A 3h 30m session in Starfall. Your best was 2h.');
  });

  it('sums up several at once', () => {
    const list = [s('a', new Date(2026, 5, 1, 18), 2 * H), s('b', new Date(2026, 5, 20, 12), 4 * H)];
    const broken = recordsBrokenBy(list, 'b');
    expect(broken.length).toBeGreaterThan(1);
    const t = recordToast(broken, null);
    expect(t.title).toBe(`${broken.length} new personal records`);
    expect(t.body).toMatch(/^Marathon, Big day and Big week\./);
  });
});
