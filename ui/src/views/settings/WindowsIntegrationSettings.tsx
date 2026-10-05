import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, BellRing, CheckCircle2, Keyboard } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { HotkeyStatus, SettingKey } from '../../bridge/types';
import { useStore } from '../../state/store';
import { Badge, Button, Kbd, Toggle } from '../../components/ui/primitives';
import { shortcutFromKey, validateShortcut } from './hotkey';
import './insights-settings.css';

/** Settings › Windows integration: the global summon shortcut and Windows notifications. */
export function WindowsIntegrationSettings() {
  return (
    <>
      <SummonShortcut />
      <NotificationSettings />
    </>
  );
}

/* ------------------------------------------------------------------ hotkey */

function SummonShortcut() {
  const enabled = useStore((s) => s.settings?.['hotkey.enabled'] ?? true);
  const shortcut = useStore((s) => s.settings?.['hotkey.summon'] ?? 'Ctrl+Alt+V');
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fieldRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<HotkeyStatus>('hotkey.status'));
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => void refresh(), [refresh, enabled, shortcut]);

  const save = async (text: string) => {
    const v = validateShortcut(text);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setSaving(true);
    try {
      setStatus(await call<HotkeyStatus>('hotkey.set', { shortcut: v.shortcut }));
      setError(null);
      setCapturing(false);
      toast({ tone: 'success', title: `${v.shortcut} now brings VYSTRAL forward` });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
      setPreview(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      setCapturing(false);
      setPreview(null);
      setError(null);
      return;
    }
    const text = shortcutFromKey(e);
    if (!text) {
      // Only modifiers so far: show them while the user finds the key.
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter(Boolean).join('+');
      setPreview(mods ? `${mods}+…` : null);
      return;
    }
    setPreview(text);
    void save(text);
  };

  const shown = capturing ? preview ?? 'Press a shortcut…' : status?.shortcut ?? shortcut;
  const problem = error ?? (enabled && status && !status.registered ? status.error : null);

  return (
    <section className="sgroup" aria-labelledby="hotkey-title">
      <h2 id="hotkey-title" className="sgroup__title">Summon shortcut</h2>
      <p className="sgroup__desc">
        A keyboard shortcut that brings VYSTRAL to the front from anywhere in Windows — including during a game. It only shows VYSTRAL; it never
        sends anything to other apps. Most Win-key combinations are reserved by Windows, so the default is <Kbd>Ctrl+Alt+V</Kbd>.
      </p>
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="hotkey-enabled">Use a summon shortcut</label>
            <div className="srow__hint">Turn this off if the shortcut clashes with another app you use.</div>
          </div>
          <div className="srow__control">
            <Toggle id="hotkey-enabled" label="Use a summon shortcut" checked={enabled} onChange={(v) => void setSetting('hotkey.enabled', v)} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <span className="srow__label" id="hotkey-field-label">Shortcut</span>
            <div className="srow__hint" id="hotkey-field-hint">
              {capturing ? 'Hold Ctrl, Alt or Win and press a letter, number or F-key. Esc cancels.' : 'Select the field, then press the keys you want.'}
            </div>
            {problem && (
              <p className="hkx__error" role="alert">
                <AlertTriangle size={14} aria-hidden /> {problem}
              </p>
            )}
            {!problem && enabled && status?.registered && (
              <p className="hkx__ok">
                <CheckCircle2 size={14} aria-hidden /> Active
              </p>
            )}
          </div>
          <div className="srow__control hkx__control">
            <button
              ref={fieldRef}
              type="button"
              className="hkx__field"
              data-capturing={capturing || undefined}
              aria-labelledby="hotkey-field-label"
              aria-describedby="hotkey-field-hint"
              aria-pressed={capturing}
              disabled={!enabled || saving}
              onClick={() => {
                setCapturing((c) => !c);
                setPreview(null);
                setError(null);
              }}
              onKeyDown={onKeyDown}
              onBlur={() => {
                setCapturing(false);
                setPreview(null);
              }}
            >
              <Keyboard size={15} aria-hidden />
              <span className="hkx__keys">
                {shown.split('+').map((k, i) => (
                  <Kbd key={`${k}-${i}`}>{k}</Kbd>
                ))}
              </span>
            </button>
            {(status?.shortcut ?? shortcut) !== 'Ctrl+Alt+V' && (
              <Button size="sm" variant="ghost" disabled={!enabled || saving} onClick={() => void save('Ctrl+Alt+V')}>Reset</Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ notifications */

const CATEGORIES: { key: SettingKey; label: string; hint: string }[] = [
  { key: 'notifications.sessions', label: 'Session saved', hint: 'After a game closes: “Played Nebula Drift · 1h 42m”.' },
  { key: 'notifications.thermal', label: 'GPU running hot', hint: 'When your GPU slowed down from heat for more than 30 seconds during a session.' },
  { key: 'notifications.achievements', label: 'Achievements unlocked', hint: 'After a Steam game closes: “You unlocked 3 achievements — 1 is rarer than 2%”. Needs your Steam Web API key.' },
  { key: 'notifications.installs', label: 'Install finished', hint: 'When a game you installed through VYSTRAL is ready to play.' },
  { key: 'notifications.updates', label: 'VYSTRAL update ready', hint: 'When a new version has downloaded and is ready to install.' },
];

function NotificationSettings() {
  const settings = useStore((s) => s.settings);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [clickable, setClickable] = useState(true);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    call<{ available: boolean; clickable?: boolean }>('notifications.status')
      .then((r) => {
        setAvailable(!!r?.available);
        setClickable(r?.clickable !== false);
      })
      .catch(() => setAvailable(false));
  }, []);

  if (!settings) return null;
  const master = settings['notifications.enabled'];

  const test = async () => {
    setTesting(true);
    try {
      const r = await call<{ shown: boolean }>('notifications.test');
      if (r && r.shown === false) toast({ tone: 'warning', title: 'Windows didn’t show the test notification', body: 'Check that notifications for VYSTRAL are allowed in Windows Settings → System → Notifications.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'Test notification failed', body: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <section className="sgroup" aria-labelledby="notify-title">
      <h2 id="notify-title" className="sgroup__title">Windows notifications</h2>
      <p className="sgroup__desc">
        Short notifications in the Windows notification centre.{clickable ? ' Selecting one opens the matching page in VYSTRAL.' : ''} Do not
        disturb and Focus sessions are handled by Windows, so notifications stay quiet while they’re on.
      </p>
      {available === false && (
        <p className="hkx__error" role="status">
          <AlertTriangle size={14} aria-hidden /> Windows notifications aren’t available for VYSTRAL on this PC. Nothing else is affected.
        </p>
      )}
      {available && !clickable && (
        <p className="sgroup__desc" role="status">
          On this build, selecting a notification won’t jump to the matching page yet — a known Windows App SDK issue that a later
          update will fix.
        </p>
      )}
      <div className="sgroup__rows surface">
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="notify-enabled">Show Windows notifications</label>
          </div>
          <div className="srow__control nfx__control">
            <Button size="sm" variant="ghost" icon={<BellRing size={14} />} loading={testing} disabled={!available || !master} onClick={() => void test()}>
              Send a test
            </Button>
            <Toggle id="notify-enabled" label="Show Windows notifications" checked={master} onChange={(v) => void setSetting('notifications.enabled', v)} />
          </div>
        </div>
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="notify-background">Only when VYSTRAL is in the background</label>
            <div className="srow__hint">If VYSTRAL is already in front of you, you’ll see its own message instead.</div>
          </div>
          <div className="srow__control">
            <Toggle id="notify-background" label="Only when VYSTRAL is in the background" disabled={!master} checked={settings['notifications.onlyInBackground']} onChange={(v) => void setSetting('notifications.onlyInBackground', v)} />
          </div>
        </div>
        {CATEGORIES.map((c) => (
          <div className="srow nfx__cat" key={c.key}>
            <div className="srow__text">
              <label className="srow__label" htmlFor={c.key}>{c.label}</label>
              <div className="srow__hint">{c.hint}</div>
            </div>
            <div className="srow__control">
              <Toggle id={c.key} label={c.label} disabled={!master} checked={!!settings[c.key]} onChange={(v) => void setSetting(c.key, v as never)} />
            </div>
          </div>
        ))}
      </div>
      {!master && <Badge>Notifications are off</Badge>}
    </section>
  );
}
