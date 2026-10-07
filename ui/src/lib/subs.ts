/**
 * Track V: your gaming subscriptions — plan names and marks, picking (one tier per family), which cloud services to
 * show, and honest wording for badges, "leaving soon", the value card and queue alerts. Pure functions (subs.test.ts).
 * Plan names follow Microsoft's October 2026 line-up (docs/research/CLOUD-GAMING.md): PC Game Pass, Game Pass
 * Essential, Premium and Ultimate; cloud gaming comes with Essential, Premium and Ultimate only.
 */
import type { CloudBadge, CloudMap, CloudQueueSignal, CloudService, GfnPlanId, Settings, SubsBadge, SubsFamily, SubsPlanId } from '../bridge/types';
import type { ServiceId } from './serviceMarks';

export interface PlanMeta {
  id: SubsPlanId;
  family: SubsFamily;
  /** "Game Pass Ultimate". */
  name: string;
  /** The tier on its own ("Ultimate"), or the plan name for one-tier families. */
  tier: string;
  /** What it includes, in a line. */
  blurb: string;
  /** Microsoft publishes a list VYSTRAL can read for it. */
  hasList: boolean;
  /** Includes Xbox Cloud Gaming. */
  cloud: boolean;
}

export const PLANS: PlanMeta[] = [
  { id: 'gp-pc', family: 'gamepass', name: 'PC Game Pass', tier: 'PC', blurb: 'PC games on day one, plus EA Play on PC. No cloud gaming.', hasList: true, cloud: false },
  { id: 'gp-essential', family: 'gamepass', name: 'Game Pass Essential', tier: 'Essential', blurb: 'Online play, a starter library and cloud gaming.', hasList: true, cloud: true },
  { id: 'gp-premium', family: 'gamepass', name: 'Game Pass Premium', tier: 'Premium', blurb: 'A bigger console and PC library, plus cloud gaming.', hasList: true, cloud: true },
  { id: 'gp-ultimate', family: 'gamepass', name: 'Game Pass Ultimate', tier: 'Ultimate', blurb: 'Everything: day-one games, EA Play, Ubisoft+ Classics and cloud gaming.', hasList: true, cloud: true },
  { id: 'ea-play', family: 'eaplay', name: 'EA Play', tier: 'EA Play', blurb: 'EA’s library and trials of new games.', hasList: true, cloud: false },
  { id: 'ea-play-pro', family: 'eaplay', name: 'EA Play Pro', tier: 'Pro', blurb: 'EA’s newest games in full, on PC.', hasList: true, cloud: false },
  { id: 'ubi-classics', family: 'ubisoft', name: 'Ubisoft+ Classics', tier: 'Classics', blurb: 'A rotating library of Ubisoft favourites.', hasList: true, cloud: false },
  { id: 'ubi-premium', family: 'ubisoft', name: 'Ubisoft+ Premium', tier: 'Premium', blurb: 'New Ubisoft releases on day one, with their extras.', hasList: true, cloud: false },
  { id: 'humble-choice', family: 'humble', name: 'Humble Choice', tier: 'Humble Choice', blurb: 'Monthly games to keep.', hasList: false, cloud: false },
  { id: 'prime-gaming', family: 'prime', name: 'Prime Gaming', tier: 'Prime Gaming', blurb: 'Free games with Prime, and Amazon Luna’s cloud channel.', hasList: false, cloud: false },
];

export const PLAN = Object.fromEntries(PLANS.map((p) => [p.id, p])) as Record<SubsPlanId, PlanMeta>;

export interface FamilyMeta {
  family: SubsFamily;
  name: string;
  mark: ServiceId;
  plans: SubsPlanId[];
}

export const FAMILIES: FamilyMeta[] = [
  { family: 'gamepass', name: 'Game Pass', mark: 'game-pass', plans: ['gp-pc', 'gp-essential', 'gp-premium', 'gp-ultimate'] },
  { family: 'eaplay', name: 'EA Play', mark: 'ea-play', plans: ['ea-play', 'ea-play-pro'] },
  { family: 'ubisoft', name: 'Ubisoft+', mark: 'ubisoft-plus', plans: ['ubi-classics', 'ubi-premium'] },
  { family: 'humble', name: 'Humble Choice', mark: 'humble-choice', plans: ['humble-choice'] },
  { family: 'prime', name: 'Prime Gaming', mark: 'prime-gaming', plans: ['prime-gaming'] },
];

export const FAMILY = Object.fromEntries(FAMILIES.map((f) => [f.family, f])) as Record<SubsFamily, FamilyMeta>;

const ORDER = PLANS.map((p) => p.id);

/** The stored comma list → valid plans in picker order, one per family (the higher tier wins), like the native side. */
export function parsePlans(csv: string | null | undefined): SubsPlanId[] {
  if (!csv || csv.length > 400) return [];
  const picked = new Set(csv.split(',').map((s) => s.trim()).filter((s): s is SubsPlanId => (ORDER as string[]).includes(s)));
  const out: SubsPlanId[] = [];
  for (const id of [...ORDER].reverse()) {
    if (picked.has(id) && !out.some((x) => PLAN[x].family === PLAN[id].family)) out.push(id);
  }
  return ORDER.filter((id) => out.includes(id));
}

export const serializePlans = (plans: SubsPlanId[]): string => parsePlans(plans.join(',')).join(',');

/** Picking a tier replaces the family's other tier; picking the chosen one again clears the family. */
export function togglePlan(current: SubsPlanId[], plan: SubsPlanId): SubsPlanId[] {
  const family = PLAN[plan].family;
  if (current.includes(plan)) return current.filter((p) => p !== plan);
  return parsePlans([...current.filter((p) => PLAN[p].family !== family), plan].join(','));
}

export function familyPlan(plans: SubsPlanId[], family: SubsFamily): SubsPlanId | null {
  return plans.find((p) => PLAN[p].family === family) ?? null;
}

export const hasListPlan = (plans: SubsPlanId[]) => plans.some((p) => PLAN[p].hasList);
export const gamePassPlan = (plans: SubsPlanId[]) => familyPlan(plans, 'gamepass');

/**
 * Cloud play shows only the services you have, once you've told VYSTRAL (null = show everything): GeForce NOW with
 * any membership, Xbox Cloud Gaming with Essential, Premium or Ultimate. "Show every service" turns this off.
 */
export function allowedCloudServices(s: Pick<Settings, 'subs.asked' | 'subs.cloudShowAll' | 'subs.owned' | 'cloud.gfnPlan'> | null | undefined): Set<CloudService> | null {
  if (!s || !s['subs.asked'] || s['subs.cloudShowAll']) return null;
  const plans = parsePlans(s['subs.owned']);
  const out = new Set<CloudService>();
  if (s['cloud.gfnPlan'] && s['cloud.gfnPlan'] !== 'none') out.add('gfn');
  if (plans.some((p) => PLAN[p].cloud)) out.add('xbox');
  return out;
}

/** The cloud map with services you don't have left out (the same object when nothing is hidden). */
export function filterCloudMap(map: CloudMap | null, allowed: Set<CloudService> | null): CloudMap | null {
  if (!map || !allowed) return map;
  const out: CloudMap = {};
  for (const [id, badges] of Object.entries(map)) {
    const kept = badges.filter((b: CloudBadge) => allowed.has(b.service));
    if (kept.length) out[id] = kept;
  }
  return out;
}

/** The plan names a GeForce NOW membership choice reads as in the picker. */
export const GFN_TIERS: { value: GfnPlanId; label: string }[] = [
  { value: 'none', label: 'No' },
  { value: 'free', label: 'Free' },
  { value: 'performance', label: 'Performance' },
  { value: 'ultimate', label: 'Ultimate' },
  { value: 'daypass', label: 'Day pass' },
];

/** "16 Oct" in the user's format; '' when invalid. */
export function shortDate(iso: string | null | undefined, locale?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(d);
}

/**
 * "Leaving soon", or with the Store listing's date: "Leaves today", "Leaves tomorrow", "Leaves around 16 Oct".
 * "Around", because the date comes from the Store listing rather than an announcement.
 */
export function leavingLabel(end: string | null | undefined, now = Date.now(), locale?: string, service?: string): string {
  const what = service ? ` ${service}` : '';
  const t = end ? Date.parse(end) : NaN;
  if (Number.isNaN(t) || t <= now) return `Leaving${what} soon`;
  const day = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const days = Math.round((day(t) - day(now)) / 86400000);
  if (days <= 0) return `Leaves${what} today`;
  if (days === 1) return `Leaves${what} tomorrow`;
  return `Leaves${what} around ${shortDate(end, locale)}`;
}

/** The game page and card wording for the plans that include a game. */
export function badgeText(badges: SubsBadge[]): { short: string; long: string; likely: boolean } | null {
  if (!badges.length) return null;
  const likely = badges.every((b) => b.match === 'title');
  const names = [...new Set(badges.map((b) => b.planName))];
  const first = FAMILY[badges[0].family]?.name ?? badges[0].planName;
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  return {
    short: badges.length > 1 ? `${first} +${names.length - 1}` : first,
    long: likely ? `Also in your ${list} (likely: matched by name)` : `Included with your ${list}`,
    likely,
  };
}

/** Badge spoken label for cards: "In your Game Pass Ultimate. Leaves around 16 Oct". */
export function badgeLabel(badges: SubsBadge[], now = Date.now()): string {
  const t = badgeText(badges);
  if (!t) return '';
  const leaving = badges.find((b) => b.leaving);
  return `${t.long}${leaving ? `. ${leavingLabel(leaving.leavingEnd, now, undefined, 'Game Pass')}` : ''}`;
}

/** "£0.62 an hour" with the code the user picked, or their Windows currency. */
export function formatMoney(amount: number, currency: string, locale?: string): string {
  const code = /^[A-Z]{3}$/.test(currency) ? currency : defaultCurrency(locale);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

/** The currency for the user's region (en-GB → GBP, de-DE → EUR); USD when unknown. */
export function defaultCurrency(locale?: string): string {
  const loc = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  const region = (() => {
    try { return new Intl.Locale(loc).maximize().region ?? ''; } catch { return ''; }
  })();
  return REGION_CURRENCY[region] ?? (EURO.has(region) ? 'EUR' : 'USD');
}

const EURO = new Set(['AT', 'BE', 'CY', 'DE', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PT', 'SI', 'SK']);
const REGION_CURRENCY: Record<string, string> = {
  US: 'USD', GB: 'GBP', CA: 'CAD', AU: 'AUD', NZ: 'NZD', JP: 'JPY', KR: 'KRW', IN: 'INR', BR: 'BRL', MX: 'MXN', CH: 'CHF', SE: 'SEK',
  NO: 'NOK', DK: 'DKK', PL: 'PLN', CZ: 'CZK', HU: 'HUF', TR: 'TRY', ZA: 'ZAR', SA: 'SAR', AR: 'ARS', CO: 'COP',
};

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'KRW', 'INR', 'BRL', 'MXN', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'TRY', 'ZAR', 'SAR', 'ARS', 'COP'];

/** The pill under a waiting cloud session: what the GeForce NOW window said, or nothing. */
export function queueText(q: CloudQueueSignal | null): string | null {
  if (!q || q.phase === 'none') return null;
  if (q.phase === 'starting') return 'Your stream is starting';
  if (q.position == null && q.etaMinutes == null) return null;
  const pos = q.position != null ? `Number ${q.position.toLocaleString()} in the queue` : 'In the queue';
  const eta = q.etaMinutes != null ? (q.etaMinutes <= 1 ? ' · about a minute' : ` · about ${q.etaMinutes} min`) : '';
  return `${pos}${eta}`;
}
