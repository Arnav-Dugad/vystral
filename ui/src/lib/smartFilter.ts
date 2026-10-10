/**
 * Track C5: smart collections. A collection with a `rule` is a live filter over the library (stored as JSON in the
 * collection; validated natively by Ai/SmartFilterSpec.cs when it's saved, and again here whenever it's read, since
 * the page must never trust stored data). Membership is computed on the fly, so the collection stays current.
 */
import type { Game, PlatformKey, SmartFilter, TimeToBeat } from '../bridge/types';
import { isInstalled, lastPlayed, playSeconds, sizeOf, PLATFORM_NAMES } from './format';
import { hasNeverBeenPlayed } from './neverPlayed';
import type { ParsedQuery } from './search';

const STATUSES = ['backlog', 'playing', 'beaten', 'completed', 'abandoned', 'none'] as const;
const PLATFORMS: PlatformKey[] = ['steam', 'xbox', 'epic', 'gog', 'ea', 'ubisoft', 'battlenet', 'manual'];
const RANGES: Record<string, [number, number]> = {
  ttbMaxHours: [0, 1000], ttbMinHours: [0, 1000],
  playedMaxHours: [0, 100000], playedMinHours: [0, 100000],
  notPlayedDays: [0, 36500], playedWithinDays: [0, 36500],
  sizeMaxGb: [0, 100000], sizeMinGb: [0, 100000],
  releasedFrom: [1950, 2100], releasedTo: [1950, 2100],
};
const BOOLS = ['installed', 'favorite', 'neverPlayed', 'inSubscription'] as const;

/** Rebuilds a rule from untrusted data (a stored rule, a bridge answer). Null when it's malformed or empty. */
export function parseSmartFilter(input: unknown): SmartFilter | null {
  let o: unknown = input;
  if (typeof o === 'string') {
    if (o.length > 4000) return null;
    try { o = JSON.parse(o); } catch { return null; }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const src = o as Record<string, unknown>;
  if (src.v !== undefined && src.v !== 1) return null;
  const r: SmartFilter = { v: 1 };
  let criteria = 0;
  for (const key of ['genresAny', 'genresNone'] as const) {
    const v = src[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 8 || !v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 40)) return null;
    if (v.length) { r[key] = [...new Set(v as string[])]; criteria++; }
  }
  for (const key of ['statusAny', 'statusNone'] as const) {
    const v = src[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length > 6 || !v.every((x) => (STATUSES as readonly unknown[]).includes(x))) return null;
    if (v.length) { r[key] = [...new Set(v)] as SmartFilter['statusAny']; criteria++; }
  }
  if (src.platforms !== undefined) {
    const v = src.platforms;
    if (!Array.isArray(v) || v.length > 8 || !v.every((x) => (PLATFORMS as unknown[]).includes(x))) return null;
    if (v.length) { r.platforms = [...new Set(v as string[])]; criteria++; }
  }
  for (const key of BOOLS) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return null;
    r[key] = v;
    criteria++;
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
    (r as unknown as Record<string, number>)[key] = v;
    criteria++;
  }
  if (src.titleIncludes !== undefined) {
    const v = src.titleIncludes;
    if (typeof v !== 'string' || v.length > 60) return null;
    if (v.trim()) { r.titleIncludes = v.trim(); criteria++; }
  }
  for (const [lo, hi] of [['ttbMinHours', 'ttbMaxHours'], ['playedMinHours', 'playedMaxHours'], ['sizeMinGb', 'sizeMaxGb'], ['releasedFrom', 'releasedTo']] as const)
    if (r[lo] != null && r[hi] != null && r[lo]! > r[hi]!) return null;
  return criteria ? r : null;
}

export interface SmartContext {
  /** IGDB time-to-beat estimates by game id (seconds). */
  ttb?: Record<string, TimeToBeat> | null;
  /** Games included in a subscription plan (by game id). */
  subs?: Record<string, unknown[]> | null;
  now?: number;
}

const lower = (s: string) => s.toLocaleLowerCase();

/** Whether a game belongs to the smart collection. Hidden games never do. */
export function matchesSmartFilter(g: Game, f: SmartFilter, ctx: SmartContext = {}): boolean {
  if (g.hidden) return false;
  const now = ctx.now ?? Date.now();
  const genres = g.genres.map(lower);
  if (f.genresAny?.length && !f.genresAny.some((w) => genres.includes(lower(w)))) return false;
  if (f.genresNone?.length && f.genresNone.some((w) => genres.includes(lower(w)))) return false;
  const status = g.status ?? 'none';
  if (f.statusAny?.length && !f.statusAny.includes(status)) return false;
  if (f.statusNone?.length && f.statusNone.includes(status)) return false;
  if (f.platforms?.length && !g.installations.some((i) => f.platforms!.includes(i.platform))) return false;
  if (f.installed != null && isInstalled(g) !== f.installed) return false;
  if (f.favorite != null && g.favorite !== f.favorite) return false;
  if (f.neverPlayed != null && hasNeverBeenPlayed(g) !== f.neverPlayed) return false;
  if (f.inSubscription != null && !!ctx.subs?.[g.id]?.length !== f.inSubscription) return false;
  if (f.ttbMaxHours != null || f.ttbMinHours != null) {
    const t = ctx.ttb?.[g.id];
    const est = t?.main ?? t?.extras ?? t?.completionist ?? null;
    if (est == null) return false; // no estimate: can't say it fits
    const h = est / 3600;
    if (f.ttbMaxHours != null && h > f.ttbMaxHours) return false;
    if (f.ttbMinHours != null && h < f.ttbMinHours) return false;
  }
  const played = playSeconds(g) / 3600;
  if (f.playedMaxHours != null && played > f.playedMaxHours) return false;
  if (f.playedMinHours != null && played < f.playedMinHours) return false;
  const lp = lastPlayed(g).at;
  if (f.notPlayedDays != null && lp && now - Date.parse(lp) < f.notPlayedDays * 86400000) return false;
  if (f.playedWithinDays != null && (!lp || now - Date.parse(lp) > f.playedWithinDays * 86400000)) return false;
  if (f.sizeMaxGb != null || f.sizeMinGb != null) {
    const size = sizeOf(g);
    if (size == null) return false;
    if (f.sizeMaxGb != null && size > f.sizeMaxGb * 1e9) return false;
    if (f.sizeMinGb != null && size < f.sizeMinGb * 1e9) return false;
  }
  if (f.releasedFrom != null || f.releasedTo != null) {
    const year = Number(g.releaseDate?.slice(0, 4));
    if (!Number.isFinite(year) || year < 1950) return false;
    if (f.releasedFrom != null && year < f.releasedFrom) return false;
    if (f.releasedTo != null && year > f.releasedTo) return false;
  }
  if (f.titleIncludes && !lower(g.title).includes(lower(f.titleIncludes))) return false;
  return true;
}

/** How many of the matching games were left out only because they have no time-to-beat estimate. */
export function missingTtbCount(games: Game[], f: SmartFilter, ctx: SmartContext): number {
  if (f.ttbMaxHours == null && f.ttbMinHours == null) return 0;
  const { ttbMaxHours: _a, ttbMinHours: _b, ...rest } = f;
  void _a; void _b;
  return games.filter((g) => !ctx.ttb?.[g.id] && matchesSmartFilter(g, rest as SmartFilter, ctx)).length;
}

const STATUS_WORD: Record<string, string> = { backlog: 'Backlog', playing: 'Playing', beaten: 'Beaten', completed: 'Completed', abandoned: 'Abandoned', none: 'No status' };
const n = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 1 });

/** The rule as readable chips, e.g. ["Casual or Simulation", "Not Beaten or Completed", "Under 20 h to beat"]. */
export function describeSmartFilter(f: SmartFilter): string[] {
  const out: string[] = [];
  if (f.genresAny?.length) out.push(f.genresAny.join(' or '));
  if (f.genresNone?.length) out.push(`Not ${f.genresNone.join(' or ')}`);
  if (f.statusAny?.length) out.push(f.statusAny.map((s) => STATUS_WORD[s]).join(' or '));
  if (f.statusNone?.length) out.push(`Not ${f.statusNone.map((s) => STATUS_WORD[s]).join(' or ')}`);
  if (f.platforms?.length) out.push(f.platforms.map((p) => PLATFORM_NAMES[p as PlatformKey] ?? p).join(' or '));
  if (f.installed != null) out.push(f.installed ? 'Installed' : 'Not installed');
  if (f.favorite != null) out.push(f.favorite ? 'Favorites' : 'Not favorites');
  if (f.neverPlayed != null) out.push(f.neverPlayed ? 'Never played' : 'Played before');
  if (f.inSubscription != null) out.push(f.inSubscription ? 'In my subscriptions' : 'Not in my subscriptions');
  if (f.ttbMinHours != null && f.ttbMaxHours != null) out.push(`${n(f.ttbMinHours)}–${n(f.ttbMaxHours)} h to beat`);
  else if (f.ttbMaxHours != null) out.push(`Under ${n(f.ttbMaxHours)} h to beat`);
  else if (f.ttbMinHours != null) out.push(`Over ${n(f.ttbMinHours)} h to beat`);
  if (f.playedMaxHours != null) out.push(`Played under ${n(f.playedMaxHours)} h`);
  if (f.playedMinHours != null) out.push(`Played over ${n(f.playedMinHours)} h`);
  if (f.notPlayedDays != null) out.push(`Not played in ${n(f.notPlayedDays)} days`);
  if (f.playedWithinDays != null) out.push(`Played in the last ${n(f.playedWithinDays)} days`);
  if (f.sizeMaxGb != null) out.push(`Under ${n(f.sizeMaxGb)} GB`);
  if (f.sizeMinGb != null) out.push(`Over ${n(f.sizeMinGb)} GB`);
  if (f.releasedFrom != null && f.releasedTo != null) out.push(f.releasedFrom === f.releasedTo ? `Released in ${f.releasedFrom}` : `Released ${f.releasedFrom}–${f.releasedTo}`);
  else if (f.releasedFrom != null) out.push(`Released ${f.releasedFrom} or later`);
  else if (f.releasedTo != null) out.push(`Released ${f.releasedTo} or earlier`);
  if (f.titleIncludes) out.push(`Title contains “${f.titleIncludes}”`);
  return out;
}

/**
 * Without AI: VYSTRAL's own query parser (the Library filter's) builds the rule. Words it doesn't understand are
 * reported, so nothing silently disappears.
 */
export function smartFilterFromQuery(parsed: ParsedQuery, sentence: string): { filter: SmartFilter | null; leftover: string } {
  const f = parsed.filters;
  const raw: Record<string, unknown> = { v: 1 };
  if (f.genres?.length) raw.genresAny = f.genres;
  if (f.platforms?.length) raw.platforms = f.platforms;
  if (f.installed != null) raw.installed = f.installed;
  if (f.favorite) raw.favorite = true;
  if (f.neverPlayed) raw.neverPlayed = true;
  if (f.status) raw.statusAny = [f.status];
  if (f.notPlayedDays != null) raw.notPlayedDays = f.notPlayedDays;
  if (f.playedWithinDays != null) raw.playedWithinDays = f.playedWithinDays;
  if (f.maxSizeBytes != null) raw.sizeMaxGb = Math.round((f.maxSizeBytes / 1e9) * 10) / 10;
  if (f.minSizeBytes != null) raw.sizeMinGb = Math.round((f.minSizeBytes / 1e9) * 10) / 10;
  // "unfinished" / "haven't finished" / "not beaten": the parser has no word for it, so read it here.
  const unfinished = /\b(unfinished|not finished|(?:i )?haven'?t finished|(?:i )?have not finished|not beaten|(?:i )?haven'?t beaten)\b/i;
  if (unfinished.test(sentence)) raw.statusNone = ['beaten', 'completed'];
  const hours = /\b(?:under|less than|shorter than|below)\s+(\d{1,3})\s*(?:h|hrs?|hours?)\b/i;
  const ttb = sentence.match(hours);
  if (ttb) raw.ttbMaxHours = Number(ttb[1]);
  const leftover = parsed.text.replace(unfinished, ' ').replace(hours, ' ').replace(/\b(games?|that|which|i|my|and|with)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return { filter: parseSmartFilter(raw), leftover };
}
