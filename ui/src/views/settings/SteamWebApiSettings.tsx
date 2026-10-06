import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CloudOff, ExternalLink, KeyRound, Lock, RefreshCw, Unplug } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { SteamActionResult, SteamApiStatus, SteamTestResult } from '../../bridge/types';
import { formatRelative } from '../../lib/format';
import { useStore } from '../../state/store';
import { Badge, Button, Skeleton, Toggle } from '../../components/ui/primitives';
import { HoldToConfirm } from '../../components/controller/HoldToConfirm';
import { Dialog } from '../../components/ui/Dialog';
import './steam-web-api.css';

const KEY_PAGE = 'https://steamcommunity.com/dev/apikey';
const KEY_RE = /^[0-9a-fA-F]{32}$/;

/** Settings → Library & stores → Steam Web API (opt-in). The key never reaches the page. */
export function SteamWebApiSettings() {
  const localOnly = useStore((s) => s.settings?.['privacy.localOnly'] ?? false);
  const background = useStore((s) => s.settings?.['steam.webApi.backgroundAchievements'] ?? true);
  const friends = useStore((s) => s.settings?.['home.friendsActivity'] ?? false); // Track P
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<SteamApiStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'test' | 'sync' | 'account' | 'disconnect' | null>(null);
  const [result, setResult] = useState<SteamTestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await call<SteamApiStatus>('steam.status');
      setStatus(s);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => void refresh(), [refresh, localOnly]);

  const run = async (kind: NonNullable<typeof busy>, method: string, params?: unknown) => {
    setBusy(kind);
    try {
      const r = await call<SteamActionResult>(method, params, 120_000);
      setStatus(r.status);
      setResult(r.result);
      return r;
    } catch (err) {
      toast({ tone: 'danger', title: 'Steam Web API', body: errorMessage(err) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const selectAccount = async (steamId: string) => {
    setBusy('account');
    try {
      setStatus(await call<SteamApiStatus>('steam.selectAccount', { steamId }));
      setBusy(null);
      if (status?.configured) await run('sync', 'steam.sync');
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t switch account', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setConfirmDisconnect(false);
    setBusy('disconnect');
    try {
      setStatus(await call<SteamApiStatus>('steam.disconnect'));
      setResult(null);
      toast({ tone: 'success', title: 'Steam Web API disconnected', body: 'The key was removed from Windows Credential Manager.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Couldn’t disconnect', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const shown = result ?? status?.lastTest ?? null;

  return (
    <section className="sgroup steamapi" aria-labelledby="steamapi-title">
      <h2 className="sgroup__title" id="steamapi-title">
        Steam Web API <Badge>Optional</Badge>
      </h2>
      <p className="sgroup__desc">
        With your own free key, VYSTRAL can list Steam games you own but haven’t installed, and show your achievements with how rare they are.
        Everything else in VYSTRAL works without it.
      </p>
      <div className="sgroup__rows surface">
        {localOnly && (
          <div className="srow steamapi__notice" role="status">
            <CloudOff size={18} aria-hidden />
            <div className="srow__text">
              <div className="srow__label">Offline mode is on</div>
              <div className="srow__hint">The Steam Web API is paused, and nothing is sent to Steam. Turn off offline mode in Privacy to use it.</div>
            </div>
          </div>
        )}
        {!status && !loadError && (
          <div className="srow"><Skeleton height={48} /></div>
        )}
        {loadError && (
          <div className="srow steamapi__notice" role="alert">
            <AlertTriangle size={18} aria-hidden />
            <div className="srow__text"><div className="srow__hint">{loadError}</div></div>
            <Button size="sm" onClick={() => void refresh()}>Retry</Button>
          </div>
        )}
        {status && !status.configured && (
          <ConnectForm status={status} disabled={localOnly} busy={busy === 'connect'} onAccount={selectAccount} onConnect={(key, steamId) => run('connect', 'steam.connect', { key, steamId })} />
        )}
        {status?.configured && (
          <>
            <Row
              label="Key"
              hint={<>Stored in Windows Credential Manager on this PC · <span className="num">{status.keyMasked}</span></>}
              control={
                <div className="steamapi__actions">
                  <Button size="sm" loading={busy === 'test'} disabled={localOnly || !!busy} icon={<RefreshCw size={14} />} onClick={() => void run('test', 'steam.test')}>Test</Button>
                  <Button size="sm" variant="ghost" loading={busy === 'disconnect'} disabled={!!busy} icon={<Unplug size={14} />} onClick={() => setConfirmDisconnect(true)}>Disconnect</Button>
                </div>
              }
            />
            <Row
              label="Steam account"
              hint="Accounts that have signed in to Steam on this PC."
              control={<AccountPicker status={status} disabled={localOnly || !!busy} onChange={(id) => void selectAccount(id)} />}
            />
            <Row
              label="Owned games"
              hint={status.lastSync ? `${status.ownedCount.toLocaleString()} on this account · synced ${formatRelative(status.lastSync).toLowerCase()}` : 'Not synced yet'}
              control={<Button size="sm" loading={busy === 'sync' || status.syncing} disabled={localOnly || !!busy} onClick={() => void run('sync', 'steam.sync')}>Sync now</Button>}
            />
            <Row
              id="steamapi-bg"
              label="Refresh achievements in the background"
              hint="After a sync, slowly refreshes achievements for games you’ve played (at most once every six hours each, paused while you play)."
              control={<Toggle id="steamapi-bg" label="Refresh achievements in the background" checked={background} disabled={localOnly} onChange={(v) => void setSetting('steam.webApi.backgroundAchievements', v)} />}
            />
            <Row
              id="steamapi-friends"
              label="Friends playing now on Home"
              hint="Shows which of your Steam friends are online and what they’re playing. VYSTRAL reads your friends list and their public profile status from Steam every few minutes while Home is open — only what anyone can see on their Steam profiles. Your friends list must be public in Steam’s privacy settings. Nothing is stored or shared."
              control={<Toggle id="steamapi-friends" label="Friends playing now on Home" checked={friends} disabled={localOnly} onChange={(v) => void setSetting('home.friendsActivity', v)} />}
            />
          </>
        )}
        {shown && <TestResult result={shown} />}
        <div className="srow steamapi__privacy">
          <Lock size={16} aria-hidden />
          <div className="srow__hint">
            Your key stays in Windows Credential Manager on this PC; requests go only to api.steampowered.com. VYSTRAL reads your owned games and
            achievements, never your password, and never changes anything on your Steam account.
          </div>
        </div>
      </div>
      <Dialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title="Disconnect the Steam Web API?"
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
            <HoldToConfirm icon={<Unplug size={14} />} onConfirm={() => void disconnect()}>Disconnect</HoldToConfirm>
          </>
        }
      >
        The key is removed from Windows Credential Manager and saved achievements are cleared. Games that were added as “not installed” stay in your library; nothing on Steam changes.
      </Dialog>
    </section>
  );
}

function Row({ label, hint, control, id }: { label: ReactNode; hint?: ReactNode; control: ReactNode; id?: string }) {
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={id}>{label}</label>
        {hint && <div className="srow__hint">{hint}</div>}
      </div>
      <div className="srow__control">{control}</div>
    </div>
  );
}

function AccountPicker({ status, disabled, onChange }: { status: SteamApiStatus; disabled: boolean; onChange: (steamId: string) => void }) {
  if (!status.accounts.length) return <span className="srow__hint">No accounts found</span>;
  return (
    <select className="input steamapi__select" aria-label="Steam account" value={status.steamId ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {status.accounts.map((a) => (
        <option key={a.steamId} value={a.steamId}>
          {a.personaName}{a.mostRecent ? ' (signed in most recently)' : ''}
        </option>
      ))}
    </select>
  );
}

function ConnectForm({
  status,
  disabled,
  busy,
  onConnect,
  onAccount,
}: {
  status: SteamApiStatus;
  disabled: boolean;
  busy: boolean;
  onConnect: (key: string, steamId: string | null) => Promise<SteamActionResult | null>;
  onAccount: (steamId: string) => void;
}) {
  const id = useId();
  const [key, setKey] = useState('');
  const trimmed = key.trim();
  const valid = KEY_RE.test(trimmed);
  const showFormatHint = trimmed.length > 0 && !valid;

  const submit = async () => {
    if (!valid || disabled) return;
    const r = await onConnect(trimmed, status.steamId);
    if (r && (r.result.outcome === 'ok' || r.result.outcome === 'privateProfile')) setKey('');
  };

  return (
    <div className="steamapi__connect">
      <ol className="steamapi__steps">
        <li>
          <div className="steamapi__step-head">
            <span className="steamapi__num" aria-hidden>1</span>
            <div>
              <div className="srow__label">Get your free key from Steam</div>
              <div className="srow__hint">Sign in on Steam’s page, enter any domain name (for example “localhost”), and copy the 32-character key.</div>
            </div>
          </div>
          <Button size="sm" icon={<ExternalLink size={14} />} disabled={disabled} onClick={() => void call('app.openExternal', { url: KEY_PAGE }).catch(() => undefined)}>
            Open steamcommunity.com/dev/apikey
          </Button>
        </li>
        <li>
          <div className="steamapi__step-head">
            <span className="steamapi__num" aria-hidden>2</span>
            <div>
              <div className="srow__label">Confirm your Steam account</div>
              <div className="srow__hint">{status.steamInstalled ? 'Read from Steam’s sign-in list on this PC.' : 'Steam isn’t installed on this PC.'}</div>
            </div>
          </div>
          <AccountPicker status={status} disabled={disabled} onChange={onAccount} />
        </li>
        <li>
          <div className="steamapi__step-head">
            <span className="steamapi__num" aria-hidden>3</span>
            <div>
              <label className="srow__label" htmlFor={id}>Paste the key and connect</label>
              <div className="srow__hint" id={`${id}-hint`}>
                {showFormatHint ? 'A key is exactly 32 characters using 0–9 and A–F.' : 'VYSTRAL tests it with one request before saving it.'}
              </div>
            </div>
          </div>
          <form
            className="steamapi__keyrow"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <span className="steamapi__keyfield" data-invalid={showFormatHint || undefined}>
              <KeyRound size={15} aria-hidden />
              <input
                id={id}
                className="num"
                type="password"
                autoComplete="off"
                spellCheck={false}
                maxLength={64}
                value={key}
                disabled={disabled}
                placeholder="32-character key"
                aria-describedby={`${id}-hint`}
                aria-invalid={showFormatHint || undefined}
                onChange={(e) => setKey(e.target.value)}
              />
            </span>
            <Button type="submit" variant="primary" loading={busy} disabled={!valid || disabled || !status.accounts.length}>
              Connect
            </Button>
          </form>
        </li>
      </ol>
    </div>
  );
}

const OUTCOME: Record<SteamTestResult['outcome'], { tone: 'ok' | 'warn' | 'danger'; title: string }> = {
  ok: { tone: 'ok', title: 'Connected' },
  privateProfile: { tone: 'warn', title: 'Key works, but your game details are private' },
  invalidKey: { tone: 'danger', title: 'Steam rejected the key' },
  rateLimited: { tone: 'warn', title: 'Steam asked VYSTRAL to slow down' },
  unavailable: { tone: 'warn', title: 'Steam couldn’t be reached' },
  malformed: { tone: 'warn', title: 'Steam’s answer couldn’t be read' },
  noAccount: { tone: 'warn', title: 'No Steam account on this PC' },
};

function TestResult({ result }: { result: SteamTestResult }) {
  const o = OUTCOME[result.outcome] ?? OUTCOME.malformed;
  return (
    <div className={`srow steamapi__result steamapi__result--${o.tone}`} role="status" aria-live="polite">
      {o.tone === 'ok' ? <CheckCircle2 size={18} aria-hidden /> : <AlertTriangle size={18} aria-hidden />}
      <div className="srow__text">
        <div className="srow__label">{o.title}</div>
        <div className="srow__hint">{result.message} <span className="steamapi__when">· {formatRelative(result.at)}</span></div>
      </div>
    </div>
  );
}
