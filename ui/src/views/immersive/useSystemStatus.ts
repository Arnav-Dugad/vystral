import { useEffect, useSyncExternalStore } from 'react';
import { call, on } from '../../bridge/bridge';
import type { SystemStatus } from '../../bridge/types';
import { useGameRunning } from '../../state/store';

const POLL_MS = 30_000;

let status: SystemStatus | null = null;
const subs = new Set<() => void>();
let users = 0;
let stop: (() => void) | null = null;

function load() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  void call<SystemStatus>('system.status')
    .then((s) => {
      if (!s) return;
      status = s;
      subs.forEach((f) => f());
    })
    .catch(() => {});
}

function start() {
  load();
  const t = window.setInterval(load, POLL_MS);
  const offPad = on('gamepad.connection', load);
  document.addEventListener('visibilitychange', load);
  return () => {
    window.clearInterval(t);
    offPad();
    document.removeEventListener('visibilitychange', load);
  };
}

/**
 * The system reading (PC battery and battery saver, network, controllers, the Windows clock
 * format), refreshed every 30 s while anything in Immersive shows it and no game runs. One
 * poll however many parts of the interface read it (the system bar, the screensaver).
 */
export function useSystemStatus(): SystemStatus | null {
  const running = useGameRunning();
  const value = useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => status,
  );
  useEffect(() => {
    if (running) return;
    if (users++ === 0) stop = start();
    else load();
    return () => {
      if (--users === 0) {
        stop?.();
        stop = null;
      }
    };
  }, [running]);
  return value;
}
