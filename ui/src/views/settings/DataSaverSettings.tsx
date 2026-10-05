import { useEffect, useState } from 'react';
import { Gauge, Wifi, WifiOff } from 'lucide-react';
import { call, on } from '../../bridge/bridge';
import type { NetworkStatus, SettingKey } from '../../bridge/types';
import { Badge, Toggle } from '../../components/ui/primitives';
import { useStore } from '../../state/store';

function useNetworkStatus(): NetworkStatus | null {
  const [status, setStatus] = useState<NetworkStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => call<NetworkStatus>('network.status').then((s) => alive && setStatus(s)).catch(() => {});
    void load();
    const off = on('settings.changed', () => void load());
    const onOnline = () => void load();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOnline);
    return () => {
      alive = false;
      off();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOnline);
    };
  }, []);
  return status;
}

function SwitchRow({ k, label, hint, disabled }: { k: SettingKey; label: string; hint: string; disabled?: boolean }) {
  const value = useStore((s) => !!s.settings?.[k]);
  const set = useStore((s) => s.setSetting);
  return (
    <div className="srow">
      <div className="srow__text">
        <label className="srow__label" htmlFor={k}>{label}</label>
        <div className="srow__hint">{hint}</div>
      </div>
      <div className="srow__control">
        <Toggle id={k} label={label} checked={value} disabled={disabled} onChange={(v) => void set(k, v as never)} />
      </div>
    </div>
  );
}

function connectionText(n: NetworkStatus): string {
  if (!n.connected) return 'Windows reports no internet connection.';
  if (n.overDataLimit) return 'Windows reports this connection is over its data limit.';
  if (n.roaming) return 'Windows reports this connection is roaming.';
  if (n.approachingDataLimit) return 'Windows reports this connection is close to its data limit.';
  if (n.metered) return 'Windows reports this connection as metered.';
  return 'Windows reports this connection as unmetered.';
}

/** Settings → Privacy: Data saver and trailer autoplay. */
export function DataSaverSettings() {
  const net = useNetworkStatus();
  const offline = useStore((s) => !!s.settings?.['privacy.localOnly']);
  const saverOn = !!net?.dataSaverActive;

  return (
    <>
      <section className="sgroup">
        <h2 className="sgroup__title">Data saver</h2>
        <p className="sgroup__desc">
          Keeps VYSTRAL light on limited connections. While it’s on, trailers don’t play and missing artwork isn’t downloaded
          (artwork your stores already keep on this PC is still used). Launching games is never affected.
        </p>
        <div className="sgroup__rows surface">
          <div className="srow" style={{ justifyContent: 'space-between' }}>
            <span className="srow__hint" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {net ? (net.connected ? <Wifi size={14} aria-hidden /> : <WifiOff size={14} aria-hidden />) : <Gauge size={14} aria-hidden />}
              {net ? connectionText(net) : 'Checking your connection…'}
            </span>
            {net && (
              saverOn
                ? <Badge tone="warn" icon={<Gauge size={12} />}>{net.dataSaverReason === 'metered' ? 'On · metered connection' : 'On'}</Badge>
                : <Badge>Off</Badge>
            )}
          </div>
          <SwitchRow k="dataSaver.enabled" label="Data saver" hint="Always on, whatever the connection." />
          <SwitchRow
            k="dataSaver.onMetered"
            label="Turn on automatically on metered connections"
            hint="Uses the cost Windows reports for the current network (Settings → Network & internet → “Metered connection”, mobile data, roaming)."
          />
        </div>
      </section>
      <section className="sgroup">
        <h2 className="sgroup__title">Trailers</h2>
        <p className="sgroup__desc">
          Game pages can play the game’s trailer from Steam behind the artwork, muted, after a couple of seconds of you looking at the page.
          Only games with an exact Steam app are matched. Video is streamed from Steam’s video servers through VYSTRAL and isn’t saved to disk.
        </p>
        <div className="sgroup__rows surface">
          <SwitchRow
            k="trailers.autoplay"
            label="Autoplay trailers"
            hint={
              offline ? 'Offline mode is on, so trailers won’t load.'
              : saverOn ? 'Data saver is on, so trailers won’t play right now.'
              : 'Never while a game is running, with reduced motion or low visual quality, or while VYSTRAL is minimized. Turn off to start them yourself with the Play trailer button.'
            }
          />
        </div>
      </section>
    </>
  );
}
