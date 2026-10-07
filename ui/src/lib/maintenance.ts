// Track AA: the words Settings uses for the after-update self-check and database compaction (pure, tested).
import type { CompactionResult, CompactionStatus, SelfCheckReport } from '../bridge/types';
import { formatBytes, formatDate } from './format';

export type SelfCheckTone = 'ok' | 'warn' | 'danger';

/** "0.7.0 passed 6 of 6 checks". */
export function selfCheckHeadline(r: SelfCheckReport): string {
  return `${r.version} passed ${r.passed} of ${r.total} ${r.total === 1 ? 'check' : 'checks'}`;
}

/** All passed: ok. Only skipped ones (an answer that came late): warn. Anything failed: danger. */
export function selfCheckTone(r: SelfCheckReport): SelfCheckTone {
  if (r.checks.some((c) => c.outcome === 'failed')) return 'danger';
  if (r.checks.some((c) => c.outcome === 'skipped')) return 'warn';
  return 'ok';
}

/** The line under the headline: when, how, and what a failure means. */
export function selfCheckHint(r: SelfCheckReport, currentVersion: string): string {
  const when = formatDate(r.at, { dateStyle: 'medium', timeStyle: 'short' });
  const how = r.manual ? 'checked from Settings' : 'checked automatically after the update';
  const older = r.version !== currentVersion ? ` · from ${r.version}; ${currentVersion} hasn’t been checked yet` : '';
  const tone = selfCheckTone(r);
  const note =
    tone === 'danger'
      ? r.manual
        ? ' · a check from Settings never affects updates'
        : ' · if this keeps happening, VYSTRAL goes back to the last version that worked'
      : tone === 'warn'
        ? ' · a slow answer isn’t a failure; it’s checked again next time'
        : '';
  return `${when} · ${how}${older}${note}`;
}

const SMALL_SAVING = 64 * 1024;

/** "52.1 MB now · last compacted 3 Sep 2026: 55.4 MB → 49.0 MB (saved 6.4 MB)". */
export function compactionHint(s: CompactionStatus): string {
  const now = `${formatBytes(s.sizeBytes)} now`;
  if (!s.lastRun) return `${now} · not compacted yet`;
  const saved = s.lastRun.beforeBytes - s.lastRun.afterBytes;
  const when = formatDate(s.lastRun.at, { dateStyle: 'medium' });
  const result = saved >= SMALL_SAVING
    ? `${formatBytes(s.lastRun.beforeBytes)} → ${formatBytes(s.lastRun.afterBytes)} (saved ${formatBytes(saved)})`
    : `${formatBytes(s.lastRun.afterBytes)}, already compact`;
  return `${now} · last compacted ${when}: ${result}`;
}

/** The toast after "Compact now". */
export function compactionToast(r: CompactionResult): { tone: 'success' | 'info' | 'warning'; title: string; body?: string } {
  if (r.outcome === 'compacted') {
    const saved = r.beforeBytes - r.afterBytes;
    return saved >= SMALL_SAVING
      ? { tone: 'success', title: `Database compacted · saved ${formatBytes(saved)}`, body: `${formatBytes(r.beforeBytes)} → ${formatBytes(r.afterBytes)} in ${(r.durationMs / 1000).toFixed(1)} s.` }
      : { tone: 'success', title: 'Database is already compact', body: `${formatBytes(r.afterBytes)}. Nothing worth reclaiming right now.` };
  }
  if (r.outcome === 'busy') return { tone: 'info', title: 'The database was busy', body: 'Something else was using it, so nothing changed. VYSTRAL will try again later.' };
  return { tone: 'warning', title: 'Couldn’t compact the database', body: 'Your database is unchanged. The details are in the log.' };
}

/** Share of the bar the "after" size takes (0–1), for the before/after sliver. */
export function compactionRatio(s: CompactionStatus): number | null {
  if (!s.lastRun || s.lastRun.beforeBytes <= 0) return null;
  return Math.max(0, Math.min(1, s.lastRun.afterBytes / s.lastRun.beforeBytes));
}
