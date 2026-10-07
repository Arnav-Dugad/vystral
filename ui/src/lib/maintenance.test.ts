import { describe, expect, it } from 'vitest';
import type { CompactionStatus, SelfCheckReport } from '../bridge/types';
import { compactionHint, compactionRatio, compactionToast, selfCheckHeadline, selfCheckHint, selfCheckTone } from './maintenance';

const MB = 1024 * 1024;

function report(outcomes: ('passed' | 'failed' | 'skipped')[], manual = false, version = '0.7.0'): SelfCheckReport {
  const checks = outcomes.map((outcome, i) => ({ id: `c${i}`, label: `Check ${i}`, outcome, detail: '' }));
  return { version, at: '2026-10-07T10:42:00Z', manual, passed: outcomes.filter((o) => o === 'passed').length, total: outcomes.length, checks };
}

describe('self-check copy', () => {
  it('says how many passed', () => {
    expect(selfCheckHeadline(report(['passed', 'passed', 'passed', 'passed', 'passed', 'passed']))).toBe('0.7.0 passed 6 of 6 checks');
    expect(selfCheckHeadline(report(['passed', 'failed', 'passed', 'passed', 'passed', 'passed']))).toBe('0.7.0 passed 5 of 6 checks');
  });

  it('treats a late answer as a warning and a failure as a problem', () => {
    expect(selfCheckTone(report(['passed', 'passed']))).toBe('ok');
    expect(selfCheckTone(report(['passed', 'skipped']))).toBe('warn');
    expect(selfCheckTone(report(['skipped', 'failed']))).toBe('danger');
  });

  it('explains what a failure means, and that a Settings run never affects updates', () => {
    expect(selfCheckHint(report(['failed']), '0.7.0')).toContain('goes back to the last version that worked');
    expect(selfCheckHint(report(['failed'], true), '0.7.0')).toContain('never affects updates');
    expect(selfCheckHint(report(['skipped']), '0.7.0')).toContain('isn’t a failure');
    expect(selfCheckHint(report(['passed'], false, '0.6.0'), '0.7.0')).toContain('0.7.0 hasn’t been checked yet');
  });
});

describe('compaction copy', () => {
  const status = (over: Partial<CompactionStatus> = {}): CompactionStatus => ({
    sizeBytes: 48.2 * MB, running: false, autoEnabled: true, lastRun: { at: '2026-09-03T03:00:00Z', beforeBytes: 52.1 * MB, afterBytes: 48.2 * MB, durationMs: 900 },
    lastAttempt: null, nextDueAt: null, ...over,
  });

  it('shows the size now and the last before → after', () => {
    expect(compactionHint(status())).toMatch(/^48\.2 MB now · last compacted .*: 52\.1 MB → 48\.2 MB \(saved 3\.9 MB\)$/);
    expect(compactionHint(status({ lastRun: null }))).toBe('48.2 MB now · not compacted yet');
    expect(compactionHint(status({ lastRun: { at: '2026-09-03T03:00:00Z', beforeBytes: 10 * MB, afterBytes: 10 * MB - 1000, durationMs: 10 } }))).toContain('already compact');
  });

  it('turns a result into a calm toast', () => {
    expect(compactionToast({ outcome: 'compacted', reason: null, beforeBytes: 52.1 * MB, afterBytes: 48.2 * MB, durationMs: 1200 }).title).toBe('Database compacted · saved 3.9 MB');
    expect(compactionToast({ outcome: 'compacted', reason: null, beforeBytes: 10 * MB, afterBytes: 10 * MB, durationMs: 50 }).title).toBe('Database is already compact');
    expect(compactionToast({ outcome: 'busy', reason: 'retryLater', beforeBytes: 1, afterBytes: 1, durationMs: 5000 }).tone).toBe('info');
    expect(compactionToast({ outcome: 'failed', reason: 'retryLater', beforeBytes: 1, afterBytes: 1, durationMs: 1 }).body).toContain('unchanged');
  });

  it('draws the before/after sliver only when there is a last run', () => {
    expect(compactionRatio(status())).toBeCloseTo(48.2 / 52.1, 3);
    expect(compactionRatio(status({ lastRun: null }))).toBeNull();
  });
});
