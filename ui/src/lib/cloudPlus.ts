/**
 * Track D5: better cloud play — the "best way to play" advice, the GeForce NOW hours forecast, cloud session
 * insights and the readiness wording. Pure functions (tested in cloudPlus.test.ts). Every sentence says what VYSTRAL
 * actually knows: link speed is never called internet speed, and the hours are always "estimated from sessions
 * VYSTRAL saw".
 */
import type { CloudBadge, CloudMeter, CloudReadiness, CloudReadinessLevel, CloudService, Session } from '../bridge/types';
import { formatHours, SERVICE_SHORT } from './cloud';
import { formatBytes } from './format';

const DAY = 86_400_000;

/** The badge "Play in the cloud" starts by default: verified store matches first, then ready-to-play GeForce NOW, then Xbox. */
export function preferredBadge(badges: readonly CloudBadge[] | null | undefined): CloudBadge | null {
  if (!badges?.length) return null;
  const rank = (b: CloudBadge) => (b.match === 'store' ? 0 : 10) + (b.service === 'gfn' ? (b.playType === 'install' ? 3 : 0) : 1);
  return [...badges].sort((a, b) => rank(a) - rank(b))[0];
}

// ------------------------------------------------------------------------------------------------ best way to play

export interface PlayWayInput {
  installed: boolean;
  /** The game's install size in bytes, when any store reported it. */
  sizeBytes: number | null;
  /** Free bytes on each drive. */
  freeBytes: number[];
  /** Cloud services that list it (empty = not streamable). */
  cloud: readonly CloudBadge[];
  readiness: Pick<CloudReadiness, 'level' | 'link' | 'linkMbps' | 'wifiBand'> | null;
  /** The GeForce NOW meter, when cloud play is on. */
  meter: Pick<CloudMeter, 'level' | 'leftSeconds' | 'plan'> | null;
  metered: boolean;
}

export type PlayWay = 'installed' | 'cloud' | 'install' | 'none';

export interface PlayWayAdvice {
  way: PlayWay;
  /** Short headline ("Stream it now"). */
  title: string;
  /** One or two plain sentences. */
  detail: string;
  tone: 'ok' | 'warn' | 'muted';
  /** The service the advice means, for "cloud". */
  service: CloudService | null;
  /** The other option, in a few words, when there is one ("or install it: 62 GB"). */
  alternative: string | null;
}

/** Sizes read the same as everywhere else in VYSTRAL (Storage, game pages). */
const gb = (bytes: number) => formatBytes(bytes);

/**
 * Installed or cloud? Weighs what's known: installed is always best (full quality, no queue); otherwise disk space,
 * the download size, the measured connection, the GeForce NOW hours left and a metered network decide.
 */
export function bestWayToPlay(i: PlayWayInput): PlayWayAdvice {
  const badge = preferredBadge(i.cloud);
  const service = badge?.service ?? null;
  const name = service ? SERVICE_SHORT[service] : null;
  const maxFree = i.freeBytes.length ? Math.max(...i.freeBytes) : null;
  const fits = i.sizeBytes == null || maxFree == null ? null : maxFree >= i.sizeBytes * 1.1;
  const size = i.sizeBytes ? gb(i.sizeBytes) : null;

  if (i.installed) {
    return {
      way: 'installed', title: 'Play it installed', tone: 'ok', service: null,
      detail: 'It’s on this PC, so it runs at full quality with no queue and no streaming delay.',
      alternative: name ? `or stream it with ${name} on another device` : null,
    };
  }
  if (!badge) {
    if (fits === false) return { way: 'install', title: 'Free up space to install it', tone: 'warn', service: null, detail: `It needs about ${size}, more than any drive has free right now.`, alternative: null };
    return { way: 'install', title: 'Install it to play', tone: 'muted', service: null, detail: size ? `About ${size} to download from its store.` : 'Install it from its store app.', alternative: null };
  }

  const poor = i.readiness?.level === 'poor';
  const hoursOut = service === 'gfn' && i.meter?.level === 'reached';
  const hoursLow = service === 'gfn' && i.meter?.level === 'near';
  const otherService = i.cloud.find((b) => b.service !== service)?.service ?? null;

  if (fits === false && !poor && !hoursOut) {
    return {
      way: 'cloud', title: 'Stream it now', tone: 'ok', service,
      detail: `It needs about ${size} and no drive has that much free, so streaming with ${name} is the easy way in.${i.metered ? ' You’re on a metered connection: streaming can use several GB an hour.' : ''}`,
      alternative: null,
    };
  }
  if (poor) {
    return {
      way: 'install', title: 'Install it for the best experience', tone: 'warn', service,
      detail: `Your connection measured poor for streaming${i.readiness?.wifiBand === '2.4' ? ' (2.4 GHz Wi-Fi)' : ''}, so the stream may stutter.${size ? ` Installing means about ${size} to download.` : ''}`,
      alternative: `or stream it with ${name} anyway`,
    };
  }
  if (hoursOut) {
    if (otherService) return { way: 'cloud', title: `Stream it with ${SERVICE_SHORT[otherService]}`, tone: 'warn', service: otherService, detail: 'You’ve likely used this month’s GeForce NOW hours (estimated from sessions VYSTRAL saw).', alternative: size ? `or install it: ${size}` : null };
    return { way: 'install', title: 'Install it this month', tone: 'warn', service, detail: `You’ve likely used this month’s GeForce NOW hours (estimated from sessions VYSTRAL saw).${size ? ` Installing means about ${size} to download.` : ''}`, alternative: null };
  }
  const detailBits = [
    size ? `No ${size} download, and it’s ready in a minute or two.` : 'No download: it’s ready in a minute or two.',
    hoursLow && i.meter?.leftSeconds != null ? `About ${formatHours(i.meter.leftSeconds)} of GeForce NOW left this month.` : null,
    i.metered ? 'You’re on a metered connection: streaming can use several GB an hour.' : null,
    i.readiness?.level === 'fair' ? 'Your connection measured fair: fine for most games, a little behind for fast ones.' : null,
  ].filter(Boolean);
  return {
    way: 'cloud', title: 'Stream it now', tone: hoursLow || i.metered ? 'warn' : 'ok', service,
    detail: detailBits.join(' '),
    alternative: size ? `or install it for full quality: ${size}` : 'or install it for full quality',
  };
}

// ------------------------------------------------------------------------------------------------ hours forecast

export interface MeterForecast {
  /** Projected hours used by the reset, at the current pace (seconds). */
  projectedSeconds: number;
  /** When the limit would be reached at this pace (ISO), or null when it won't be before the reset. */
  runsOutAt: string | null;
  tone: 'ok' | 'warn' | 'danger';
  text: string;
}

/**
 * GeForce NOW hours forecast: this cycle's pace (hours per day so far) carried to the reset. Needs two days of the
 * cycle and some use; plans without a monthly limit get no forecast. Always an estimate from sessions VYSTRAL saw.
 */
export function meterForecast(m: Pick<CloudMeter, 'plan' | 'cycleStart' | 'nextReset' | 'usedSeconds' | 'limitSeconds'>, now: number, locale?: string): MeterForecast | null {
  if (m.plan === 'none' || m.limitSeconds == null || m.limitSeconds <= 0) return null;
  const start = Date.parse(m.cycleStart);
  const end = Date.parse(m.nextReset);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const elapsed = (Math.min(now, end) - start) / DAY;
  if (elapsed < 2 || m.usedSeconds < 1800) return null;
  const rate = m.usedSeconds / elapsed; // seconds per day
  const left = Math.max(0, (end - now) / DAY);
  const projected = Math.round(m.usedSeconds + rate * left);
  const fmt = (t: number) => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(new Date(t));
  if (m.usedSeconds >= m.limitSeconds) return { projectedSeconds: projected, runsOutAt: null, tone: 'danger', text: 'You’ve likely used this month’s hours already.' };
  if (projected >= m.limitSeconds) {
    const at = now + ((m.limitSeconds - m.usedSeconds) / rate) * DAY;
    return { projectedSeconds: projected, runsOutAt: new Date(at).toISOString(), tone: at - now < 5 * DAY ? 'danger' : 'warn', text: `At your pace you’d run out around ${fmt(at)}, before it resets on ${fmt(end)}.` };
  }
  return { projectedSeconds: projected, runsOutAt: null, tone: 'ok', text: `At your pace you’ll use about ${formatHours(projected)} of ${formatHours(m.limitSeconds)} by ${fmt(end)}.` };
}

// ------------------------------------------------------------------------------------------------ session insights

export interface CloudInsights {
  sessions: number;
  seconds: number;
  /** Median session length, seconds. */
  typicalSeconds: number | null;
  longestSeconds: number;
  byService: { service: CloudService; seconds: number; sessions: number }[];
  topGames: { gameId: string; seconds: number; sessions: number }[];
  /** The last 30 days against the 30 before (seconds). */
  last30: number;
  prev30: number;
  /** The hour of day (local) you start cloud sessions most, when there's a clear one. */
  usualHour: number | null;
}

/** Insights from cloud sessions VYSTRAL saw (Journal sessions with a cloud source). */
export function cloudInsights(sessions: readonly Pick<Session, 'gameId' | 'start' | 'durationSeconds' | 'source'>[], now: number): CloudInsights | null {
  const cloud = sessions.filter((s) => (s.source === 'cloud-gfn' || s.source === 'cloud-xbox') && s.durationSeconds > 0 && Number.isFinite(Date.parse(s.start)));
  if (!cloud.length) return null;
  const by = new Map<CloudService, { seconds: number; sessions: number }>();
  const games = new Map<string, { seconds: number; sessions: number }>();
  const hours = new Array<number>(24).fill(0);
  let last30 = 0;
  let prev30 = 0;
  let longest = 0;
  for (const s of cloud) {
    const service: CloudService = s.source === 'cloud-gfn' ? 'gfn' : 'xbox';
    const b = by.get(service) ?? { seconds: 0, sessions: 0 };
    b.seconds += s.durationSeconds; b.sessions++;
    by.set(service, b);
    const g = games.get(s.gameId) ?? { seconds: 0, sessions: 0 };
    g.seconds += s.durationSeconds; g.sessions++;
    games.set(s.gameId, g);
    const t = Date.parse(s.start);
    const age = (now - t) / DAY;
    if (age >= 0 && age < 30) last30 += s.durationSeconds;
    else if (age >= 30 && age < 60) prev30 += s.durationSeconds;
    longest = Math.max(longest, s.durationSeconds);
    hours[new Date(t).getHours()]++;
  }
  const sorted = cloud.map((s) => s.durationSeconds).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const typical = sorted.length >= 2 ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : null;
  const peak = hours.indexOf(Math.max(...hours));
  const usualHour = cloud.length >= 4 && hours[peak] / cloud.length >= 0.34 ? peak : null;
  return {
    sessions: cloud.length,
    seconds: cloud.reduce((a, s) => a + s.durationSeconds, 0),
    typicalSeconds: typical,
    longestSeconds: longest,
    byService: [...by.entries()].map(([service, v]) => ({ service, ...v })).sort((a, b) => b.seconds - a.seconds),
    topGames: [...games.entries()].map(([gameId, v]) => ({ gameId, ...v })).sort((a, b) => b.seconds - a.seconds).slice(0, 3),
    last30, prev30, usualHour,
  };
}

/** "Up 40% on the 30 days before", "About the same as the 30 days before", or null without a comparison. */
export function trendText(last30: number, prev30: number): string | null {
  if (prev30 < 1800 && last30 < 1800) return null;
  if (prev30 < 1800) return 'New this month: hardly any cloud play the 30 days before';
  const change = (last30 - prev30) / prev30;
  if (Math.abs(change) < 0.15) return 'About the same as the 30 days before';
  return `${change > 0 ? 'Up' : 'Down'} ${Math.round(Math.abs(change) * 100)}% on the 30 days before`;
}

// ------------------------------------------------------------------------------------------------ readiness

export const READINESS_LABEL: Record<CloudReadinessLevel, string> = { great: 'Great', good: 'Good', fair: 'Fair', poor: 'Poor', unknown: 'Not measured' };

export function readinessTone(level: CloudReadinessLevel): 'ok' | 'warn' | 'danger' | 'muted' {
  return level === 'great' || level === 'good' ? 'ok' : level === 'fair' ? 'warn' : level === 'poor' ? 'danger' : 'muted';
}

/** "Wi-Fi 5 GHz · 866 Mbps link", "Ethernet · 1 Gbps link", "Wi-Fi". */
export function linkText(r: Pick<CloudReadiness, 'link' | 'linkMbps' | 'wifiBand'>): string {
  const kind = { ethernet: 'Ethernet', wifi: 'Wi-Fi', cellular: 'Mobile data', other: 'Network', unknown: 'Network' }[r.link];
  const band = r.link === 'wifi' && r.wifiBand ? ` ${r.wifiBand} GHz` : '';
  const speed = r.linkMbps ? ` · ${r.linkMbps >= 1000 ? `${(r.linkMbps / 1000).toLocaleString()} Gbps` : `${Math.round(r.linkMbps)} Mbps`} link` : '';
  return `${kind}${band}${speed}`;
}

/** Whether a stored readiness result is still worth showing (networks change: a day at most). */
export function readinessFresh(r: Pick<CloudReadiness, 'checkedAt'> | null, now: number): boolean {
  if (!r) return false;
  const t = Date.parse(r.checkedAt);
  return Number.isFinite(t) && now - t < DAY;
}
