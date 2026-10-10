/**
 * Track C4: pure logic behind the game pages' stat tiles, review snapshot, price chart, franchise timeline and
 * community-tag filters. Everything here is unit-tested (gamePage.test.ts) and free of React.
 */
import type { LibraryTag, PricePoint, ReviewsSnapshot, Session } from '../bridge/types';

export type Tone = 'ok' | 'warn' | 'danger';

/** Steam's own colour bands: Positive from 70 %, Mixed from 40 %, Negative below. */
export function reviewTone(percent: number | null | undefined): Tone | null {
  if (percent == null || !Number.isFinite(percent)) return null;
  return percent >= 70 ? 'ok' : percent >= 40 ? 'warn' : 'danger';
}

/** "Up 5 points in the last 30 days", "Steady in the last 30 days" — or null when the trend isn't known. */
export function trendText(r: Pick<ReviewsSnapshot, 'trend' | 'trendPoints'>): string | null {
  if (!r.trend || r.trendPoints == null) return null;
  const pts = Math.abs(r.trendPoints);
  const n = pts >= 10 ? Math.round(pts) : Math.round(pts * 10) / 10;
  if (r.trend === 'steady') return 'Steady in the last 30 days';
  return `${r.trend === 'up' ? 'Up' : 'Down'} ${n} ${n === 1 ? 'point' : 'points'} in the last 30 days`;
}

export const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

// ---------- Sessions sparkline ----------

export interface WeekBucket {
  /** Monday of the week, local time, yyyy-MM-dd. */
  start: string;
  seconds: number;
  sessions: number;
}

const DAY = 86_400_000;

function mondayOf(t: number): Date {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Play time per week for the last `weeks` weeks (oldest first, this week last), by each session's start. */
export function weeklyPlay(sessions: Pick<Session, 'start' | 'durationSeconds'>[], weeks = 12, now = Date.now()): WeekBucket[] {
  const thisWeek = mondayOf(now);
  const buckets: WeekBucket[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(thisWeek);
    d.setDate(d.getDate() - i * 7);
    buckets.push({ start: ymd(d), seconds: 0, sessions: 0 });
  }
  const first = new Date(`${buckets[0].start}T00:00:00`).getTime();
  for (const s of sessions) {
    const t = Date.parse(s.start);
    if (!Number.isFinite(t) || t < first || t > now + DAY) continue;
    const idx = buckets.findIndex((b) => b.start === ymd(mondayOf(t)));
    if (idx < 0) continue;
    buckets[idx].seconds += Math.max(0, s.durationSeconds || 0);
    buckets[idx].sessions += 1;
  }
  return buckets;
}

// ---------- Price ----------

/** Where today's price sits between the lowest ever (0) and the regular price (1); null when it can't be said. */
export function pricePosition(nowCents: number | null, lowCents: number | null, regularCents: number | null): number | null {
  if (nowCents == null || lowCents == null || regularCents == null || regularCents <= lowCents) return null;
  return Math.max(0, Math.min(1, (nowCents - lowCents) / (regularCents - lowCents)));
}

export interface PriceChart {
  line: string;
  area: string;
  points: { x: number; y: number; day: string; cents: number }[];
  lowY: number | null;
  min: number;
  max: number;
  /** Clean tick values for the y axis (2–3 of them). */
  ticks: { y: number; cents: number }[];
  days: number;
}

/**
 * Step-line geometry over real time for the game page's price chart (prices change in steps). The lowest-ever line
 * is included in the scale when given (same currency only — the caller checks). Null with fewer than two points.
 */
export function priceChart(history: PricePoint[], width: number, height: number, lowCents: number | null, today = Date.now()): PriceChart | null {
  const pts = history.filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.day) && Number.isFinite(p.cents) && p.cents >= 0);
  if (pts.length < 2) return null;
  const t = pts.map((p) => Date.parse(`${p.day}T00:00:00Z`));
  const t0 = t[0];
  const tEnd = Math.max(t[t.length - 1], today);
  const span = Math.max(DAY, tEnd - t0);
  const values = pts.map((p) => p.cents);
  const scale = lowCents != null && lowCents >= 0 ? [...values, lowCents] : values;
  let lo = Math.min(...scale);
  let hi = Math.max(...scale);
  if (hi === lo) { hi += 100; lo = Math.max(0, lo - 100); }
  const pad = 6;
  const x = (ms: number) => +(((ms - t0) / span) * width).toFixed(2);
  const y = (v: number) => +(pad + (1 - (v - lo) / (hi - lo)) * (height - pad * 2)).toFixed(2);
  let line = `M${x(t[0])},${y(values[0])}`;
  for (let i = 1; i < pts.length; i++) line += ` H${x(t[i])} V${y(values[i])}`;
  line += ` H${x(tEnd)}`;
  const area = `${line} V${height} H${x(t[0])} Z`;
  const ticks = [hi, lo].map((cents) => ({ y: y(cents), cents }));
  return {
    line, area, lowY: lowCents != null && lowCents >= 0 ? y(lowCents) : null,
    points: pts.map((p, i) => ({ x: x(t[i]), y: y(values[i]), day: p.day, cents: p.cents })),
    min: Math.min(...values), max: Math.max(...values), ticks, days: Math.round(span / DAY),
  };
}

// ---------- Ratings ----------

export interface RatingRow {
  key: 'critics' | 'users' | 'metacritic' | 'steam';
  label: string;
  /** 0–100. */
  value: number;
  display: string;
  source: string;
  count: number | null;
}

/** Up to four scores on one 0–100 scale, each with its source. Missing ones are left out (never invented). */
export function ratingRows(input: {
  igdbCritics?: number | null; igdbCriticsCount?: number;
  igdbTotal?: number | null; igdbTotalCount?: number;
  rawgUsers?: number | null; rawgUsersCount?: number;
  metacritic?: number | null;
  steamPercent?: number | null; steamTotal?: number | null;
}): RatingRow[] {
  const rows: RatingRow[] = [];
  const ok = (v: number | null | undefined, max: number): v is number => v != null && Number.isFinite(v) && v >= 0 && v <= max;
  if (ok(input.igdbCritics, 100)) rows.push({ key: 'critics', label: 'Critics', value: input.igdbCritics, display: String(Math.round(input.igdbCritics)), source: 'IGDB critic average', count: input.igdbCriticsCount || null });
  if (ok(input.rawgUsers, 5)) rows.push({ key: 'users', label: 'Players', value: input.rawgUsers * 20, display: `${input.rawgUsers.toFixed(1)}/5`, source: 'RAWG user rating', count: input.rawgUsersCount || null });
  else if (ok(input.igdbTotal, 100)) rows.push({ key: 'users', label: 'Overall', value: input.igdbTotal, display: String(Math.round(input.igdbTotal)), source: 'IGDB critics and players combined', count: input.igdbTotalCount || null });
  if (ok(input.metacritic, 100) && input.metacritic >= 1) rows.push({ key: 'metacritic', label: 'Metacritic', value: input.metacritic, display: String(input.metacritic), source: 'Metacritic score shown on the Steam store', count: null });
  if (ok(input.steamPercent, 100)) rows.push({ key: 'steam', label: 'Steam reviews', value: input.steamPercent, display: `${Math.round(input.steamPercent)}%`, source: 'Positive Steam reviews, all time', count: input.steamTotal ?? null });
  return rows;
}

// ---------- Release ----------

/** "15 years ago", "this year", "in 3 months" — from a yyyy, yyyy-MM or yyyy-MM-dd date. Null when unreadable. */
export function releaseAge(date: string | null | undefined, now = new Date()): string | null {
  if (!date) return null;
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(date);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1950 || y > 2200) return null;
  const d = new Date(y, m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1);
  const months = (d.getFullYear() - now.getFullYear()) * 12 + (d.getMonth() - now.getMonth());
  if (!m[2]) {
    const years = now.getFullYear() - y;
    return years === 0 ? 'this year' : years > 0 ? `${years} ${years === 1 ? 'year' : 'years'} ago` : `in ${-years} ${years === -1 ? 'year' : 'years'}`;
  }
  if (d.getTime() > now.getTime()) return months <= 1 ? 'coming soon' : months < 24 ? `in ${months} months` : `in ${Math.round(months / 12)} years`;
  const ago = -months;
  if (ago < 1) return 'this month';
  if (ago < 24) return `${ago} ${ago === 1 ? 'month' : 'months'} ago`;
  return `${Math.floor(ago / 12)} years ago`;
}

// ---------- Franchise timeline ----------

/** Columns for the timeline: one per year that has games (gaps over two years are folded into a "…" spacer). */
export function timelineYears(years: (number | null)[]): (number | 'gap' | 'tba')[] {
  const known = [...new Set(years.filter((y): y is number => y != null))].sort((a, b) => a - b);
  const out: (number | 'gap' | 'tba')[] = [];
  known.forEach((y, i) => {
    if (i > 0 && y - known[i - 1] > 2) out.push('gap');
    out.push(y);
  });
  if (years.some((y) => y == null)) out.push('tba');
  return out;
}

// ---------- Community tags as filters ----------

/** True when the game has every selected tag. */
export function hasAllTags(gameId: string, selected: number[], games: Record<string, number[]> | undefined): boolean {
  if (!selected.length) return true;
  const mine = games?.[gameId];
  return !!mine && selected.every((id) => mine.includes(id));
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+#]+/g, ' ').trim();

/**
 * Pulls community tags out of a filter like "tagged roguelike", "with tag co-op", "#souls-like" or "tag:open world".
 * Only names that match a tag in the library count; the rest of the text is left for the normal filter.
 */
export function extractTags(text: string, tags: LibraryTag[]): { text: string; ids: number[]; names: string[] } {
  if (!tags.length || !text.trim()) return { text, ids: [], names: [] };
  const byName = new Map(tags.map((t) => [norm(t.name), t]));
  const found: LibraryTag[] = [];
  let rest = text;
  // Longest names first so "open world survival craft" wins over "open world".
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const take = (raw: string): LibraryTag | null => {
    const n = norm(raw);
    if (byName.has(n)) return byName.get(n)!;
    return null;
  };
  // "#name" / "tag:name" (a single word, or hyphenated/quoted)
  rest = rest.replace(/(?:#|\btag:)("[^"]+"|[\p{L}\p{N}][\p{L}\p{N}'+&-]*)/giu, (m, raw: string) => {
    const t = take(raw.replace(/^"|"$/g, '').replace(/-/g, ' '));
    if (t) { found.push(t); return ' '; }
    return m;
  });
  // "tagged X", "with tag X", "with the tag X": X is the longest known tag name at that point.
  const lead = /\b(?:tagged|with (?:the )?tags?)\s+/gi;
  let m: RegExpExecArray | null;
  while ((m = lead.exec(rest))) {
    const after = norm(rest.slice(m.index + m[0].length));
    const hit = names.find((n) => after === n || after.startsWith(`${n} `));
    if (!hit) continue;
    found.push(byName.get(hit)!);
    // Remove "tagged <name>" from the original text: as many typed words as it takes to spell the name.
    const tail = rest.slice(m.index + m[0].length).trim().split(/\s+/);
    let used = 1;
    while (used < tail.length && norm(tail.slice(0, used).join(' ')) !== hit) used++;
    rest = `${rest.slice(0, m.index)} ${tail.slice(used).join(' ')}`;
    lead.lastIndex = 0;
  }
  const unique = [...new Map(found.map((t) => [t.id, t])).values()];
  return { text: rest.replace(/\s{2,}/g, ' ').trim(), ids: unique.map((t) => t.id), names: unique.map((t) => t.name) };
}
