/**
 * Track AA preview: the first-paint snapshot, the after-update self-check and database compaction, with
 * fictional numbers (the preview has no database). URL switches:
 *   ?firstpaint         read the saved Home snapshot on start (the app always does); saving always works
 *   ?slowLibrary=1500   delay the live library by that many ms (shows the cached first paint first)
 *   ?selfCheckFail      the after-update check reports a failed artwork-cache check
 *   ?selfCheckNone      no check has run yet
 *   ?compactBusy        "Compact now" finds the database busy
 * The self-check really round-trips: after app.ready the preview sends `selfcheck.ping` and the bridge
 * check passes only if the interface echoes it back unchanged.
 */
import type { CompactionResult, CompactionStatus, SelfCheckItem, SelfCheckStatus, Settings } from './types';
import { BridgeError } from './bridge';
import { PREVIEW_KEY } from '../lib/firstPaint';
import { PREVIEW_VERSION } from './preview.updates';

type Emit = (name: string, payload: unknown) => void;

export const MAINTENANCE_DEFAULT_SETTINGS: Pick<Settings, 'data.autoCompact'> = { 'data.autoCompact': true };

const PROBE = 'VYSTRAL ✓ “quotes” <b>&amp;</b> Ünïcødé 日本語 🎮 \u2028 end';
const MB = 1024 * 1024;

export function maintenancePreviewHandlers(ctx: { emit: () => Emit; settings: () => Settings; timers: number[] }) {
  const params = new URLSearchParams(location.search);
  const failArt = params.has('selfCheckFail');
  let bridgeEcho: 'pending' | 'ok' | 'wrong' = 'pending';
  let nonce = '';
  let report: SelfCheckStatus['latest'] = null;
  let running = false;

  const checks = (): SelfCheckItem[] => [
    { id: 'database', label: 'Library database opens and is up to date', outcome: 'passed', detail: 'Schema version 7.' },
    { id: 'integrity', label: 'Database integrity check', outcome: 'passed', detail: 'No problems found.' },
    bridgeEcho === 'ok'
      ? { id: 'bridge', label: 'Interface and VYSTRAL talk to each other', outcome: 'passed', detail: 'A message went to the interface and came back unchanged.' }
      : bridgeEcho === 'wrong'
        ? { id: 'bridge', label: 'Interface and VYSTRAL talk to each other', outcome: 'failed', detail: 'A message came back changed.' }
        : { id: 'bridge', label: 'Interface and VYSTRAL talk to each other', outcome: 'skipped', detail: 'The interface didn’t answer in time (it may have been busy).' },
    { id: 'uiReady', label: 'Interface finished starting', outcome: 'passed', detail: 'Ready 0.8 s after VYSTRAL started.' },
    failArt
      ? { id: 'artCache', label: 'Artwork cache readable', outcome: 'failed', detail: 'The artwork folder can’t be used (UnauthorizedAccessException). Covers fall back to generated ones.' }
      : { id: 'artCache', label: 'Artwork cache readable', outcome: 'passed', detail: 'Covers can be read and saved.' },
    { id: 'settings', label: 'Settings load', outcome: 'passed', detail: '81 settings read.' },
  ];
  const finish = (manual: boolean) => {
    const list = checks();
    report = { version: PREVIEW_VERSION, at: new Date().toISOString(), manual, passed: list.filter((c) => c.outcome === 'passed').length, total: list.length, checks: list };
    running = false;
    ctx.emit()('selfcheck.done', status());
  };
  const status = (): SelfCheckStatus => ({ running, currentVersion: PREVIEW_VERSION, latest: report });
  const ping = () => {
    nonce = Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
    bridgeEcho = 'pending';
    ctx.emit()('selfcheck.ping', { nonce, probe: PROBE });
  };

  // Fictional database: a 52.1 MB file that compacts to 48.2 MB, last compacted 34 days ago.
  let sizeBytes = Math.round(52.1 * MB);
  let lastRun: CompactionStatus['lastRun'] = { at: new Date(Date.now() - 34 * 86_400_000).toISOString(), beforeBytes: Math.round(55.4 * MB), afterBytes: Math.round(49.0 * MB), durationMs: 640 };
  let compacting = false;
  const compaction = (): CompactionStatus => ({
    sizeBytes, running: compacting, autoEnabled: ctx.settings()['data.autoCompact'] !== false, lastRun,
    lastAttempt: lastRun ? { at: lastRun.at, outcome: 'compacted' } : null,
    nextDueAt: lastRun ? new Date(Date.parse(lastRun.at) + 30 * 86_400_000).toISOString() : null,
  });

  return {
    'app.firstPaint.save': (p: { snapshot: unknown }) => {
      try {
        localStorage.setItem(PREVIEW_KEY, JSON.stringify(p.snapshot));
      } catch {
        return false;
      }
      return true;
    },
    'app.firstPaint.clear': () => {
      try {
        localStorage.removeItem(PREVIEW_KEY);
      } catch {
        // storage unavailable
      }
      return true;
    },
    'app.startupMarks': () => true,
    'app.ready': () => {
      // The automatic after-update check, as in the app: shortly after the interface is ready.
      if (!params.has('selfCheckNone') && !report) {
        running = true;
        ping();
        ctx.timers.push(window.setTimeout(() => finish(false), 700));
      }
      return true;
    },
    'update.selfCheck.get': () => status(),
    'update.selfCheck.run': async () => {
      if (running) throw new BridgeError('busy', 'The check is already running.');
      running = true;
      ping();
      await new Promise((r) => setTimeout(r, 900));
      finish(true);
      return status();
    },
    'update.selfCheck.echo': (p: { nonce: string; probe: string }) => {
      if (p?.nonce === nonce) bridgeEcho = p.probe === PROBE ? 'ok' : 'wrong';
      return true;
    },
    'data.compaction.get': () => compaction(),
    'data.compaction.run': async (): Promise<{ result: CompactionResult; status: CompactionStatus }> => {
      if (compacting) throw new BridgeError('busy', 'Compaction is already running.');
      compacting = true;
      await new Promise((r) => setTimeout(r, 1200));
      compacting = false;
      if (params.has('compactBusy')) {
        return { result: { outcome: 'busy', reason: 'retryLater', beforeBytes: sizeBytes, afterBytes: sizeBytes, durationMs: 5000 }, status: compaction() };
      }
      const before = sizeBytes;
      sizeBytes = Math.round(sizeBytes * 0.925);
      lastRun = { at: new Date().toISOString(), beforeBytes: before, afterBytes: sizeBytes, durationMs: 1180 };
      return { result: { outcome: 'compacted', reason: null, beforeBytes: before, afterBytes: sizeBytes, durationMs: 1180 }, status: compaction() };
    },
  };
}
