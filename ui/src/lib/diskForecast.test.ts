import { describe, expect, it } from 'vitest';
import type { DiskForecast, DriveForecast, Game, PendingUpdate } from '../bridge/types';
import { barSegments, chipText, fitSentence, updateForGame, warningCopy, warningDrives, warningKey } from './diskForecast';

const GB = 1024 ** 3;
const u = (appId: string, need: number | null, patch: Partial<PendingUpdate> = {}): PendingUpdate => ({
  appId, gameId: `g${appId}`, name: `Game ${appId}`, kind: 'update', phase: 'queued', needBytes: need, downloadRemaining: 0, stageRemaining: 0,
  sizeOnDisk: 0, fit: 'ok', whenLaunched: false, scheduledAt: null, lastResult: null, ...patch,
});
const drive = (free: number, updates: PendingUpdate[], patch: Partial<DriveForecast> = {}): DriveForecast => {
  const need = updates.reduce((s, x) => s + (x.needBytes ?? 0), 0);
  const after = free - need;
  return { drive: 'D:', label: 'Games', freeBytes: free, totalBytes: 1000 * GB, needBytes: need, afterBytes: after, tightBelowBytes: 50 * GB,
    status: after < 0 ? 'short' : after < 50 * GB ? 'tight' : 'ok', updates, ...patch };
};
const games = new Map<string, Game>([['g1', { id: 'g1', title: 'Nebula Drift' } as Game]]);

describe('chip', () => {
  it('reads like the spec', () => {
    const d = drive(9.1 * GB, [u('1', 23.4 * GB, { fit: 'short' })]);
    expect(chipText(d.updates[0], d)).toBe('Next update needs 23.4 GB · 9.1 GB free on D:');
    expect(fitSentence(d.updates[0], d)).toBe('It won’t fit: D: needs about 14.3 GB more free space.');
  });

  it('covers installs, unknown sizes and finishing updates', () => {
    const d = drive(100 * GB, []);
    expect(chipText(u('1', 5 * GB, { kind: 'install' }), d)).toBe('Install needs 5.0 GB · 100 GB free on D:');
    expect(chipText(u('1', null), d)).toBe('Next update pending · 100 GB free on D:');
    expect(chipText(u('1', 0), d)).toBe('Next update is finishing · 100 GB free on D:');
    expect(fitSentence(u('1', null, { fit: 'unknown' }), d)).toBe('Steam hasn’t worked out how big it is yet.');
  });

  it('finds a game’s update across drives', () => {
    const f: DiskForecast = { available: true, status: 'ok', scannedAt: '', pendingCount: 2, drives: [drive(100 * GB, [u('1', GB)]), { ...drive(100 * GB, [u('2', GB)]), drive: 'E:' }] };
    expect(updateForGame(f, 'g2')?.drive.drive).toBe('E:');
    expect(updateForGame(f, 'nope')).toBeNull();
    expect(updateForGame(null, 'g1')).toBeNull();
  });
});

describe('warnings', () => {
  it('lists only drives that need attention, worst first', () => {
    const ok = { ...drive(900 * GB, [u('1', GB)]), drive: 'C:' };
    const tight = { ...drive(60 * GB, [u('2', 20 * GB)]), drive: 'E:' };
    const short = drive(5 * GB, [u('3', 20 * GB)]);
    const f: DiskForecast = { available: true, status: 'short', scannedAt: '', pendingCount: 3, drives: [ok, tight, short] };
    expect(warningDrives(f).map((d) => d.drive)).toEqual(['D:', 'E:']);
    expect(warningKey(warningDrives(f))).toBe('D::short:3|E::tight:2');
  });

  it('writes plain-language copy', () => {
    const one = drive(9.1 * GB, [u('1', 23.4 * GB)]);
    expect(warningCopy(one, games)).toEqual({
      title: 'Nebula Drift’s next update won’t fit on D:',
      body: 'It needs 23.4 GB and D: has 9.1 GB free. Free up about 14.3 GB before Steam starts it.',
    });
    const two = drive(9 * GB, [u('1', 6 * GB), u('2', 6 * GB)]);
    expect(warningCopy(two, games).title).toBe('2 updates won’t fit on D:');
    const tight = drive(30 * GB, [u('1', 10 * GB)]);
    expect(warningCopy(tight, games)).toEqual({ title: 'D: will be nearly full after Nebula Drift’s update', body: 'It needs 10.0 GB, leaving 20.0 GB free (2% of the drive).' });
  });
});

describe('stacked bar', () => {
  const sum = (xs: { fraction: number }[]) => xs.reduce((s, x) => s + x.fraction, 0);

  it('is zoomed to today’s free space when everything fits', () => {
    const { segments, tightAt, domain } = barSegments(drive(400 * GB, [u('1', 100 * GB), u('2', 50 * GB)]));
    expect(segments.map((s) => s.kind)).toEqual(['update', 'update', 'free']);
    expect(segments.map((s) => s.fraction)).toEqual([0.25, 0.125, 0.625]);
    expect(domain).toBe(400 * GB);
    expect(tightAt).toBeCloseTo(350 / 400, 6);
  });

  it('marks the part that doesn’t fit and widens to everything the updates need', () => {
    const { segments, domain } = barSegments(drive(10 * GB, [u('1', 8 * GB), u('2', 12 * GB)]), games);
    expect(segments.map((s) => s.kind)).toEqual(['update', 'update', 'over']);
    expect(segments[0].label).toBe('Nebula Drift 8.0 GB');
    expect(segments[2].label).toBe('Game 2: 10.0 GB more than fits');
    expect(domain).toBe(20 * GB);
    expect(sum(segments)).toBeCloseTo(1, 6);
  });

  it('skips unknown sizes', () => {
    const { segments } = barSegments(drive(100 * GB, [u('1', null)]));
    expect(segments.map((s) => s.kind)).toEqual(['free']);
  });
});
