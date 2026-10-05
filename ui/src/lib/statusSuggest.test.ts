import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { suggestStatus, type SuggestInput } from './statusSuggest';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 5, 12);

function inst(p: Partial<Installation> = {}): Installation {
  return {
    id: 'i', platform: 'steam', platformGameId: '1', title: 'G', state: 'installed', installPath: null, drive: null, sizeBytes: null,
    clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: null, userLaunchArgs: null, manualLink: false,
    lastSeen: '', ...p,
  };
}

function input(game: Partial<Pick<Game, 'status' | 'statusChangedAt' | 'installations' | 'trackedSeconds' | 'sessionCount'>>, daysAgo: number[] = []): SuggestInput {
  return {
    game: { id: 'g', status: null, installations: [inst()], trackedSeconds: daysAgo.length * 3600, sessionCount: daysAgo.length, ...game },
    sessionStarts: daysAgo.map((d) => NOW - d * DAY),
    now: NOW,
  };
}

describe('suggestStatus', () => {
  it('offers Playing after three sessions this week', () => {
    const s = suggestStatus(input({ status: null }, [0.2, 2, 6.5]));
    expect(s?.status).toBe('playing');
    expect(s?.text).toBe('You’ve played this 3 times this week — mark as Playing?');
  });

  it('counts only the last seven days', () => {
    expect(suggestStatus(input({ status: 'backlog' }, [1, 3, 8, 9]))).toBeNull();
  });

  it('offers Playing from Backlog and Abandoned, but never for finished or already-playing games', () => {
    const week = [1, 2, 3];
    expect(suggestStatus(input({ status: 'backlog' }, week))?.status).toBe('playing');
    expect(suggestStatus(input({ status: 'abandoned' }, week))?.status).toBe('playing');
    expect(suggestStatus(input({ status: 'beaten' }, week))).toBeNull();
    expect(suggestStatus(input({ status: 'completed' }, week))).toBeNull();
    expect(suggestStatus(input({ status: 'playing' }, week))).toBeNull();
  });

  it('ignores sessions in the future (clock skew)', () => {
    expect(suggestStatus(input({ status: null }, [-1, -2, 1]))).toBeNull();
  });

  it('suggests Backlog for a Playing game untouched for over 45 days', () => {
    const s = suggestStatus(input({ status: 'playing' }, [50, 80]));
    expect(s?.status).toBe('backlog');
    expect(s?.text).toBe('Not played in 7 weeks — move back to Backlog?');
  });

  it('does not second-guess a Playing mark you just made', () => {
    expect(suggestStatus(input({ status: 'playing', statusChangedAt: new Date(NOW - 2 * DAY).toISOString() }, [50, 80]))).toBeNull();
    expect(suggestStatus(input({ status: 'playing', statusChangedAt: new Date(NOW - 60 * DAY).toISOString() }, [50, 80]))?.status).toBe('backlog');
  });

  it('uses store last-played too, so recent store play keeps a game Playing', () => {
    const game = { status: 'playing' as const, installations: [inst({ importedLastPlayed: new Date(NOW - 3 * DAY).toISOString() })] };
    expect(suggestStatus(input(game, [90]))).toBeNull();
  });

  it('does not guess staleness without any evidence of play', () => {
    expect(suggestStatus(input({ status: 'playing' }, []))).toBeNull();
  });

  it('offers Backlog for installed games never played anywhere', () => {
    expect(suggestStatus(input({ status: null }))?.id).toBe('unstarted');
    expect(suggestStatus(input({ status: null, installations: [inst({ state: 'notinstalled' })] }))).toBeNull();
    expect(suggestStatus(input({ status: null, installations: [inst({ importedPlaytimeMinutes: 30 })] }))).toBeNull();
    expect(suggestStatus(input({ status: 'abandoned' }))).toBeNull();
  });

  it('uses words for small counts', () => {
    expect(suggestStatus(input({ status: null }, [1, 2, 3, 4]))?.text).toContain('4 times');
  });

  it('gives stable ids so dismissals stick until the situation changes', () => {
    const a = suggestStatus(input({ status: 'playing' }, [50]))!;
    const b = suggestStatus({ ...input({ status: 'playing' }, [50]), now: NOW + DAY })!;
    expect(a.id).toBe(b.id);
    expect(suggestStatus(input({ status: 'playing' }, [60]))!.id).not.toBe(a.id);
  });
});
