/** Track D6: pure helpers for the Data sources health page. */
import type { ProviderHealthEntry } from '../bridge/types';

export interface HealthSummary {
  on: number;
  off: number;
  attention: number;
  paused: number;
  requests: number;
}

export function healthSummary(list: ProviderHealthEntry[]): HealthSummary {
  return {
    on: list.filter((p) => p.enabled).length,
    off: list.filter((p) => !p.enabled).length,
    attention: list.filter((p) => p.enabled && p.state === 'error').length,
    paused: list.filter((p) => p.enabled && p.state === 'backoff').length,
    requests: list.reduce((n, p) => n + Math.max(0, p.requestsToday | 0), 0),
  };
}

/** The pill: "Working", "Problem", "Paused", "Not used yet", "Off". */
export function providerStatusLabel(p: Pick<ProviderHealthEntry, 'state' | 'enabled'>): string {
  if (!p.enabled || p.state === 'off') return 'Off';
  switch (p.state) {
    case 'ok': return 'Working';
    case 'error': return 'Problem';
    case 'backoff': return 'Paused';
    default: return 'Not used yet';
  }
}

/** "for 9 more minutes", "for about 2 more hours", "ending now". */
export function untilText(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  if (s <= 30) return 'ending now';
  if (s < 90) return 'for about a minute';
  const m = Math.round(s / 60);
  if (m < 90) return `for ${m} more minutes`;
  const h = Math.round(m / 60);
  return `for about ${h} more hour${h === 1 ? '' : 's'}`;
}
