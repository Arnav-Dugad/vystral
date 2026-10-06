import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Download, ExternalLink, LogOut, ShieldAlert, Trash2 } from 'lucide-react';
import { call, errorMessage, on } from '../../bridge/bridge';
import type { FpsCaptureStatus } from '../../bridge/types';
import { formatBytes } from '../../lib/format';
import { useStore } from '../../state/store';
import { Badge, Button, ProgressBar, Skeleton, Toggle } from '../../components/ui/primitives';
import './insights-settings.css';

type StepState = 'done' | 'todo' | 'pending';

/**
 * Settings › Launching & sessions › Frame-rate capture. Opt-in: explains exactly what will
 * happen, downloads Intel PresentMon from its official GitHub release, verifies it, and (only
 * on request) adds the account to Performance Log Users through one Windows prompt.
 */
export function FpsCaptureSettings() {
  const enabled = useStore((s) => s.settings?.['fps.captureEnabled'] ?? false);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<FpsCaptureStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'install' | 'remove' | 'grant' | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<FpsCaptureStatus>('fps.status'));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    return on('fps.install', (e) => {
      if (e.phase === 'downloading') setProgress(Math.round((e.progress ?? 0) * 100));
      else setProgress(null);
    });
  }, [refresh, enabled]);

  const install = async () => {
    setBusy('install');
    setProgress(0);
    try {
      setStatus(await call<FpsCaptureStatus>('fps.install', undefined, 180_000));
      toast({ tone: 'success', title: 'PresentMon is ready', body: 'Downloaded from GitHub and verified.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'PresentMon wasn’t installed', body: errorMessage(err) });
      void refresh();
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const remove = async () => {
    setBusy('remove');
    try {
      setStatus(await call<FpsCaptureStatus>('fps.remove'));
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t remove PresentMon', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const grant = async () => {
    setBusy('grant');
    try {
      const r = await call<{ status: 'added' | 'cancelled' | 'alreadyMember'; fps: FpsCaptureStatus }>('fps.grantPermission', undefined, 120_000);
      setStatus(r.fps);
      if (r.status === 'added') toast({ tone: 'success', title: 'Your account was added', body: 'Sign out of Windows and back in to finish. Frame-rate capture starts working after that.', sticky: true });
      else if (r.status === 'cancelled') toast({ tone: 'info', title: 'Nothing was changed', body: 'The Windows prompt was cancelled.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Permission wasn’t added', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const openLink = (url: string) => void call('app.openExternal', { url }).catch(() => {});

  if (loadError && !status) {
    return (
      <section className="sgroup">
        <h2 className="sgroup__title">Frame-rate capture</h2>
        <p className="sgroup__desc" role="alert">Couldn’t read frame-rate capture status: {loadError}</p>
      </section>
    );
  }

  const s = status;
  const installState: StepState = s?.installed ? 'done' : busy === 'install' ? 'pending' : 'todo';
  const permState: StepState = s?.permission === 'granted' ? 'done' : s?.permission === 'signOutRequired' ? 'pending' : 'todo';

  return (
    <section className="sgroup" aria-labelledby="fps-capture-title">
      <h2 id="fps-capture-title" className="sgroup__title">
        Frame-rate capture <Badge>Optional</Badge>
      </h2>
      <p className="sgroup__desc">
        Measure real FPS, 1% lows and frame times for games you launch from VYSTRAL, using Intel’s open-source PresentMon. It isn’t part of the
        installer. Here is exactly what turning it on involves:
      </p>
      <div className="sgroup__rows surface fpsx">
        {!s ? (
          <div className="srow"><Skeleton height={64} radius={12} width="100%" /></div>
        ) : (
          <>
            <Step
              n={1}
              state={installState}
              title={`Download PresentMon ${s.version}`}
              body={
                <>
                  About {formatBytes(s.sizeBytes)} from the official GitHub release (MIT licence), saved to VYSTRAL’s data folder. VYSTRAL checks the
                  file’s SHA-256 fingerprint before every use and refuses to run anything else.
                  {s.localOnly && <strong className="fpsx__warn"> Offline mode is on, so downloads are blocked.</strong>}
                </>
              }
              action={
                s.installed ? (
                  <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} loading={busy === 'remove'} disabled={!!busy} onClick={() => void remove()}>
                    Remove
                  </Button>
                ) : (
                  <Button size="sm" variant="primary" icon={<Download size={14} />} loading={busy === 'install'} disabled={!!busy || s.localOnly} onClick={() => void install()}>
                    Download &amp; verify
                  </Button>
                )
              }
            >
              {progress != null && <ProgressBar value={progress} label="Downloading PresentMon" />}
            </Step>

            <Step
              n={2}
              state={permState}
              title="Allow performance tracing"
              body={
                s.permission === 'granted' ? (
                  <>Your Windows account can read the frame events PresentMon uses.</>
                ) : s.permission === 'signOutRequired' ? (
                  <>Your account was added to <q>{s.groupName}</q>. <strong>Sign out of Windows and back in</strong> once — Windows applies group changes only at sign-in.</>
                ) : (
                  <>
                    Windows lets only administrators and members of the <q>{s.groupName}</q> group read these events. VYSTRAL can add your account
                    {s.account ? <> (<span className="num">{s.account}</span>)</> : null} by running Windows’ own{' '}
                    <code>net localgroup "{s.groupName}" … /add</code>. You’ll see one Windows prompt, and you’ll need to sign out and back in once.
                    This is the only thing in VYSTRAL that asks for administrator approval.
                  </>
                )
              }
              action={
                s.permission === 'missing' ? (
                  <Button size="sm" icon={<ShieldAlert size={14} />} loading={busy === 'grant'} disabled={!!busy} onClick={() => void grant()}>
                    Add my account…
                  </Button>
                ) : s.permission === 'signOutRequired' ? (
                  <Badge tone="warn" icon={<LogOut size={12} />}>Sign out needed</Badge>
                ) : (
                  <Badge tone="ok" icon={<CheckCircle2 size={12} />}>Allowed</Badge>
                )
              }
            />

            <div className="srow">
              <div className="srow__text">
                <label className="srow__label" htmlFor="fps-capture-toggle">Measure frame rate during games</label>
                <div className="srow__hint">
                  PresentMon runs only while a game you started from VYSTRAL is running, watches that game’s presented frames, and stops when the
                  session ends. Nothing is injected into the game and no settings change.
                  {enabled && !s.ready && <span className="fpsx__warn"> Finish the steps above first — until then FPS is shown as “not measured”.</span>}
                </div>
              </div>
              <div className="srow__control">
                <Toggle id="fps-capture-toggle" label="Measure frame rate during games" checked={enabled} disabled={!s.installed && !enabled} onChange={(v) => void setSetting('fps.captureEnabled', v)} />
              </div>
            </div>

            <details className="fpsx__details">
              <summary>Technical details</summary>
              <dl>
                <dt>Source</dt>
                <dd><span className="fpsx__mono">{s.sourceUrl}</span></dd>
                <dt>SHA-256</dt>
                <dd><span className="fpsx__mono">{s.sha256}</span></dd>
                <dt>Saved to</dt>
                <dd><span className="fpsx__mono">{s.installPath}</span></dd>
                <dt>Measures</dt>
                <dd>Time between presented frames (MsBetweenPresents). 1% / 0.1% lows are the average frame rate of the slowest 1% / 0.1% of frames.</dd>
              </dl>
              <div className="fpsx__links">
                <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => openLink(s.releasePage)}>Release page</Button>
                <Button size="sm" variant="ghost" icon={<ExternalLink size={14} />} onClick={() => openLink(s.licenseUrl)}>Licence</Button>
              </div>
            </details>
          </>
        )}
      </div>
    </section>
  );
}

function Step({ n, state, title, body, action, children }: { n: number; state: StepState; title: string; body: ReactNode; action: ReactNode; children?: ReactNode }) {
  const icon = state === 'done' ? <CheckCircle2 size={18} /> : <span className="fpsx__num num">{n}</span>;
  const word = state === 'done' ? 'Done' : state === 'pending' ? 'In progress' : 'To do';
  return (
    <div className="srow fpsx__step" data-state={state}>
      <span className="fpsx__badge" aria-hidden>{icon}</span>
      <div className="srow__text">
        <div className="srow__label">
          <span className="visually-hidden">Step {n}, {word}: </span>
          {title}
        </div>
        <div className="srow__hint">{body}</div>
        {children}
      </div>
      <div className="srow__control">{action}</div>
    </div>
  );
}
