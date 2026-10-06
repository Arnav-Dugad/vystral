/**
 * Track O: cloud play helpers — honest wording for the hours meter, service names, and which option the
 * "Play in the cloud" button starts by default. Pure functions (tested in cloud.test.ts).
 */
import type { CloudBadge, CloudMeter, CloudOption, CloudService, CloudSession, CloudServiceHealth } from '../bridge/types';

export const SERVICE_NAME: Record<CloudService, string> = { gfn: 'GeForce NOW', xbox: 'Xbox Cloud Gaming' };
export const SERVICE_SHORT: Record<CloudService, string> = { gfn: 'GeForce NOW', xbox: 'Xbox Cloud' };

export const GFN_PLANS: { value: CloudMeter['plan']; label: string }[] = [
  { value: 'none', label: 'Not a member' },
  { value: 'free', label: 'Free' },
  { value: 'performance', label: 'Performance' },
  { value: 'ultimate', label: 'Ultimate' },
  { value: 'daypass', label: 'Day pass' },
];

/** "45 min", "1.5 h", "100 h". Hours get one decimal below 10. */
export function formatHours(seconds: number): string {
  const s = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return h < 10 ? `${(Math.round(h * 10) / 10).toLocaleString()} h` : `${Math.round(h).toLocaleString()} h`;
}

export type Tone = 'ok' | 'warn' | 'danger' | 'muted';

/**
 * The meter's headline and tone. Always an estimate: VYSTRAL only sees sessions it started, so the copy never
 * claims to be NVIDIA's balance.
 */
export function meterSummary(m: CloudMeter): { tone: Tone; title: string; detail: string; fraction: number | null } {
  const used = formatHours(m.usedSeconds);
  if (m.plan === 'none') return { tone: 'muted', title: 'Pick your GeForce NOW membership', detail: 'Then VYSTRAL can show your monthly hours and session length.', fraction: null };
  if (m.limitSeconds == null) {
    const session = m.sessionLimitSeconds ? ` Sessions end after ${formatHours(m.sessionLimitSeconds)}.` : '';
    return { tone: 'muted', title: `${used} played this month`, detail: `${m.planLabel} has no monthly hour limit.${session}`, fraction: null };
  }
  const left = formatHours(m.leftSeconds ?? 0);
  const limit = formatHours(m.limitSeconds);
  const rollover = m.rolloverHours > 0 ? ` Up to ${m.rolloverHours} unused hours roll over; VYSTRAL can’t see those.` : '';
  if (m.level === 'reached') return { tone: 'danger', title: `About ${limit} used`, detail: `You’ve likely reached this month’s ${limit}. NVIDIA shows your real balance in the GeForce NOW app.${rollover}`, fraction: 1 };
  if (m.level === 'near') return { tone: 'warn', title: `About ${left} left`, detail: `${used} of ${limit} used this month. Worth checking your balance in the GeForce NOW app.${rollover}`, fraction: m.fraction };
  return { tone: 'ok', title: `About ${left} left`, detail: `${used} of ${limit} used this month.${rollover}`, fraction: m.fraction };
}

/** "Resets 1 Nov" (local date). */
export function resetLabel(m: CloudMeter, locale?: string): string {
  const d = new Date(m.nextReset);
  if (Number.isNaN(d.getTime())) return '';
  return `Resets ${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(d)}`;
}

/** A running session's time left before the membership ends it, or null. */
export function sessionLeft(s: Pick<CloudSession, 'sessionLeftSeconds' | 'sessionLevel'> | Pick<CloudMeter, 'sessionLeftSeconds' | 'sessionLevel'>): { tone: Tone; text: string } | null {
  if (s.sessionLeftSeconds == null || s.sessionLevel === 'none') return null;
  if (s.sessionLevel === 'reached') return { tone: 'danger', text: 'Session time is up: GeForce NOW may end it now' };
  const text = `${formatHours(s.sessionLeftSeconds)} left in this session`;
  return { tone: s.sessionLevel === 'near' ? 'warn' : 'muted', text };
}

/** The option the main button starts: verified matches first, then ready-to-play GeForce NOW, then Xbox, then Install-to-Play. */
export function preferredOption(options: CloudOption[]): CloudOption | null {
  if (!options.length) return null;
  const rank = (o: CloudOption) => (o.match === 'store' ? 0 : 10) + (o.service === 'gfn' ? (o.playType === 'install' ? 3 : 0) : 1);
  return [...options].sort((a, b) => rank(a) - rank(b))[0];
}

/** Spoken label for a card's cloud badge. */
export function badgeLabel(badges: CloudBadge[]): string {
  const names = [...new Set(badges.map((b) => SERVICE_NAME[b.service]))];
  return `Playable in the cloud: ${names.join(' and ')}${badges.some((b) => b.match === 'title') ? ' (likely match)' : ''}`;
}

/** Short text for a badge/option: "Install-to-Play" for GeForce NOW's install mode. */
export function playTypeLabel(b: Pick<CloudBadge, 'service' | 'playType'>): string {
  return b.service === 'gfn' ? (b.playType === 'install' ? 'Install-to-Play' : 'Ready to play') : 'Cloud playable';
}

/** Status page indicator → tone and words. */
export function healthTone(h: CloudServiceHealth | null): { tone: Tone; text: string } | null {
  if (!h || h.error) return null;
  switch (h.indicator) {
    case 'none': return { tone: 'ok', text: 'All systems operational' };
    case 'maintenance': return { tone: 'muted', text: h.degraded ? `Maintenance at ${h.degraded} of ${h.components} locations` : h.description };
    case 'minor': return { tone: 'warn', text: h.description };
    case 'major':
    case 'critical': return { tone: 'danger', text: h.description };
    default: return null;
  }
}

/** "1:05:09" style elapsed time for the session pill. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
