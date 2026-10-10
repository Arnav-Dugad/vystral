/**
 * Track D2: the wishlist as a release calendar. Pure helpers: release precision, the month grid, which games sit on
 * which day, the coming-soon lanes for vague dates, year-strip counts and keyboard movement inside the grid.
 *
 * Honesty rule: a game is put on a day only when Steam gives a day. A month, a quarter, a season, a year or no date
 * at all is shown with exactly that precision ("Q1 2027", "2027", "To be announced"), never as a guessed day.
 */
import type { ReleasePrecision, WishlistItem } from '../bridge/types';
import { priceVerdict } from './wishlist';

export interface Release {
  precision: ReleasePrecision;
  /** Local calendar day (midnight) when the precision is `day`. */
  day: Date | null;
  /** First and last day of the window (local midnight), null for `tba`. */
  from: Date | null;
  to: Date | null;
  /** What to call it when it isn't a day: "Q1 2027", "Summer 2027", "To be announced". */
  label: string | null;
}

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** yyyy-MM-dd → local midnight, or null. */
export function parseDay(s: string | null | undefined): Date | null {
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) || d.getMonth() !== +m[2] - 1 ? null : d;
}

export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const monthKey = (year: number, month: number) => `${year}-${pad(month + 1)}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const lastDay = (y: number, m: number) => new Date(y, m + 1, 0);

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/**
 * Reads a release-text fallback for answers that predate `releasePrecision` (the native side parses the full range of
 * Steam's formats; this keeps the calendar honest with an older backend).
 */
export function precisionFromText(text: string | null | undefined): Pick<Release, 'precision' | 'from' | 'to'> {
  const t = (text ?? '').trim().toLowerCase().replace(/^coming\s+/, '');
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})$/.exec(t))) return { precision: 'year', from: new Date(+m[1], 0, 1), to: new Date(+m[1], 11, 31) };
  if ((m = /^q([1-4])[\s,]+(\d{4})$/.exec(t))) {
    const q = +m[1] - 1;
    return { precision: 'quarter', from: new Date(+m[2], q * 3, 1), to: lastDay(+m[2], q * 3 + 2) };
  }
  if ((m = /^([a-z]+)\s+(\d{4})$/.exec(t))) {
    const month = MONTHS.indexOf(m[1]);
    if (month >= 0) return { precision: 'month', from: new Date(+m[2], month, 1), to: lastDay(+m[2], month) };
  }
  return { precision: 'tba', from: null, to: null };
}

/** The release of one wishlisted game, with the precision Steam really gives. */
export function releaseOf(item: Pick<WishlistItem, 'releaseDate' | 'comingSoon' | 'releaseText' | 'releasePrecision' | 'releaseFrom' | 'releaseTo' | 'releaseLabel'>): Release {
  const exact = item.releaseDate ? new Date(item.releaseDate) : null;
  const instant = exact && !Number.isNaN(exact.getTime()) ? exact : null;
  if (item.releasePrecision) {
    const from = parseDay(item.releaseFrom);
    if (item.releasePrecision === 'day') {
      // The local day of the release instant (when it unlocks here); the window's day when Steam gave only text.
      const day = instant ? startOfDay(instant) : from;
      if (day) return { precision: 'day', day, from: day, to: day, label: null };
      return { precision: 'tba', day: null, from: null, to: null, label: item.releaseLabel ?? item.releaseText ?? null };
    }
    const to = parseDay(item.releaseTo);
    if (item.releasePrecision !== 'tba' && from && to) return { precision: item.releasePrecision, day: null, from, to, label: item.releaseLabel ?? item.releaseText ?? null };
    return { precision: 'tba', day: null, from: null, to: null, label: item.releaseLabel ?? item.releaseText ?? null };
  }
  if (instant) {
    const day = startOfDay(instant);
    return { precision: 'day', day, from: day, to: day, label: null };
  }
  const guess = precisionFromText(item.releaseText);
  return { ...guess, day: null, label: item.releaseText ?? null };
}

/** A plain phrase for how precise the date is, for labels and screen readers. */
export function precisionNote(p: ReleasePrecision): string {
  switch (p) {
    case 'day': return 'exact date';
    case 'month': return 'Steam gives only the month';
    case 'quarter': return 'Steam gives only the quarter';
    case 'half': return 'Steam gives only the half of the year';
    case 'season': return 'Steam gives only a season or part of the year';
    case 'year': return 'Steam gives only the year';
    default: return 'no date yet';
  }
}

/** Display text for a non-day release; `fallback` when Steam said nothing at all. */
export function releaseWords(r: Release, comingSoon: boolean): string {
  if (r.label) return r.label;
  if (r.precision === 'tba') return comingSoon ? 'To be announced' : 'Out now';
  if (r.from) return r.from.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return 'To be announced';
}

// ---------- Week and month grid ----------

const SUNDAY_FIRST = new Set(['US', 'CA', 'MX', 'BR', 'JP', 'KR', 'TW', 'HK', 'IL', 'IN', 'PH', 'ZA', 'SA', 'AR', 'CO', 'PE', 'VE', 'GT', 'HN', 'NI', 'PA', 'PR', 'DO', 'SV', 'TH', 'ID', 'KE', 'PK']);

/** 0 = Sunday … 6 = Saturday, from the locale's week (Intl week info where available). */
export function firstDayOfWeek(locale?: string): number {
  const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
  try {
    const loc = new Intl.Locale(tag) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay % 7;
    const region = loc.maximize().region;
    if (region) return SUNDAY_FIRST.has(region) ? 0 : 1;
  } catch { /* an odd locale tag: Monday */ }
  return 1;
}

export interface MonthCell {
  date: Date;
  key: string;
  inMonth: boolean;
  isToday: boolean;
  isPast: boolean;
}

/** Whole weeks covering the month (4–6 rows), starting on `firstDay`. */
export function monthGrid(year: number, month: number, firstDay: number, today = new Date()): MonthCell[][] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() - firstDay + 7) % 7;
  const days = lastDay(year, month).getDate();
  const weeks = Math.ceil((lead + days) / 7);
  const t = startOfDay(today).getTime();
  const out: MonthCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const row: MonthCell[] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(year, month, 1 - lead + w * 7 + d);
      row.push({ date, key: dayKey(date), inMonth: date.getMonth() === month, isToday: date.getTime() === t, isPast: date.getTime() < t });
    }
    out.push(row);
  }
  return out;
}

/** Weekday names in grid order ("Mon", "Tue"… and the long form for labels). */
export function weekdayNames(firstDay: number, style: 'short' | 'long' = 'short'): string[] {
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + ((firstDay + i) % 7)).toLocaleDateString(undefined, { weekday: style }));
}

// ---------- Placing games ----------

export interface Placed {
  item: WishlistItem;
  release: Release;
}

export interface CalendarIndex {
  /** Exact days (yyyy-MM-dd). */
  byDay: Map<string, Placed[]>;
  /** Month-only dates (yyyy-MM). */
  byMonth: Map<string, Placed[]>;
  /** Everything without a day: month, quarter, half, season, year and no date. */
  vague: Placed[];
}

const byPriority = (a: Placed, b: Placed) => (a.item.priority || 1e9) - (b.item.priority || 1e9) || a.item.name.localeCompare(b.item.name);

export function indexWishlist(items: WishlistItem[]): CalendarIndex {
  const byDay = new Map<string, Placed[]>();
  const byMonth = new Map<string, Placed[]>();
  const vague: Placed[] = [];
  for (const item of items) {
    const release = releaseOf(item);
    const p = { item, release };
    if (release.precision === 'day' && release.day) {
      const k = dayKey(release.day);
      byDay.set(k, [...(byDay.get(k) ?? []), p]);
      continue;
    }
    if (release.precision === 'month' && release.from) {
      const k = monthKey(release.from.getFullYear(), release.from.getMonth());
      byMonth.set(k, [...(byMonth.get(k) ?? []), p]);
    }
    vague.push(p);
  }
  for (const list of byDay.values()) list.sort(byPriority);
  for (const list of byMonth.values()) list.sort(byPriority);
  return { byDay, byMonth, vague };
}

/** Games in the shown month, in date order: exact days first by day, then "sometime this month". */
export function monthAgenda(index: CalendarIndex, year: number, month: number): { days: { date: Date; games: Placed[] }[]; sometime: Placed[] } {
  const days: { date: Date; games: Placed[] }[] = [];
  const last = lastDay(year, month).getDate();
  for (let d = 1; d <= last; d++) {
    const date = new Date(year, month, d);
    const games = index.byDay.get(dayKey(date));
    if (games?.length) days.push({ date, games });
  }
  return { days, sometime: index.byMonth.get(monthKey(year, month)) ?? [] };
}

/** Releases per month of a year (exact days plus month-only dates), for the year strip. */
export function monthCounts(index: CalendarIndex, year: number): number[] {
  const counts = new Array<number>(12).fill(0);
  for (const [k, list] of index.byDay) if (k.startsWith(`${year}-`)) counts[+k.slice(5, 7) - 1] += list.length;
  for (const [k, list] of index.byMonth) if (k.startsWith(`${year}-`)) counts[+k.slice(5, 7) - 1] += list.length;
  return counts;
}

/** Months (yyyy-MM, sorted) that have at least one release on the calendar. */
export function monthsWithReleases(index: CalendarIndex): string[] {
  const keys = new Set<string>([...index.byDay.keys()].map((k) => k.slice(0, 7)));
  for (const k of index.byMonth.keys()) keys.add(k);
  return [...keys].sort();
}

/** The nearest month with releases after (dir 1) or before (dir -1) the given one, or null. */
export function nearestMonthWithReleases(index: CalendarIndex, year: number, month: number, dir: 1 | -1): { year: number; month: number } | null {
  const here = monthKey(year, month);
  const keys = monthsWithReleases(index);
  const pick = dir > 0 ? keys.find((k) => k > here) : [...keys].reverse().find((k) => k < here);
  return pick ? { year: +pick.slice(0, 4), month: +pick.slice(5, 7) - 1 } : null;
}

/** The next game with an exact day from today on (today's releases count), or null. */
export function nextRelease(index: CalendarIndex, today = new Date()): Placed | null {
  const t = dayKey(today);
  const keys = [...index.byDay.keys()].filter((k) => k >= t).sort();
  return keys.length ? index.byDay.get(keys[0])![0] : null;
}

// ---------- Coming-soon lanes ----------

export type LaneId = 'thisYear' | 'nextYear' | 'later' | 'tba' | 'out';

export interface Lane {
  id: LaneId;
  title: string;
  /** "2026", "2027", "2028 and later", or a plain line. */
  sub: string;
  items: Placed[];
}

/**
 * Lanes for games without a day: this year, next year, later, and no date yet. A window that started in an earlier year
 * but is still "coming soon" counts as this year. Games that are out but have no date from Steam get their own lane.
 * Within a lane: earliest window first, then the narrower window, then your wishlist order.
 */
export function releaseLanes(vague: Placed[], today = new Date()): Lane[] {
  const year = today.getFullYear();
  const lanes: Record<LaneId, Placed[]> = { thisYear: [], nextYear: [], later: [], tba: [], out: [] };
  for (const p of vague) {
    const { from } = p.release;
    if (p.release.precision === 'tba' || !from) {
      (p.item.comingSoon ? lanes.tba : lanes.out).push(p);
      continue;
    }
    const y = Math.max(from.getFullYear(), year);
    (y === year ? lanes.thisYear : y === year + 1 ? lanes.nextYear : lanes.later).push(p);
  }
  const time = (d: Date | null) => d?.getTime() ?? Infinity;
  for (const id of ['thisYear', 'nextYear', 'later'] as const)
    lanes[id].sort((a, b) => time(a.release.from) - time(b.release.from) || time(a.release.to) - time(b.release.to) || byPriority(a, b));
  lanes.tba.sort(byPriority);
  lanes.out.sort(byPriority);
  const out: Lane[] = [
    { id: 'thisYear', title: 'This year', sub: String(year), items: lanes.thisYear },
    { id: 'nextYear', title: 'Next year', sub: String(year + 1), items: lanes.nextYear },
    { id: 'later', title: 'Later', sub: `${year + 2} and later`, items: lanes.later },
    { id: 'tba', title: 'To be announced', sub: 'No date yet', items: lanes.tba },
    { id: 'out', title: 'Out now', sub: 'Steam doesn’t list a date', items: lanes.out },
  ];
  return out.filter((l) => l.items.length > 0);
}

// ---------- Markers, words ----------

export interface Markers {
  /** Percent off right now, or null. */
  cut: number | null;
  /** At (or below) the lowest price ever recorded. */
  lowest: boolean;
  belowLowest: boolean;
}

export function markersOf(item: WishlistItem): Markers {
  const v = priceVerdict(item);
  return { cut: item.discount > 0 ? item.discount : null, lowest: v.atLowest, belowLowest: v.belowLowest };
}

/** "Out today", "Out tomorrow", "Out in 5 days", "Out Tue 23 Feb 2027", "Came out 8 Sep 2026". */
export function dayWords(item: Pick<WishlistItem, 'comingSoon'>, day: Date, today = new Date()): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / DAY);
  if (diff === 0) return 'Out today';
  if (diff === 1 && item.comingSoon) return 'Out tomorrow';
  if (diff > 1 && diff <= 7 && item.comingSoon) return `Out in ${diff} days`;
  const long = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return diff < 0 || !item.comingSoon ? `Came out ${long}` : `Out ${long}`;
}

/**
 * The agenda's short line (the day itself sits next to it): "Out today", "In 11 days", "In 3 weeks", "In 4 months",
 * "Came out yesterday", "Came out 5 days ago", "Out now".
 */
export function agendaWhen(item: Pick<WishlistItem, 'comingSoon'>, day: Date, today = new Date()): string {
  const diff = Math.round((startOfDay(day).getTime() - startOfDay(today).getTime()) / DAY);
  if (diff === 0) return 'Out today';
  if (diff > 0 && item.comingSoon) {
    if (diff === 1) return 'Out tomorrow';
    if (diff <= 13) return `In ${diff} days`;
    if (diff <= 59) return `In ${Math.round(diff / 7)} weeks`;
    return `In ${Math.round(diff / 30.44)} months`;
  }
  if (diff === -1) return 'Came out yesterday';
  if (diff < 0 && diff >= -13) return `Came out ${-diff} days ago`;
  return 'Out now';
}

// ---------- Keyboard movement in the grid ----------

export type GridKey = 'left' | 'right' | 'up' | 'down' | 'home' | 'end';

/**
 * Where focus goes inside the month grid. `positions` are the focusable games in reading order (row = week,
 * col = weekday). Left/Right step through games in date order; Up/Down go to the nearest week above/below and the
 * closest column there; Home/End go to the first/last game. Returns the same index when there's nowhere to go.
 */
export function gridMove(positions: { row: number; col: number }[], current: number, key: GridKey): number {
  if (positions.length === 0) return -1;
  const i = Math.min(Math.max(current, 0), positions.length - 1);
  switch (key) {
    case 'left': return Math.max(0, i - 1);
    case 'right': return Math.min(positions.length - 1, i + 1);
    case 'home': return 0;
    case 'end': return positions.length - 1;
    default: {
      const here = positions[i];
      const down = key === 'down';
      let best = i;
      let bestScore = Infinity;
      positions.forEach((p, j) => {
        const rows = down ? p.row - here.row : here.row - p.row;
        if (rows <= 0) return;
        const score = rows * 100 + Math.abs(p.col - here.col) * 2 + (j < i ? 1 : 0);
        if (score < bestScore) { bestScore = score; best = j; }
      });
      return best;
    }
  }
}
