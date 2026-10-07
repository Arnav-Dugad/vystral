import { useEffect, useId, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, MinusCircle, RefreshCw, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { CompactionResult, CompactionStatus, SelfCheckOutcome, SelfCheckStatus } from '../../bridge/types';
import { compactionHint, compactionRatio, compactionToast, selfCheckHeadline, selfCheckHint, selfCheckTone } from '../../lib/maintenance';
import { useGameRunning, useStore } from '../../state/store';
import { Button, Toggle } from '../../components/ui/primitives';
import './maintenance.css';

const OUTCOME_ICON: Record<SelfCheckOutcome, typeof CheckCircle2> = { passed: CheckCircle2, failed: XCircle, skipped: MinusCircle };
const OUTCOME_LABEL: Record<SelfCheckOutcome, string> = { passed: 'Passed', failed: 'Failed', skipped: 'Not checked this time' };

/** Track AA: Settings → Updates → After-update check. */
export function SelfCheckSettings() {
  const [status, setStatus] = useState<SelfCheckStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const toast = useStore((s) => s.toast);
  const listId = useId();

  useEffect(() => {
    let live = true;
    call<SelfCheckStatus>('update.selfCheck.get').then((s) => live && setStatus(s)).catch(() => {});
    const off = on('selfcheck.done', (s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);

  const report = status?.latest ?? null;
  const tone = report ? selfCheckTone(report) : null;
  // A problem is shown, not hidden behind a disclosure.
  useEffect(() => {
    if (tone === 'danger') setOpen(true);
  }, [tone]);

  const runAgain = async () => {
    setRunning(true);
    try {
      const s = await call<SelfCheckStatus>('update.selfCheck.run', undefined, 90_000);
      setStatus(s);
      if (s.latest) toast({ tone: selfCheckTone(s.latest) === 'danger' ? 'warning' : 'success', title: selfCheckHeadline(s.latest) });
    } catch (err) {
      toast({ tone: 'danger', title: 'The check didn’t run', body: errorMessage(err) });
    } finally {
      setRunning(false);
    }
  };

  const busy = running || !!status?.running;
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : tone === 'danger' ? XCircle : ShieldCheck;

  return (
    <section className="sgroup" aria-labelledby="selfcheck-title" data-testid="selfcheck">
      <h2 className="sgroup__title" id="selfcheck-title">After-update check</h2>
      <p className="sgroup__desc">
        The first time a new version starts, VYSTRAL checks that it works on this PC: the database, the interface, artwork and settings. A real problem counts as a failed start, so a version that keeps failing goes back to the last one that worked. Being slow never does.
      </p>
      <div className="sgroup__rows surface upk">
        <div className="upk__head">
          <Icon size={20} className="upk__icon" data-tone={tone ?? 'none'} aria-hidden />
          <div className="upk__text" aria-live="polite">
            <div className="srow__label">{report ? selfCheckHeadline(report) : status ? 'Not checked yet' : 'Loading…'}</div>
            <div className="srow__hint">
              {report ? selfCheckHint(report, status!.currentVersion) : status ? 'It runs by itself the first time a new version starts. You can also run it now.' : ' '}
            </div>
          </div>
          <Button size="sm" icon={<RefreshCw size={14} />} loading={busy} onClick={() => void runAgain()} disabled={!status}>
            {report ? 'Check again' : 'Check now'}
          </Button>
        </div>
        {report && (
          <>
            <button type="button" className="upk__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
              <ChevronDown size={14} aria-hidden data-open={open} />
              {open ? 'Hide the checks' : 'Show the checks'}
            </button>
            {open && (
              <ul className="upk__checks" id={listId}>
                {report.checks.map((c, i) => {
                  const CIcon = OUTCOME_ICON[c.outcome];
                  return (
                    <li key={c.id} className="upk-check" data-outcome={c.outcome} style={{ animationDelay: `${i * 35}ms` }}>
                      <CIcon size={15} className="upk-check__icon" role="img" aria-label={OUTCOME_LABEL[c.outcome]} />
                      <div>
                        <div className="upk-check__label">{c.label}</div>
                        <div className="upk-check__detail">{c.detail}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** Track AA: Settings → Data & recovery → Database upkeep. */
export function CompactionSettings() {
  const [status, setStatus] = useState<CompactionStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const toast = useStore((s) => s.toast);
  const setSetting = useStore((s) => s.setSetting);
  const auto = useStore((s) => s.settings?.['data.autoCompact'] !== false);
  const gameRunning = useGameRunning();

  useEffect(() => {
    let live = true;
    call<CompactionStatus>('data.compaction.get').then((s) => live && setStatus(s)).catch(() => {});
    const off = on('data.compaction', (s) => setStatus(s));
    return () => {
      live = false;
      off();
    };
  }, []);

  const compact = async () => {
    setRunning(true);
    try {
      const r = await call<{ result: CompactionResult; status: CompactionStatus }>('data.compaction.run', undefined, 10 * 60_000);
      setStatus(r.status);
      toast(compactionToast(r.result));
      if (r.result.outcome === 'compacted') {
        setJustSaved(true);
        window.setTimeout(() => setJustSaved(false), 1600);
      }
    } catch (err) {
      toast({ tone: 'info', title: 'Not compacted', body: errorMessage(err) });
    } finally {
      setRunning(false);
    }
  };

  const ratio = status ? compactionRatio(status) : null;
  return (
    <section className="sgroup" aria-labelledby="compaction-title" data-testid="compaction">
      <h2 className="sgroup__title" id="compaction-title">Database upkeep</h2>
      <p className="sgroup__desc">
        About once a month, when your PC has been idle for a while and is plugged in, VYSTRAL compacts its database so it stays small and quick. Never while you play, and only with enough free space for a full copy.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <div className="srow__label">Compact the database</div>
            <div className="srow__hint upk__size" data-flash={justSaved || undefined} aria-live="polite">
              {status ? compactionHint(status) : '…'}
            </div>
            {ratio != null && (
              <div className="upk-bar" aria-hidden title="Size before and after the last compaction">
                <span className="upk-bar__after" style={{ width: `${Math.max(4, ratio * 100)}%` }} />
              </div>
            )}
          </div>
          <div className="srow__control">
            <Button
              size="sm"
              icon={<Sparkles size={14} />}
              loading={running || !!status?.running}
              disabled={!status || gameRunning}
              title={gameRunning ? 'Close your game first: VYSTRAL never compacts while you play.' : undefined}
              onClick={() => void compact()}
            >
              Compact now
            </Button>
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="data.autoCompact">Compact automatically</label>
            <div className="srow__hint">Monthly, after 10 idle minutes, on mains power, with no game running. Never in safe mode.</div>
          </div>
          <div className="srow__control">
            <Toggle id="data.autoCompact" label="Compact automatically" checked={auto} onChange={(v) => void setSetting('data.autoCompact', v)} />
          </div>
        </div>
      </div>
    </section>
  );
}
