import { useCallback, useEffect, useState } from 'react';
import { EyeOff, Moon, Radar } from 'lucide-react';
import { call, errorMessage } from '../../bridge/bridge';
import type { TrackingStatus } from '../../bridge/types';
import { formatDuration, formatRelative } from '../../lib/format';
import { useStore } from '../../state/store';
import { Badge, Button, Skeleton, Toggle } from '../../components/ui/primitives';
import './insights-settings.css';
import './background-tracking.css';

/** Measured footprint of the background tracker (docs/PERFORMANCE.md). */
export const TRACKER_FOOTPRINT = 'about 20 MB of memory and under 0.1% of one CPU core while it waits (nothing at all while VYSTRAL is open)';

/** The status sentence under the toggle: what is happening right now, in plain words. */
export function trackingStatusLine(s: TrackingStatus | null, enabled: boolean, now = Date.now()): string {
  if (!enabled) return 'Off. Only games you start from VYSTRAL are recorded.';
  if (!s) return 'On.';
  if (s.safeMode) return 'Paused: VYSTRAL is running in safe mode.';
  const seen = s.lastSeen
    ? `last game seen: ${s.lastSeen.title}, ${formatRelative(s.lastSeen.end ?? s.lastSeen.start, now).toLowerCase()}`
    : `watching ${s.watchedGames} installed ${s.watchedGames === 1 ? 'game' : 'games'}; nothing noticed yet`;
  return `Background tracking is on — ${seen}.`;
}

function autostartNote(s: TrackingStatus): { tone: 'ok' | 'warn' | undefined; text: string } {
  switch (s.autostart) {
    case 'on':
      return { tone: 'ok', text: s.helperRunning ? 'Starts with Windows · running' : 'Starts with Windows · starts again when you sign in' };
    case 'disabledByWindows':
      return { tone: 'warn', text: 'Turned off in Task Manager › Startup apps, so it won’t start when you sign in. Turn it back on there to track games after a restart.' };
    case 'stale':
      return { tone: 'warn', text: 'The sign-in entry points at an older copy of VYSTRAL. Turn this off and on again to repair it.' };
    case 'off':
      return { tone: undefined, text: 'Not set to start with Windows.' };
    default:
      return {
        tone: undefined,
        text: s.build === 'portable'
          ? 'Starting with Windows isn’t available in the portable copy. Games are still noticed while this copy is open.'
          : 'Starting with Windows isn’t available in development builds. Games are still noticed while this copy is open.',
      };
  }
}

/**
 * Settings › Launching & sessions › Games started outside VYSTRAL (Track H). Opt-in. Explains what runs,
 * what it costs and what is stored, shows what the tracker is doing, and lists games it was told to ignore.
 */
export function BackgroundTrackingSettings() {
  const enabled = useStore((s) => s.settings?.['tracking.background'] ?? false);
  const setSetting = useStore((s) => s.setSetting);
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = useState<TrackingStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await call<TrackingStatus>('tracking.status'));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    // The tracker starts or stops a moment after the switch; keep the line current while this page is open.
    const quick = window.setTimeout(() => void refresh(), 1500);
    const slow = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(quick);
      window.clearInterval(slow);
    };
  }, [refresh, enabled]);

  const setIgnored = async (gameId: string, ignored: boolean, title: string) => {
    setBusy(gameId);
    try {
      setStatus(await call<TrackingStatus>('tracking.setIgnored', { gameId, ignored }));
      if (ignored) toast({ tone: 'info', title: `VYSTRAL won’t track ${title} when you start it elsewhere`, body: 'Starting it from VYSTRAL still records it as usual.' });
    } catch (err) {
      toast({ tone: 'danger', title: 'That didn’t work', body: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const s = status;
  const disabled = !!s && !s.available;
  const auto = s ? autostartNote(s) : null;
  const lastIgnored = !!s?.lastSeen && s.ignored.some((g) => g.gameId === s.lastSeen!.gameId);

  return (
    <section className="sgroup" aria-labelledby="bg-tracking-title">
      <h2 id="bg-tracking-title" className="sgroup__title">
        Games started outside VYSTRAL <Badge>Optional</Badge>
      </h2>
      <p className="sgroup__desc">
        VYSTRAL normally records only the games you start from it. Turn this on to also record installed games you start from Steam, a desktop
        shortcut or anywhere else — while VYSTRAL is open, and through a small background tracker while it’s closed.
      </p>
      <div className="sgroup__rows surface bgx">
        <div className="srow">
          <div className="srow__text">
            <label className="srow__label" htmlFor="bg-tracking-toggle">Track games even when VYSTRAL is closed</label>
            <div className="srow__hint" role="status" aria-live="polite" data-testid="bg-tracking-status">
              {error && !s ? `Couldn’t read the tracker’s status: ${error}` : trackingStatusLine(s, enabled)}
            </div>
            {enabled && s?.lastSeen && !lastIgnored && (
              <div className="bgx__last">
                <span className="bgx__last-text">
                  {s.lastSeen.source === 'background' ? <Moon size={12} aria-hidden /> : <Radar size={12} aria-hidden />}
                  {s.lastSeen.title} · {formatDuration(s.lastSeen.durationSeconds)}
                </span>
                <Button size="sm" variant="ghost" icon={<EyeOff size={13} />} loading={busy === s.lastSeen.gameId} disabled={!!busy}
                  onClick={() => void setIgnored(s.lastSeen!.gameId, true, s.lastSeen!.title)}>
                  Don’t track this game
                </Button>
              </div>
            )}
          </div>
          <div className="srow__control">
            <Toggle id="bg-tracking-toggle" label="Track games even when VYSTRAL is closed" checked={enabled} disabled={disabled}
              onChange={(v) => void setSetting('tracking.background', v)} />
          </div>
        </div>

        {enabled && (
          <div className="srow bgx__auto">
            <div className="srow__text">
              <div className="srow__label">Start with Windows</div>
              <div className="srow__hint">{auto ? auto.text : <Skeleton height={14} width={220} />}</div>
            </div>
            {auto?.tone && <div className="srow__control"><Badge tone={auto.tone}>{auto.tone === 'ok' ? 'On' : 'Check'}</Badge></div>}
          </div>
        )}

        {!!s?.ignored.length && (
          <div className="srow bgx__ignored">
            <div className="srow__text">
              <div className="srow__label">Not tracked when started elsewhere</div>
              <ul className="bgx__list">
                {s.ignored.map((g) => (
                  <li key={g.gameId}>
                    <span className="truncate">{g.title}</span>
                    <Button size="sm" variant="ghost" loading={busy === g.gameId} disabled={!!busy} onClick={() => void setIgnored(g.gameId, false, g.title)}>
                      Track again
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <details className="fpsx__details bgx__details">
          <summary>What runs, what it costs, what’s stored</summary>
          <dl>
            <dt>What runs</dt>
            <dd>
              A windowless copy of VYSTRAL (<span className="fpsx__mono">Vystral.exe --background-tracker</span>) that starts when you sign in to
              Windows. It’s listed as “VYSTRAL Background Tracker” in Task Manager › Startup apps. Whenever VYSTRAL itself is open, the tracker
              pauses and VYSTRAL takes over — exactly one of them tracks at a time, so nothing is counted twice.
            </dd>
            <dt>How it watches</dt>
            <dd>
              Every {s?.pollSeconds ?? 4} seconds ({s?.savingPollSeconds ?? 15} on battery or energy saver) it checks which program owns the
              foreground window, and once a minute it reads the list of running programs — the same information Task Manager shows. It never opens,
              reads or injects into any process, so anti-cheat software has nothing to object to.
            </dd>
            <dt>Footprint</dt>
            <dd>Measured at {TRACKER_FOOTPRINT}. During a game it records exactly what a session started from VYSTRAL records.</dd>
            <dt>What’s stored</dt>
            <dd>
              The same session records as games you start from VYSTRAL — when you played, for how long and, if turned on above, performance
              readings — in your library on this PC, marked “Background” or “Detected” in your journal. Sessions shorter than
              {' '}{s ? Math.round(s.minSessionSeconds / 60) : 1} minute aren’t kept, and hidden games aren’t noticed. Nothing leaves this PC.
            </dd>
            <dt>Turning it off</dt>
            <dd>
              Switch this off: the tracker stops and its sign-in entry is removed. You can also turn it off in Task Manager › Startup apps;
              uninstalling VYSTRAL removes it too. Recorded sessions stay in your journal until you delete them (Settings › Data).
            </dd>
          </dl>
        </details>
      </div>
    </section>
  );
}
