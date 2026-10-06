/**
 * Pure helpers for the Immersive system bar (Track L): which glyph and words each reading gets.
 * Every indicator has a spoken name and never relies on colour alone.
 */
import type { SystemStatus } from '../../bridge/types';

export type BatteryLevel = 'charging' | 'full' | 'medium' | 'low' | 'critical';

export function batteryLevel(percent: number, charging: boolean): BatteryLevel {
  if (charging) return 'charging';
  if (percent <= 10) return 'critical';
  if (percent <= 25) return 'low';
  if (percent <= 70) return 'medium';
  return 'full';
}

export function batteryLabel(b: NonNullable<SystemStatus['battery']>): string {
  const p = Math.round(Math.max(0, Math.min(100, b.percent)));
  return `Battery ${p}%${b.charging ? ', charging' : ''}${b.saver ? ', battery saver on' : ''}`;
}

/** 0–3 Wi-Fi arcs from Windows' 0–5 signal bars (null = unknown, shown as full). */
export function wifiArcs(bars: number | null): 0 | 1 | 2 | 3 {
  if (bars == null || !Number.isFinite(bars)) return 3;
  if (bars <= 0) return 0;
  if (bars <= 2) return 1;
  if (bars <= 3) return 2;
  return 3;
}

export function networkLabel(n: SystemStatus['network']): string {
  if (n.kind === 'none') return 'Not connected';
  const base = n.kind === 'wifi' ? 'Wi-Fi' : n.kind === 'ethernet' ? 'Ethernet' : n.kind === 'cellular' ? 'Mobile data' : 'Network';
  const strength = (n.kind === 'wifi' || n.kind === 'cellular') && n.bars != null ? `, signal ${Math.max(0, Math.min(5, Math.round(n.bars)))} of 5` : '';
  return `${base}${strength}${n.internet ? '' : ', no internet'}`;
}

export function controllerLabel(c: SystemStatus['controllers'][number], index: number, total: number): string {
  const name = total > 1 ? `Controller ${index + 1}` : 'Controller';
  if (c.wired) return `${name}, wired`;
  if (c.battery == null) return `${name}, battery unknown`;
  return `${name}, battery ${Math.round(Math.max(0, Math.min(1, c.battery)) * 100)}%${c.charging ? ', charging' : ''}`;
}

/** Elapsed play time for the now-playing chip: "12 min", "1 h 05 min". */
export function elapsed(startIso: string | null | undefined, now: number): string | null {
  const t = startIso ? Date.parse(startIso) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}
