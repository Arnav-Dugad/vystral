import { useEffect, useState } from 'react';
import { ArrowDownToLine, CheckCircle2, CircleAlert, RefreshCw, Rocket, Sparkles } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { UpdateState } from '../../bridge/types';
import { formatBytes, formatRelative } from '../../lib/format';
import { useStore } from '../../state/store';
import { Dialog } from '../ui/Dialog';
import { Button, ProgressBar } from '../ui/primitives';
import { RichText } from '../../views/assistant/RichText';

const OPEN_EVENT = 'vystral:open-updates';
export const openUpdateCenter = () => window.dispatchEvent(new CustomEvent(OPEN_EVENT));

/** Compact title-bar indicator. Only visible when there is something to say. */
export function UpdatePill() {
  const update = useStore((s) => s.update);
  if (!update || !['available', 'downloading', 'ready', 'applying'].includes(update.phase)) return null;
  const label =
    update.phase === 'downloading' ? `Updating ${update.progress}%` : update.phase === 'ready' ? 'Restart to update' : update.phase === 'applying' ? 'Installing…' : `Update ${update.newVersion}`;
  return (
    <button className="update-pill" onClick={openUpdateCenter} aria-label={`${label}. Open update details`}>
      {update.phase === 'downloading' ? (
        <span className="update-pill__ring" style={{ ['--p' as string]: update.progress }} aria-hidden />
      ) : update.phase === 'ready' ? (
        <Rocket size={14} aria-hidden />
      ) : (
        <ArrowDownToLine size={14} aria-hidden />
      )}
      {label}
    </button>
  );
}

export function UpdateCenterDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const h = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, h);
    return () => window.removeEventListener(OPEN_EVENT, h);
  }, []);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} title="Updates" wide>
      <UpdatePanel />
    </Dialog>
  );
}

const STEPS = ['Check', 'Download', 'Verify', 'Restart'] as const;

function stepState(u: UpdateState, i: number): 'done' | 'active' | 'todo' {
  const at = u.phase === 'checking' ? 0 : u.phase === 'downloading' ? 1 : u.phase === 'ready' ? 3 : u.phase === 'applying' ? 3 : u.phase === 'available' ? 1 : 0;
  const done = u.phase === 'ready' ? 3 : u.phase === 'applying' ? 4 : u.phase === 'available' || u.phase === 'downloading' ? 1 : u.phase === 'upToDate' ? 1 : 0;
  if (i < done) return 'done';
  if (i === at && u.phase !== 'upToDate' && u.phase !== 'idle') return 'active';
  return 'todo';
}

/** The update progress viewer. Also embedded in Settings → Updates. */
export function UpdatePanel() {
  const update = useStore((s) => s.update);
  const toast = useStore((s) => s.toast);
  const gameRunning = useStore((s) => s.launch?.phase === 'running');
  const [busy, setBusy] = useState(false);
  if (!update) return null;

  const act = async (method: string) => {
    setBusy(true);
    try {
      const state = await call<UpdateState>(method, undefined, 15 * 60_000);
      useStore.setState({ update: state });
    } catch (err) {
      toast({ tone: 'danger', title: 'Update problem', body: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const eta =
    update.phase === 'downloading' && update.bytesPerSecond && update.totalBytes
      ? Math.max(1, Math.round(((100 - update.progress) / 100) * update.totalBytes / update.bytesPerSecond))
      : null;

  const icon =
    update.phase === 'ready' ? <Rocket size={24} /> :
    update.phase === 'error' ? <CircleAlert size={24} /> :
    update.phase === 'upToDate' ? <CheckCircle2 size={24} /> :
    update.phase === 'available' || update.phase === 'downloading' ? <Sparkles size={24} /> : <RefreshCw size={24} />;

  const headline =
    update.phase === 'unavailable' ? 'Updates are managed by the installer' :
    update.phase === 'checking' ? 'Checking for updates…' :
    update.phase === 'upToDate' ? 'You’re up to date' :
    update.phase === 'available' ? `VYSTRAL ${update.newVersion} is available` :
    update.phase === 'downloading' ? `Downloading VYSTRAL ${update.newVersion}` :
    update.phase === 'ready' ? `VYSTRAL ${update.newVersion} is ready to install` :
    update.phase === 'applying' ? 'Installing and restarting…' :
    update.phase === 'error' ? 'Update didn’t complete' : 'Updates';

  return (
    <div className="update-panel" aria-live="polite">
      <div className="update-panel__head">
        <div className="update-panel__badge">{icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 620, letterSpacing: '-0.01em' }}>{headline}</div>
          <div style={{ color: 'var(--text-3)', fontSize: 'var(--fs-sm)' }}>
            Installed version <span className="num">{update.currentVersion}</span>
            {update.checkedAt && <> · Last checked {formatRelative(update.checkedAt)}</>}
          </div>
        </div>
      </div>

      {update.phase !== 'unavailable' && (
        <div className="update-steps" aria-label="Update progress steps">
          {STEPS.map((s, i) => (
            <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}>
              <span className="update-steps__dot" data-state={stepState(update, i)} />
              {s}
            </span>
          ))}
        </div>
      )}

      {(update.phase === 'downloading' || update.phase === 'ready' || update.phase === 'applying') && (
        <div style={{ display: 'grid', gap: 10 }}>
          <ProgressBar value={update.phase === 'downloading' ? update.progress : 100} label="Update download progress" indeterminate={update.phase === 'applying'} />
          <div className="update-panel__stats">
            <span className="num">{update.progress}%</span>
            {update.totalBytes != null && <span>{formatBytes((update.totalBytes * update.progress) / 100)} of {formatBytes(update.totalBytes)}</span>}
            {update.bytesPerSecond != null && update.phase === 'downloading' && <span>{formatBytes(update.bytesPerSecond)}/s</span>}
            {eta != null && <span>About {eta < 60 ? `${eta}s` : `${Math.ceil(eta / 60)} min`} left</span>}
          </div>
        </div>
      )}

      {update.message && <p style={{ color: update.phase === 'error' ? 'var(--warn)' : 'var(--text-2)' }}>{update.message}</p>}

      {update.notes && (update.phase === 'available' || update.phase === 'downloading' || update.phase === 'ready') && (
        <div>
          <div className="caps" style={{ marginBottom: 8 }}>What’s new</div>
          <div className="update-panel__notes selectable"><RichText text={update.notes} /></div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(update.phase === 'idle' || update.phase === 'upToDate' || update.phase === 'error') && (
          <Button variant="primary" icon={<RefreshCw size={16} />} loading={busy} onClick={() => act('update.check')}>
            Check for updates
          </Button>
        )}
        {update.phase === 'available' && (
          <Button variant="primary" icon={<ArrowDownToLine size={16} />} loading={busy} onClick={() => act('update.download')} disabled={gameRunning}>
            Download {update.totalBytes ? `(${formatBytes(update.totalBytes)}${update.delta ? ', changes only' : ''})` : ''}
          </Button>
        )}
        {update.phase === 'downloading' && (
          <Button variant="secondary" onClick={() => act('update.cancel')}>
            Cancel download
          </Button>
        )}
        {update.phase === 'ready' && (
          <Button variant="primary" icon={<Rocket size={16} />} onClick={() => act('update.apply')} disabled={gameRunning}>
            Restart and install
          </Button>
        )}
        <Button variant="ghost" onClick={() => void call('update.openReleases').catch(() => {})}>
          Release history on GitHub
        </Button>
      </div>
      {gameRunning && (update.phase === 'available' || update.phase === 'ready') && (
        <p style={{ color: 'var(--text-3)', fontSize: 'var(--fs-sm)' }}>Updates wait until your game closes.</p>
      )}
      <p style={{ color: 'var(--text-3)', fontSize: 'var(--fs-xs)' }}>
        Updates come from the official VYSTRAL GitHub releases. Each package is checked against its published hash before it is installed. Your library, settings and history are kept.
      </p>
    </div>
  );
}
