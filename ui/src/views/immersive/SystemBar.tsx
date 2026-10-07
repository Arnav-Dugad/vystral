import { useEffect, useState } from 'react';
import {
  Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning, Bell, EthernetPort, Gamepad2, MonitorCog,
  Signal, SignalLow, SignalMedium, Wifi, WifiHigh, WifiLow, WifiOff, WifiZero,
} from 'lucide-react';
import { on } from '../../bridge/bridge';
import type { SystemStatus } from '../../bridge/types';
import { useGameRunning, useStore } from '../../state/store';
import { batteryLabel, batteryLevel, controllerLabel, elapsed, networkLabel, wifiArcs } from './systemStatus';
import { clockParts } from './screensaver';
import { useSystemStatus } from './useSystemStatus';


/**
 * Immersive's system bar (Track L): what's playing, unread notifications, controllers and their
 * batteries, network, the PC's battery, the time — and the couch display settings. Every
 * indicator has a spoken name and a glyph; none relies on colour alone.
 */
export function SystemBar({ onDisplay }: { onDisplay: () => void }) {
  const status = useSystemStatus();
  const unread = useStore((s) => s.notifications.filter((n) => !n.read).length);
  const launch = useStore((s) => s.launch);
  const playing = useStore((s) => (s.launch && ['starting', 'waiting', 'running'].includes(s.launch.phase) ? s.gamesById.get(s.launch.gameId) ?? null : null));
  const [pads, setPads] = useState<number | null>(null);
  useEffect(() => on('gamepad.connection', (e) => setPads(e.count)), []);

  const controllers = status?.controllers ?? [];
  const padCount = pads ?? controllers.length;

  return (
    <div className="imm__status" role="group" aria-label="System">
      {playing && launch && (
        <span className="imm-sys imm-sys--playing" role="status">
          <span className="imm-sys__pulse" aria-hidden />
          <span className="imm-sys__text">
            {launch.phase === 'running' ? 'Playing' : 'Starting'} <strong>{playing.title}</strong>
            {launch.phase === 'running' && <NowElapsed start={launch.startedAt} />}
          </span>
        </span>
      )}
      {unread > 0 && (
        <span className="imm-sys" role="img" aria-label={`${unread} unread ${unread === 1 ? 'notification' : 'notifications'}`}>
          <Bell size="1.05em" aria-hidden />
          <span className="imm-sys__badge num" aria-hidden>{unread > 9 ? '9+' : unread}</span>
        </span>
      )}
      {padCount > 0 ? (
        controllers.length > 0 ? (
          controllers.slice(0, 4).map((c, i) => (
            <span key={i} className="imm-sys imm__pad" data-connected role="img" aria-label={controllerLabel(c, i, controllers.length)}>
              <Gamepad2 size="1.1em" aria-hidden />
              {!c.wired && c.battery != null && <PadBattery level={c.battery} charging={c.charging} />}
            </span>
          ))
        ) : (
          <span className="imm-sys imm__pad" data-connected role="img" aria-label={padCount > 1 ? `${padCount} controllers` : 'Controller connected'}>
            <Gamepad2 size="1.1em" aria-hidden />
          </span>
        )
      ) : pads === 0 || status ? (
        <span className="imm-sys imm__pad" data-connected="false" role="img" aria-label="No controller">
          <Gamepad2 size="1.1em" aria-hidden />
          <span className="imm-sys__strike" aria-hidden />
        </span>
      ) : null}
      {status && <NetworkGlyph network={status.network} />}
      {status?.battery && <BatteryGlyph battery={status.battery} />}
      <Clock hour12={status?.clock24h == null ? null : !status.clock24h} />
      <button type="button" className="imm-sys imm-sys__btn" onClick={onDisplay} aria-label="Display and text size">
        <MonitorCog size="1.1em" aria-hidden />
      </button>
    </div>
  );
}

function PadBattery({ level, charging }: { level: number; charging: boolean }) {
  const pct = Math.max(0, Math.min(1, level));
  return (
    <span className="imm-sys__pad-batt" data-low={pct <= 0.2 || undefined} data-charging={charging || undefined} aria-hidden>
      <span style={{ transform: `scaleX(${pct})` }} />
    </span>
  );
}

function NetworkGlyph({ network }: { network: SystemStatus['network'] }) {
  const label = networkLabel(network);
  let icon;
  if (network.kind === 'none') icon = <WifiOff size="1.1em" aria-hidden />;
  else if (network.kind === 'ethernet' || network.kind === 'other') icon = <EthernetPort size="1.1em" aria-hidden />;
  else if (network.kind === 'cellular') {
    const a = wifiArcs(network.bars);
    icon = a >= 3 ? <Signal size="1.1em" aria-hidden /> : a === 2 ? <SignalMedium size="1.1em" aria-hidden /> : <SignalLow size="1.1em" aria-hidden />;
  } else {
    const a = wifiArcs(network.bars);
    icon = a === 3 ? <Wifi size="1.1em" aria-hidden /> : a === 2 ? <WifiHigh size="1.1em" aria-hidden /> : a === 1 ? <WifiLow size="1.1em" aria-hidden /> : <WifiZero size="1.1em" aria-hidden />;
  }
  return (
    <span className="imm-sys" role="img" aria-label={label} data-warn={!network.internet || undefined}>
      {icon}
    </span>
  );
}

function BatteryGlyph({ battery }: { battery: NonNullable<SystemStatus['battery']> }) {
  const level = batteryLevel(battery.percent, battery.charging);
  const Icon = { charging: BatteryCharging, full: BatteryFull, medium: BatteryMedium, low: BatteryLow, critical: BatteryWarning }[level] ?? Battery;
  return (
    <span className="imm-sys" role="img" aria-label={batteryLabel(battery)} data-warn={level === 'critical' || level === 'low' || undefined}>
      <Icon size="1.15em" aria-hidden />
      <span className="imm-sys__pct num" aria-hidden>{Math.round(battery.percent)}%</span>
    </span>
  );
}

function NowElapsed({ start }: { start: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const e = elapsed(start, now);
  return e ? <span className="imm-sys__elapsed num"> · {e}</span> : null;
}

function Clock({ hour12 }: { hour12: boolean | null }) {
  const running = useGameRunning();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (running) return;
    // Back from a game (or first shown): catch up at once, then tick on the minute boundary.
    setNow(new Date());
    let t: number;
    const schedule = () => {
      const d = new Date();
      t = window.setTimeout(() => {
        setNow(new Date());
        schedule();
      }, (60 - d.getSeconds()) * 1000 - d.getMilliseconds() + 20);
    };
    schedule();
    return () => window.clearTimeout(t);
  }, [running]);
  return (
    <div className="imm__clock">
      {/* Track Z: 12- or 24-hour as Windows' regional format says. */}
      <span className="num">{clockParts(now, hour12).label}</span>
      <span className="imm__date">{now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
    </div>
  );
}
