/**
 * Track D5: `recommend.v2` — VYSTRAL's one local recommendation engine. Home's "Picked for you", Discover's
 * "Recommended for you" and the re-ranked "Because you played" rows, Immersive's rows, the never-played "tonight"
 * picks and the assistant all score games here.
 *
 * Pure and synchronous: every input is passed in (your library, the tags and time-to-beat VYSTRAL already cached,
 * recent sessions, cloud and subscription lists, friends playing now, free space, what you said "Not interested" to)
 * and nothing is fetched, stored or sent anywhere. Same input, same answer — apart from a small rotation that changes
 * once a day so a shelf doesn't feel frozen.
 *
 * How it works:
 * 1. A taste profile: every game you played adds weight to its features (genres, Steam community tags, series,
 *    developer), weighted by hours (diminishing), recency (decayed, half-life ~5 months), your rating, its status and
 *    favourites. Games you abandoned or rated low, and things you dismissed, push their features down.
 * 2. Scoring: a candidate's taste match (a weighted cosine against the profile) plus context — installed or
 *    streamable, enough disk space, time to beat against the time you usually have at this hour, friends playing,
 *    plans that include it, wishlist, prices — each of which also leaves a plain-words reason behind.
 * 3. Diversity: maximal marginal relevance, so one series or genre can't fill a whole row.
 * 4. One explanation per pick, in plain words, built from its strongest reasons.
 */
import type { Game } from '../bridge/types';
import { hashString } from './color';
import { importedMinutes, isInstalled, lastPlayed, sizeOf } from './format';
import { hasNeverBeenPlayed, ownedSince, ageSpan } from './neverPlayed';

export const RECOMMEND_VERSION = 2;

const DAY = 86_400_000;
/** Recency half-life for taste: something you loved five months ago counts half as much as today. */
export const TASTE_HALF_LIFE_DAYS = 150;
/** Recently dismissed things teach more than old ones. */
const DISMISS_HALF_LIFE_DAYS = 180;
/** Played in the last two days: you're already playing it, no need to suggest it. */
const ALREADY_PLAYING_DAYS = 2;
/** MMR: 1 = pure relevance, 0 = pure variety. */
export const MMR_LAMBDA = 0.6;

// ------------------------------------------------------------------------------------------------ inputs

/** A session as the engine needs it (from sessions.list). */
export interface SessionLite {
  gameId: string;
  start: string;
  durationSeconds: number;
}

/** A "Not interested" record (kept locally by recommend.dismiss). */
export interface DismissedItem {
  /** `game:<library id>` | `discover:<discover key>` | `free:<giveaway id>` */
  key: string;
  title: string;
  /** Feature keys of what was dismissed (k:…, s:…, d:…), so the profile learns from it. */
  features: string[];
  at: string;
}

/** Time to beat, in seconds (IGDB estimates VYSTRAL cached). */
export interface TtbLite {
  main: number | null;
  extras?: number | null;
  completionist?: number | null;
}

/** Everything optional the engine can use. Missing pieces simply contribute nothing. */
export interface RecSignals {
  now: number;
  /** Track C4: Steam community tag names per library game id, strongest first. */
  tags?: Readonly<Record<string, readonly string[]>>;
  /** Track M/Y: IGDB time to beat per library game id. */
  ttb?: Readonly<Record<string, TtbLite>>;
  /** Recent sessions (any order; the newest few hundred are plenty). */
  sessions?: readonly SessionLite[];
  /** Track O: library game id → cloud services that list it (any non-empty list = streamable). */
  cloud?: Readonly<Record<string, readonly { service: string; match?: string }[]>>;
  /** Track P/W: library game id → how many friends are playing it right now. */
  friendsPlaying?: Readonly<Record<string, number>>;
  /** Free bytes per drive ("C:", "D:"), from system.drives. */
  freeBytes?: Readonly<Record<string, number>>;
  /** What you said "Not interested" to. */
  dismissed?: readonly DismissedItem[];
  /** A controller is connected: controller-friendly games get a nudge. */
  controller?: boolean;
  /** Library game ids known to play well with a controller (e.g. Steam Deck Verified). */
  controllerFriendly?: ReadonlySet<string>;
  /** The local time zone offset to use for "tonight" (minutes, as Date.getTimezoneOffset); tests pin it. */
  tzOffsetMinutes?: number;
}

/** A game you don't own, from any Discover source. */
export interface DiscoverCandidate {
  key: string;
  title: string;
  genres: readonly string[];
  tags?: readonly string[];
  year?: number | null;
  /** The library game a "Because you played" row was built from. */
  seedGameId?: string | null;
  /** Where it came from. */
  via: readonly CandidateSource[];
  free?: boolean;
  discountPercent?: number;
  comingSoon?: boolean;
  /** Set when it's actually in your library (it's then never recommended here). */
  libraryGameId?: string | null;
  /** A cloud service lists it. */
  cloud?: boolean;
  /** A plan you have includes it (its name, e.g. "Game Pass Ultimate"). */
  planName?: string | null;
  /** Friends playing it now. */
  friends?: number;
  /** A giveaway's end date (ISO), for "free until Thursday". */
  freeUntil?: string | null;
  /** Free-to-keep giveaway on this store ("Epic Games Store"). */
  freeOn?: string | null;
}

export type CandidateSource = 'because' | 'store' | 'wishlist' | 'watching' | 'subs' | 'free' | 'friends' | 'search' | 'genre';

// ------------------------------------------------------------------------------------------------ outputs

export type ReasonCode =
  | 'taste' | 'seed' | 'lapsed' | 'inProgress' | 'unplayed' | 'backlog' | 'favorite' | 'rated'
  | 'wishlist' | 'plan' | 'friends' | 'free' | 'sale' | 'watching'
  | 'timeFit' | 'finishTonight' | 'installed' | 'cloud' | 'noSpace' | 'controller' | 'new';

export interface Reason {
  code: ReasonCode;
  /** Plain words, written to stand on their own ("You love Racing and Open World"). */
  text: string;
  /** How much it contributed to the score. */
  weight: number;
}

export interface Recommendation {
  /** Library game id (kind 'library') or Discover key (kind 'discover'). */
  id: string;
  kind: 'library' | 'discover';
  title: string;
  /** Final score after context (before diversity), higher is better. */
  score: number;
  /** The taste match alone, −1..1. */
  match: number;
  /** One sentence: why this pick. */
  reason: string;
  /** Every reason that contributed, strongest first (for the assistant and tooltips). */
  reasons: Reason[];
  /** Feature keys (for "Not interested" learning and diversity). */
  features: string[];
  /** The key "Not interested" stores. */
  dismissKey: string;
}

// ------------------------------------------------------------------------------------------------ features

/** Steam tags that say little about taste on their own; they still count, at half weight. */
const WEAK_TAGS = new Set([
  'singleplayer', 'multiplayer', 'indie', 'casual', 'action', 'adventure', 'early access', 'free to play', 'great soundtrack',
  'full controller support', 'controller', '2d', '3d', 'atmospheric', 'colorful', 'cute', 'funny', 'beautiful', 'classic',
  'online co op', 'co op', 'pvp', 'pve', 'family friendly', 'steam achievements', 'steam cloud', 'partial controller support',
]);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const ROMAN = /\s+(?:i{1,3}|iv|v|vi{1,3}|ix|x)$/;
const EDITION_WORDS = /\s+(?:remastered|remaster|remake|definitive|deluxe|premium|gold|standard|collectors|goty|game of the year|complete|ultimate|enhanced|anniversary|hd|redux|reloaded|directors cut|edition)\b.*$/;

/**
 * A series key from a title: "Kingsfall Remastered" and "Kingsfall II: Ashes" both give "kingsfall". Subtitles,
 * edition words and sequel numbers are dropped. Short or generic results (under four letters) give null, so "The"
 * or "F1" never ties unrelated games together.
 */
export function seriesKey(title: string): string | null {
  let t = title.split(/\s*[:–—]\s*|\s+-\s+/)[0] ?? title;
  t = fold(t).replace(/^the\s+/, '');
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(EDITION_WORDS, '').replace(/\s+\d{1,4}$/, '').replace(ROMAN, '').trim();
    if (t === before) break;
  }
  return t.replace(/\s+/g, '').length >= 4 ? t : null;
}

/** Feature key and display label for a genre or tag (one key for both: "Racing" the genre and "Racing" the tag agree). */
function kw(label: string): [string, string] | null {
  const f = fold(label);
  return f.length >= 2 && f.length <= 48 ? [`k:${f}`, label.trim()] : null;
}

export interface Features {
  /** feature key → weight (0..1) */
  w: Map<string, number>;
  /** feature key → display label */
  labels: Map<string, string>;
}

function addFeature(f: Features, key: string, label: string, weight: number) {
  const prev = f.w.get(key) ?? 0;
  if (weight > prev) f.w.set(key, weight);
  if (!f.labels.has(key)) f.labels.set(key, label);
}

/** Features of anything with a title, genres and (optionally) community tags and a developer. */
export function featuresOf(item: { title: string; genres?: readonly string[]; tags?: readonly string[]; developer?: string | null }): Features {
  const f: Features = { w: new Map(), labels: new Map() };
  for (const g of item.genres ?? []) {
    const k = kw(g);
    if (k) addFeature(f, k[0], k[1], 1);
  }
  (item.tags ?? []).slice(0, 12).forEach((t, i) => {
    const k = kw(t);
    if (!k) return;
    const base = Math.max(0.35, 1 - i * 0.08);
    addFeature(f, k[0], k[1], WEAK_TAGS.has(fold(t)) ? base * 0.45 : base);
  });
  const s = seriesKey(item.title);
  if (s) addFeature(f, `s:${s}`, item.title.split(/\s*[:–—]\s*/)[0].trim(), 0.9);
  if (item.developer) {
    const d = fold(item.developer);
    if (d.length >= 2 && d.length <= 48) addFeature(f, `d:${d}`, item.developer.trim(), 0.45);
  }
  return f;
}

export function gameFeatures(g: Game, signals?: Pick<RecSignals, 'tags'>): Features {
  return featuresOf({ title: g.title, genres: g.genres, tags: signals?.tags?.[g.id], developer: g.developer });
}

// ------------------------------------------------------------------------------------------------ taste profile

export interface TasteProfile {
  /** feature key → affinity, −1..1 (1 = your strongest liking). */
  affinity: Map<string, number>;
  /** The unnormalised sums behind `affinity` and their scale (so one game's own share can be taken back out exactly). */
  raw: Map<string, number>;
  rawMax: number;
  /** Library game id → its unnormalised engagement. */
  rawEngagement: Map<string, number>;
  labels: Map<string, string>;
  /** Library game id → how much that game says about your taste, −1..1. */
  engagement: Map<string, number>;
  /** Games with any playtime. */
  playedGames: number;
  totalHours: number;
  /** Median length of your recent sessions (seconds), or null when there are too few. */
  typicalSessionSeconds: number | null;
  /** Share of your playtime in each hour of the week (index = day * 24 + hour, local time, Sunday = 0). */
  rhythm: number[];
  /** Sessions the rhythm and session length were learned from. */
  sessionSamples: number;
}

/** Your playtime in seconds: the larger of tracked and store-reported (stores already include tracked time). */
export function playedSecondsOf(g: Game): number {
  return Math.max(Math.max(0, g.trackedSeconds || 0), (importedMinutes(g) ?? 0) * 60);
}

/**
 * How much one game tells about your taste, signed. Hours count with diminishing returns (log), decayed by how long
 * ago you last played; favourites, high ratings and finishing it add; low ratings and abandoning it subtract.
 */
export function engagementOf(g: Game, now: number): number {
  const hours = playedSecondsOf(g) / 3600;
  let w = Math.log1p(hours);
  const at = Date.parse(lastPlayed(g).at ?? '');
  const days = Number.isFinite(at) ? Math.max(0, (now - at) / DAY) : null;
  // Played at some point but the store never said when: a moderate, old-ish signal.
  const decay = days == null ? (hours > 0 ? 0.4 : 0) : 0.5 ** (days / TASTE_HALF_LIFE_DAYS);
  w *= 0.3 + 0.7 * decay;
  if (g.favorite) w += 1.2;
  if (g.status === 'completed' || g.status === 'beaten') w += 0.5;
  if (g.userRating != null) {
    if (g.userRating >= 4) w += (g.userRating - 3) * 0.6;
    else if (g.userRating <= 2) w = -Math.max(0.6, Math.abs(w) * 0.6) * (3 - g.userRating);
  }
  if (g.status === 'abandoned') w = -Math.max(0.5, Math.abs(w) * 0.5);
  return w;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Local (day, hour) of an instant, honouring a pinned time-zone offset in tests. */
function localParts(ms: number, tzOffsetMinutes?: number): { day: number; hour: number } {
  if (tzOffsetMinutes == null) {
    const d = new Date(ms);
    return { day: d.getDay(), hour: d.getHours() };
  }
  const d = new Date(ms - tzOffsetMinutes * 60_000);
  return { day: d.getUTCDay(), hour: d.getUTCHours() };
}

/** Builds the taste profile. Games you dismissed (and their features) push the profile away from them. */
export function buildTasteProfile(games: readonly Game[], signals: RecSignals): TasteProfile {
  const { now } = signals;
  const raw = new Map<string, number>();
  const labels = new Map<string, string>();
  const engagement = new Map<string, number>();
  let played = 0;
  let totalHours = 0;
  for (const g of games) {
    if (g.hidden) continue;
    const secs = playedSecondsOf(g);
    if (secs > 0) {
      played++;
      totalHours += secs / 3600;
    }
    const e = engagementOf(g, now);
    if (e === 0) continue;
    engagement.set(g.id, e);
    const f = gameFeatures(g, signals);
    for (const [k, w] of f.w) {
      raw.set(k, (raw.get(k) ?? 0) + e * w);
      if (!labels.has(k)) labels.set(k, f.labels.get(k)!);
    }
  }
  // "Not interested" teaches too: each dismissal pushes its features down a little (less as it ages).
  for (const d of signals.dismissed ?? []) {
    const at = Date.parse(d.at);
    const age = Number.isFinite(at) ? Math.max(0, (now - at) / DAY) : 0;
    const strength = 0.45 * 0.5 ** (age / DISMISS_HALF_LIFE_DAYS);
    for (const k of d.features.slice(0, 12)) raw.set(k, (raw.get(k) ?? 0) - strength);
  }
  // Normalise to −1..1 by the strongest positive (so one huge game can't make everything else look like zero:
  // the square root keeps the middle of the range meaningful).
  let max = 0;
  for (const v of raw.values()) max = Math.max(max, Math.abs(v));
  const affinity = new Map<string, number>();
  if (max > 0) for (const [k, v] of raw) affinity.set(k, Math.sign(v) * Math.sqrt(Math.abs(v) / max));
  const rawEngagement = new Map(engagement);
  let emax = 0;
  for (const v of engagement.values()) emax = Math.max(emax, Math.abs(v));
  if (emax > 0) for (const [k, v] of engagement) engagement.set(k, v / emax);

  // Rhythm and session length from recent sessions (at least five minutes long, the newest 400).
  const recent = [...(signals.sessions ?? [])]
    .filter((s) => s.durationSeconds >= 300 && Number.isFinite(Date.parse(s.start)))
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start))
    .slice(0, 400);
  const rhythm = new Array<number>(168).fill(0);
  let rTotal = 0;
  for (const s of recent) {
    const { day, hour } = localParts(Date.parse(s.start), signals.tzOffsetMinutes);
    rhythm[day * 24 + hour] += s.durationSeconds;
    rTotal += s.durationSeconds;
  }
  if (rTotal > 0) for (let i = 0; i < 168; i++) rhythm[i] /= rTotal;
  const typical = recent.length >= 3 ? median(recent.slice(0, 60).map((s) => s.durationSeconds)) : null;

  return { affinity, raw, rawMax: max, rawEngagement, labels, engagement, playedGames: played, totalHours, typicalSessionSeconds: typical, rhythm, sessionSamples: recent.length };
}

// ------------------------------------------------------------------------------------------------ "tonight"

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayPartOf(hour: number): DayPart {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 23) return 'evening';
  return 'night';
}

export interface TimeWindow {
  /** How long you usually play when you start around now (seconds). */
  seconds: number;
  /** "Friday evenings", "weekday evenings", "an evening" (for sentences). */
  label: string;
  /** How many sessions it's based on. */
  samples: number;
}

/**
 * How much time you usually have when you sit down around now: the median length of your sessions that started
 * within two hours of this time on the same weekday (or the same kind of day, or any day). Null with too little history.
 */
export function timeWindow(signals: Pick<RecSignals, 'sessions' | 'now' | 'tzOffsetMinutes'>): TimeWindow | null {
  const sessions = (signals.sessions ?? []).filter((s) => s.durationSeconds >= 300 && Number.isFinite(Date.parse(s.start)));
  if (sessions.length < 3) return null;
  const here = localParts(signals.now, signals.tzOffsetMinutes);
  const part = dayPartOf(here.hour);
  const weekend = (d: number) => d === 0 || d === 6;
  const near = sessions.map((s) => ({ s, p: localParts(Date.parse(s.start), signals.tzOffsetMinutes) }))
    .filter(({ p }) => Math.min(Math.abs(p.hour - here.hour), 24 - Math.abs(p.hour - here.hour)) <= 2);
  const plural = { morning: 'mornings', afternoon: 'afternoons', evening: 'evenings', night: 'late nights' }[part];
  const sameDay = near.filter(({ p }) => p.day === here.day);
  if (sameDay.length >= 3) return { seconds: median(sameDay.map(({ s }) => s.durationSeconds))!, label: `${DAY_NAMES[here.day]} ${plural}`, samples: sameDay.length };
  const sameKind = near.filter(({ p }) => weekend(p.day) === weekend(here.day));
  if (sameKind.length >= 3) return { seconds: median(sameKind.map(({ s }) => s.durationSeconds))!, label: `${weekend(here.day) ? 'weekend' : 'weekday'} ${plural}`, samples: sameKind.length };
  if (near.length >= 3) return { seconds: median(near.map(({ s }) => s.durationSeconds))!, label: plural, samples: near.length };
  return { seconds: median(sessions.slice(0, 60).map((s) => s.durationSeconds))!, label: 'a session', samples: sessions.length };
}

/** "45 minutes", "about an hour", "about 2 hours", "about 2½ hours". */
export function spanWords(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 55) return `${Math.max(5, Math.round(m / 5) * 5)} minutes`;
  const halves = Math.round(seconds / 1800) / 2;
  if (halves <= 1) return 'about an hour';
  return `about ${Math.floor(halves)}${halves % 1 ? '½' : ''} hours`;
}

/** "90-minute", "1-hour", "2-hour", "2½-hour" (for "your usual 2-hour sessions"). */
export function spanAdjective(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 55) return `${Math.max(5, Math.round(m / 5) * 5)}-minute`;
  const halves = Math.max(1, Math.round(seconds / 1800) / 2);
  return `${Math.floor(halves)}${halves % 1 ? '½' : ''}-hour`;
}

// ------------------------------------------------------------------------------------------------ scoring

/** Weighted cosine of a candidate's features against the profile, and the features that matched best. */
export function tasteMatch(f: Features, profile: TasteProfile): { match: number; top: { key: string; label: string; aff: number }[] } {
  let dot = 0;
  let norm = 0;
  const contrib: { key: string; label: string; aff: number; c: number }[] = [];
  for (const [k, w] of f.w) {
    const a = profile.affinity.get(k) ?? 0;
    dot += a * w;
    norm += w * w;
    if (a !== 0) contrib.push({ key: k, label: profile.labels.get(k) ?? f.labels.get(k) ?? k.slice(2), aff: a, c: a * w });
  }
  // Damped normalisation: a game with one strong matching genre isn't penalised for having many tags.
  const match = norm > 0 ? Math.max(-1, Math.min(1, dot / Math.sqrt(norm) / 1.15)) : 0;
  contrib.sort((x, y) => y.c - x.c);
  return { match, top: contrib.filter((c) => c.aff > 0.25 && !c.key.startsWith('d:')).slice(0, 3).map(({ key, label, aff }) => ({ key, label, aff })) };
}

const hoursWords = (secs: number) => {
  const h = secs / 3600;
  return h >= 1.5 ? `${Math.round(h)} hours` : h >= 0.75 ? 'an hour' : `${Math.max(5, Math.round((secs / 60) / 5) * 5)} minutes`;
};

function relDays(days: number): string {
  if (days < 14) return `${Math.round(days)} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30.44)} months ago`;
  const y = Math.round(days / 365.25);
  return y <= 1 ? 'a year ago' : `${y} years ago`;
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function tasteReason(top: { key: string; label: string; aff: number }[]): Reason | null {
  if (!top.length) return null;
  const series = top.find((t) => t.key.startsWith('s:') && t.aff >= 0.4);
  if (series) return { code: 'taste', text: `You loved the other ${series.label} games`, weight: 0 };
  const kinds = top.filter((t) => t.key.startsWith('k:'));
  if (!kinds.length) return null;
  const strong = kinds.filter((t) => t.aff >= 0.55).slice(0, 2);
  if (strong.length) return { code: 'taste', text: `You love ${joinLabels(strong.map((t) => t.label))}`, weight: 0 };
  return { code: 'taste', text: `You often play ${joinLabels(kinds.slice(0, 2).map((t) => t.label))}`, weight: 0 };
}

/** Daily rotation in 0..1, stable within a day. */
const rotation = (id: string, now: number) => (hashString(`${id}:${Math.floor(now / DAY)}`) % 1000) / 1000;

export interface LibraryOptions {
  limit?: number;
  /** 'all' = installed first but anything goes; 'installed' = ready to play now; 'cloud' = streamable, not installed; 'unplayed' = never played. */
  mode?: 'all' | 'installed' | 'cloud' | 'unplayed';
  /** Diversify with MMR (default true). */
  diversify?: boolean;
}

/** Scores one library game (null = not a candidate: hidden, dismissed, being played, done with). */
export function scoreLibraryGame(g: Game, profile: TasteProfile, signals: RecSignals, window: TimeWindow | null, mode: LibraryOptions['mode'] = 'all'): Recommendation | null {
  const { now } = signals;
  if (g.hidden) return null;
  const dismissKey = `game:${g.id}`;
  if (signals.dismissed?.some((d) => d.key === dismissKey)) return null;
  const installed = isInstalled(g);
  const streamable = !!signals.cloud?.[g.id]?.length;
  const never = hasNeverBeenPlayed(g);
  if (mode === 'installed' && !installed) return null;
  if (mode === 'cloud' && (installed || !streamable)) return null;
  if (mode === 'unplayed' && !never) return null;
  if (g.status === 'abandoned') return null;
  if ((g.status === 'completed' || g.status === 'beaten') && !g.favorite) return null;

  const at = Date.parse(lastPlayed(g).at ?? '');
  const days = Number.isFinite(at) ? (now - at) / DAY : null;
  if (days != null && days < ALREADY_PLAYING_DAYS) return null;

  const f = gameFeatures(g, signals);
  // The game's own contribution to the profile would make every played game match itself; take it back out.
  const self = profile.rawEngagement.get(g.id) ?? 0;
  const { match, top } = tasteMatch(f, self !== 0 ? withoutSelf(profile, f, self) : profile);
  const reasons: Reason[] = [];
  let score = match * 2.2;
  const taste = tasteReason(top);
  if (taste) reasons.push({ ...taste, weight: Math.max(0.05, match * 2.2) });

  const secs = playedSecondsOf(g);
  if (never) {
    const since = ownedSince(g);
    const span = since ? ageSpan(since.at, now) : null;
    score += 0.55 + (g.status === 'backlog' ? 0.3 : 0);
    reasons.push(g.status === 'backlog'
      ? { code: 'backlog', text: 'On your backlog, never played', weight: 0.85 }
      : { code: 'unplayed', text: span && span !== 'today' ? `Never played, waiting ${span}` : 'Never played yet', weight: 0.55 });
  } else if (days == null) {
    score += 0.45 + (secs > 5 * 3600 ? 0.4 : 0);
    if (secs > 3600) reasons.push({ code: 'lapsed', text: `You put ${hoursWords(secs)} into it`, weight: 0.5 });
  } else if (days > 21) {
    const lapse = Math.min(1, days / 120) * (secs > 5 * 3600 ? 1.2 : secs > 3600 ? 0.8 : 0.4);
    score += 0.35 + lapse;
    reasons.push({ code: 'lapsed', text: secs > 3 * 3600 ? `Last played ${relDays(days)}, after ${hoursWords(secs)}` : `Last played ${relDays(days)}`, weight: 0.35 + lapse });
  } else {
    // Played in the last three weeks but not the last two days: in the middle of it.
    const inProgress = g.status === 'playing' || secs > 2 * 3600;
    score += inProgress ? 0.75 : 0.3;
    if (inProgress) reasons.push({ code: 'inProgress', text: `Pick up where you left off ${relDays(days)}`, weight: 0.75 });
  }
  if (g.favorite) {
    score += 0.45;
    reasons.push({ code: 'favorite', text: 'One of your favorites', weight: 0.45 });
  }
  if (g.userRating != null && g.userRating >= 4) {
    score += (g.userRating - 3) * 0.25;
    reasons.push({ code: 'rated', text: `You rated it ${g.userRating} out of 5`, weight: (g.userRating - 3) * 0.25 });
  }

  // Ready now, or not.
  if (installed) {
    score += 0.5;
    reasons.push({ code: 'installed', text: 'Installed and ready', weight: 0.2 });
  } else if (streamable) {
    score += 0.3;
    reasons.push({ code: 'cloud', text: 'Playable in the cloud, no download', weight: 0.3 });
  } else {
    score -= 0.35;
    const size = sizeOf(g) ?? g.installations.reduce((m, i) => Math.max(m, i.sizeBytes ?? 0), 0);
    const free = Object.values(signals.freeBytes ?? {});
    if (size > 0 && free.length && free.every((b) => b < size * 1.1)) {
      score -= 0.4;
      reasons.push({ code: 'noSpace', text: 'Needs more free space than any drive has', weight: -0.4 });
    }
  }

  // Time to beat against the time you usually have now.
  const ttb = signals.ttb?.[g.id];
  const main = ttb?.main ?? ttb?.extras ?? null;
  if (main && main > 0 && window) {
    const remaining = Math.max(0, main - secs);
    if (remaining > 0) {
      const sittings = remaining / Math.max(600, window.seconds);
      if (sittings <= 1.15) {
        score += 0.45;
        reasons.push({ code: 'finishTonight', text: `Short enough to finish in your usual ${spanWords(window.seconds).replace(/^about /, '')} on ${window.label}`, weight: 0.45 });
      } else if (sittings <= 6) {
        score += 0.25;
        reasons.push({ code: 'timeFit', text: `About ${Math.ceil(sittings)} of your usual ${spanAdjective(window.seconds)} sessions to finish`, weight: 0.25 });
      } else if (sittings > 40 && window.seconds < 3600) {
        score -= 0.15;
      }
    }
  }

  const friends = signals.friendsPlaying?.[g.id] ?? 0;
  if (friends > 0) {
    const w = Math.min(0.9, 0.45 + 0.15 * friends);
    score += w;
    reasons.push({ code: 'friends', text: friends === 1 ? 'A friend is playing it right now' : `${friends} friends are playing it right now`, weight: w });
  }
  if (signals.controller && signals.controllerFriendly?.has(g.id)) {
    score += 0.12;
    reasons.push({ code: 'controller', text: 'Plays well with the controller you have connected', weight: 0.12 });
  }
  score += rotation(g.id, now) * 0.18;

  reasons.sort((a, b) => b.weight - a.weight);
  return {
    id: g.id, kind: 'library', title: g.title, score, match, reasons, features: [...f.w.keys()], dismissKey,
    reason: explain(reasons, { kind: 'library', never }),
  };
}

/** The profile with one game's own contribution taken back out (so a game doesn't recommend itself to you). */
function withoutSelf(profile: TasteProfile, f: Features, self: number): TasteProfile {
  if (self === 0 || profile.rawMax <= 0) return profile;
  const affinity = new Map(profile.affinity);
  for (const [k, w] of f.w) {
    const r = (profile.raw.get(k) ?? 0) - self * w;
    if (Math.abs(r) < 1e-9) affinity.delete(k);
    else affinity.set(k, Math.sign(r) * Math.sqrt(Math.min(1, Math.abs(r) / profile.rawMax)));
  }
  return { ...profile, affinity };
}

/** Recommendations from your own library ("rediscover"), diversified, each with its reason. */
export function recommendLibrary(games: readonly Game[], profile: TasteProfile, signals: RecSignals, opts: LibraryOptions = {}): Recommendation[] {
  const limit = opts.limit ?? 12;
  const window = timeWindow(signals);
  const scored: Recommendation[] = [];
  for (const g of games) {
    const r = scoreLibraryGame(g, profile, signals, window, opts.mode ?? 'all');
    if (r) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return opts.diversify === false ? scored.slice(0, limit) : diversify(scored, limit);
}

/** Scores one game you don't own (null = not a candidate: owned, dismissed). */
export function scoreDiscover(c: DiscoverCandidate, profile: TasteProfile, signals: RecSignals, games?: ReadonlyMap<string, Game>): Recommendation | null {
  const dismissKey = `discover:${c.key}`;
  if (c.libraryGameId) return null;
  if (signals.dismissed?.some((d) => d.key === dismissKey || (c.key.startsWith('free:') && d.key === c.key))) return null;
  const f = featuresOf({ title: c.title, genres: c.genres, tags: c.tags });
  const { match, top } = tasteMatch(f, profile);
  const reasons: Reason[] = [];
  let score = match * 2.4;
  const taste = tasteReason(top);
  if (taste) reasons.push({ ...taste, weight: Math.max(0.05, match * 2.4) });

  const seed = c.seedGameId ? games?.get(c.seedGameId) : undefined;
  if (seed) {
    const e = Math.max(0, profile.engagement.get(seed.id) ?? 0.3);
    const w = 0.35 + e * 0.8;
    score += w;
    const secs = playedSecondsOf(seed);
    reasons.push({ code: 'seed', text: secs >= 3600 ? `Like ${seed.title}, which you played for ${hoursWords(secs)}` : `Like ${seed.title}`, weight: w });
  }
  const via = new Set(c.via);
  if (via.has('wishlist')) { score += 0.6; reasons.push({ code: 'wishlist', text: 'On your wishlist', weight: 0.6 }); }
  if (via.has('watching')) { score += 0.4; reasons.push({ code: 'watching', text: 'You’re watching its price', weight: 0.4 }); }
  if (c.planName) { score += 0.55; reasons.push({ code: 'plan', text: `Included with ${c.planName}`, weight: 0.55 }); }
  if (via.has('free') || c.freeOn) {
    score += 0.5;
    reasons.push({ code: 'free', text: c.freeOn ? `Free to keep on ${c.freeOn}${c.freeUntil ? ` until ${shortDate(c.freeUntil)}` : ''}` : 'Free to keep for a limited time', weight: 0.5 });
  } else if (c.free) {
    score += 0.15;
    reasons.push({ code: 'free', text: 'Free to play', weight: 0.15 });
  } else if ((c.discountPercent ?? 0) >= 20) {
    const w = Math.min(0.35, (c.discountPercent ?? 0) / 200);
    score += w;
    reasons.push({ code: 'sale', text: `${Math.round(c.discountPercent!)}% off right now`, weight: w });
  }
  if (c.friends && c.friends > 0) {
    const w = Math.min(0.8, 0.4 + 0.15 * c.friends);
    score += w;
    reasons.push({ code: 'friends', text: c.friends === 1 ? 'A friend is playing it' : `${c.friends} friends are playing it`, weight: w });
  }
  if (c.cloud) { score += 0.12; reasons.push({ code: 'cloud', text: 'Playable in the cloud', weight: 0.12 }); }
  if (c.comingSoon) score -= 0.45;
  if (c.year && c.year >= new Date(signals.now).getFullYear() - 1 && !c.comingSoon) {
    score += 0.08;
    reasons.push({ code: 'new', text: 'Out recently', weight: 0.08 });
  }
  score += rotation(c.key, signals.now) * 0.12;
  reasons.sort((a, b) => b.weight - a.weight);
  return {
    id: c.key, kind: 'discover', title: c.title, score, match, reasons, features: [...f.w.keys()], dismissKey: c.key.startsWith('free:') ? c.key : dismissKey,
    reason: explain(reasons, { kind: 'discover', never: false }),
  };
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'soon' : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(d);
}

/** Recommendations among games you don't own; candidates seen from several sources are merged by key first. */
export function recommendDiscover(candidates: readonly DiscoverCandidate[], profile: TasteProfile, signals: RecSignals, opts: { limit?: number; games?: ReadonlyMap<string, Game>; diversify?: boolean } = {}): Recommendation[] {
  const merged = mergeCandidates(candidates);
  const scored: Recommendation[] = [];
  for (const c of merged) {
    const r = scoreDiscover(c, profile, signals, opts.games);
    if (r) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  const limit = opts.limit ?? 16;
  return opts.diversify === false ? scored.slice(0, limit) : diversify(scored, limit);
}

/** One candidate per key: sources, tags and the strongest signals combined. */
export function mergeCandidates(candidates: readonly DiscoverCandidate[]): DiscoverCandidate[] {
  const by = new Map<string, DiscoverCandidate>();
  for (const c of candidates) {
    const prev = by.get(c.key);
    if (!prev) {
      by.set(c.key, { ...c, via: [...c.via] });
      continue;
    }
    by.set(c.key, {
      ...prev,
      genres: prev.genres.length ? prev.genres : c.genres,
      tags: prev.tags?.length ? prev.tags : c.tags,
      year: prev.year ?? c.year,
      seedGameId: prev.seedGameId ?? c.seedGameId,
      via: [...new Set([...prev.via, ...c.via])],
      free: prev.free || c.free,
      discountPercent: Math.max(prev.discountPercent ?? 0, c.discountPercent ?? 0),
      comingSoon: prev.comingSoon ?? c.comingSoon,
      libraryGameId: prev.libraryGameId ?? c.libraryGameId,
      cloud: prev.cloud || c.cloud,
      planName: prev.planName ?? c.planName,
      friends: Math.max(prev.friends ?? 0, c.friends ?? 0),
      freeUntil: prev.freeUntil ?? c.freeUntil,
      freeOn: prev.freeOn ?? c.freeOn,
    });
  }
  return [...by.values()];
}

// ------------------------------------------------------------------------------------------------ diversity

/** Weighted Jaccard similarity of two feature sets; the same series counts as identical. */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  for (const k of a) if (k.startsWith('s:') && sb.has(k)) return 1;
  const ka = a.filter((k) => !k.startsWith('d:'));
  const kb = b.filter((k) => !k.startsWith('d:'));
  const setA = new Set(ka);
  let inter = 0;
  for (const k of kb) if (setA.has(k)) inter++;
  const union = new Set([...ka, ...kb]).size;
  return union ? inter / union : 0;
}

/**
 * Maximal marginal relevance: picks the best item, then repeatedly the item with the best mix of its own score and
 * difference from what's already picked. Input must be sorted best first.
 */
export function diversify<T extends Pick<Recommendation, 'score' | 'features'>>(sorted: readonly T[], k: number, lambda = MMR_LAMBDA): T[] {
  if (sorted.length <= 1 || k <= 1) return sorted.slice(0, Math.max(0, k));
  const hi = sorted[0].score;
  const lo = sorted[sorted.length - 1].score;
  const norm = (s: number) => (hi === lo ? 1 : (s - lo) / (hi - lo));
  // Only the top of the list can make it; considering a bounded pool keeps this O(k · pool).
  const pool = sorted.slice(0, Math.max(k * 4, 40)).map((item) => ({ item, rel: norm(item.score), maxSim: 0 }));
  const out: T[] = [];
  while (out.length < k && pool.length) {
    let best = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const v = lambda * pool[i].rel - (1 - lambda) * pool[i].maxSim;
      if (v > bestVal) { bestVal = v; best = i; }
    }
    const [chosen] = pool.splice(best, 1);
    out.push(chosen.item);
    for (const p of pool) p.maxSim = Math.max(p.maxSim, similarity(p.item.features, chosen.item.features));
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ explanations

const PRIMARY: ReadonlySet<ReasonCode> = new Set(['seed', 'wishlist', 'plan', 'friends', 'free', 'lapsed', 'inProgress', 'backlog', 'unplayed', 'taste', 'watching', 'favorite', 'rated', 'sale']);
/** Reasons about this one game beat the general "you love Racing" when they're strong enough to lead. */
const SPECIFIC: ReadonlySet<ReasonCode> = new Set(['seed', 'wishlist', 'plan', 'friends', 'free', 'lapsed', 'inProgress', 'watching']);
const SECONDARY: ReadonlySet<ReasonCode> = new Set(['finishTonight', 'timeFit', 'friends', 'cloud', 'installed', 'taste', 'sale', 'free', 'controller', 'new']);

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * One sentence from a pick's reasons: the strongest primary reason, plus one supporting detail when there's a good
 * one ("You love Racing and Open World · you could finish it in the 2 hours you usually have on Friday evenings").
 * Negative reasons (no space) are always mentioned, so a pick never hides a catch.
 */
export function explain(reasons: readonly Reason[], ctx: { kind: 'library' | 'discover'; never: boolean }): string {
  const positive = reasons.filter((r) => r.weight > 0);
  // A game you've never played is introduced as such; otherwise its most specific strong reason leads.
  const primary = (ctx.never ? positive.find((r) => r.code === 'unplayed' || r.code === 'backlog') : undefined)
    ?? positive.find((r) => SPECIFIC.has(r.code) && r.weight >= 0.3)
    ?? positive.find((r) => PRIMARY.has(r.code))
    ?? positive[0];
  if (!primary) return ctx.kind === 'library' ? (ctx.never ? 'Never played yet' : 'From your library') : 'Something new to try';
  let text = primary.text;
  const taste = positive.find((r) => r.code === 'taste');
  if (primary.code === 'unplayed' || primary.code === 'backlog') {
    // An unplayed game says why it's worth starting now: friends, the time it takes, or how it fits your taste.
    const support = positive.find((r) => r.code === 'friends') ?? positive.find((r) => r.code === 'finishTonight')
      ?? (taste && taste.weight >= 0.25 ? taste : undefined) ?? positive.find((r) => r.code === 'timeFit' || r.code === 'cloud');
    if (support) text = support === taste ? `${primary.text}, and ${lowerFirst(support.text)}` : `${primary.text} · ${lowerFirst(support.text)}`;
  } else {
    const support = positive.find((r) => r !== primary && SECONDARY.has(r.code) && r.weight >= (r.code === 'installed' ? 0 : 0.1) &&
      !(r.code === 'taste' && primary.code === 'seed') && !(r.code === 'installed' && positive.some((x) => x.code === 'finishTonight' || x.code === 'timeFit')));
    const best = positive.find((r) => (r.code === 'finishTonight' || r.code === 'timeFit') && r !== primary) ?? support;
    if (best) text = `${text} · ${lowerFirst(best.text)}`;
  }
  const catchy = reasons.find((r) => r.weight < 0 && r.code === 'noSpace');
  if (catchy) text = `${text} · ${lowerFirst(catchy.text)}`;
  return text;
}

// ------------------------------------------------------------------------------------------------ the module

/** The `recommend.v2` module as one object (what the assistant and other tracks import). */
export const recommendV2 = {
  version: RECOMMEND_VERSION,
  buildTasteProfile,
  recommendLibrary,
  recommendDiscover,
  scoreLibraryGame,
  scoreDiscover,
  diversify,
  explain,
  timeWindow,
  featuresOf,
  gameFeatures,
  seriesKey,
  similarity,
};
