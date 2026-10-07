/**
 * Track U: pure helpers for universal search — highlighting what matched, client-side filters, prices, and the plain
 * words for every source state. No React and no bridge here, so all of it is unit-tested.
 */
import type { DiscoverResult, DiscoverSearch, DiscoverSourceId, DiscoverSourceState, PlatformKey, StorePrice } from '../bridge/types';

// ---------------- query ----------------

/** What the bridge accepts: trimmed, single-spaced, no control characters, 2–100 characters (else null). */
export function cleanQuery(text: string): string | null {
  // eslint-disable-next-line no-control-regex
  const q = text.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return q.length >= 2 && q.length <= 100 ? q : null;
}

// ---------------- highlighting ----------------

export interface Part {
  text: string;
  hit: boolean;
}

/** Folds one character for matching (case and accents), keeping the mapping back to the original. */
function fold(s: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const f = s[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const ch of f) {
      folded += ch;
      map.push(i);
    }
  }
  return { folded, map };
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/**
 * Splits a title into matched and unmatched parts for the typed text: the whole text as one run when it appears,
 * else each typed word where a title word starts with it, else the letters of a fuzzy (in-order) match.
 */
export function highlightParts(title: string, query: string): Part[] {
  const q = fold(query.trim().replace(/\s+/g, ' ')).folded;
  if (!q) return [{ text: title, hit: false }];
  const { folded, map } = fold(title);
  const marks = new Array<boolean>(title.length).fill(false);
  const mark = (from: number, len: number) => {
    for (let k = from; k < from + len && k < map.length; k++) marks[map[k]] = true;
  };

  // 1. The whole text, preferring a word start.
  let at = -1;
  for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + 1)) {
    if (at < 0) at = i;
    if (!isWordChar(folded[i - 1])) { at = i; break; }
  }
  if (at >= 0) mark(at, q.length);
  else {
    // 2. Each word at a word start.
    const words = q.split(' ').filter(Boolean);
    let any = false;
    for (const w of words) {
      for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + 1)) {
        if (!isWordChar(folded[i - 1])) { mark(i, w.length); any = true; break; }
      }
    }
    // 3. In-order letters.
    if (!any) {
      const compact = q.replace(/ /g, '');
      const hits: number[] = [];
      let from = 0;
      for (const ch of compact) {
        const i = folded.indexOf(ch, from);
        if (i < 0) { hits.length = 0; break; }
        hits.push(i);
        from = i + 1;
      }
      if (hits.length >= 2) hits.forEach((i) => mark(i, 1));
    }
  }

  const parts: Part[] = [];
  for (let i = 0; i < title.length; i++) {
    const last = parts[parts.length - 1];
    if (last && last.hit === marks[i]) last.text += title[i];
    else parts.push({ text: title[i], hit: marks[i] });
  }
  return parts;
}

// ---------------- filters ----------------

export type PlatformGroup = 'pc' | 'playstation' | 'xbox' | 'nintendo' | 'mac' | 'linux' | 'mobile';

export const PLATFORM_GROUP_LABEL: Record<PlatformGroup, string> = {
  pc: 'PC', playstation: 'PlayStation', xbox: 'Xbox', nintendo: 'Nintendo', mac: 'Mac', linux: 'Linux', mobile: 'Phones',
};

export function platformGroup(name: string): PlatformGroup | null {
  const n = name.toLowerCase();
  if (n === 'pc' || n.includes('windows') || n === 'dos') return 'pc';
  if (n.includes('playstation') || /^ps\d/.test(n) || n === 'ps vita') return 'playstation';
  if (n.includes('xbox')) return 'xbox';
  if (n.includes('nintendo') || n.includes('switch') || n.includes('wii') || n.includes('game boy')) return 'nintendo';
  if (n === 'mac' || n.includes('macos')) return 'mac';
  if (n === 'linux') return 'linux';
  if (n === 'android' || n === 'ios') return 'mobile';
  return null;
}

export type Decade = 'upcoming' | '2020s' | '2010s' | '2000s' | 'older';

export const DECADE_LABEL: Record<Decade, string> = { upcoming: 'Coming out', '2020s': '2020s', '2010s': '2010s', '2000s': '2000s', older: 'Before 2000' };

export function decadeOf(year: number | null, now = new Date()): Decade | null {
  if (year == null) return null;
  if (year > now.getFullYear()) return 'upcoming';
  if (year >= 2020) return '2020s';
  if (year >= 2010) return '2010s';
  if (year >= 2000) return '2000s';
  return 'older';
}

export interface DiscoverFilters {
  store: PlatformKey | null;
  platform: PlatformGroup | null;
  decade: Decade | null;
  genre: string | null;
  /** Hide DLC, soundtracks and the like. */
  gamesOnly: boolean;
}

export const NO_FILTERS: DiscoverFilters = { store: null, platform: null, decade: null, genre: null, gamesOnly: true };

export function applyFilters(results: DiscoverResult[], f: DiscoverFilters, now = new Date()): DiscoverResult[] {
  return results.filter((r) =>
    (!f.store || r.stores.includes(f.store)) &&
    (!f.platform || r.platforms.some((p) => platformGroup(p) === f.platform)) &&
    (!f.decade || decadeOf(r.year, now) === f.decade) &&
    (!f.genre || r.genres.some((g) => g.toLowerCase() === f.genre!.toLowerCase())) &&
    (!f.gamesOnly || r.kind !== 'extra'));
}

export function activeFilterCount(f: DiscoverFilters): number {
  return [f.store, f.platform, f.decade, f.genre].filter(Boolean).length;
}

/** The choices worth offering: only values some result has, genres by how often they appear. */
export function filterOptions(results: DiscoverResult[], now = new Date()) {
  const stores = new Set<PlatformKey>();
  const platforms = new Set<PlatformGroup>();
  const decades = new Set<Decade>();
  const genres = new Map<string, number>();
  for (const r of results) {
    r.stores.forEach((s) => stores.add(s));
    r.platforms.forEach((p) => { const g = platformGroup(p); if (g) platforms.add(g); });
    const d = decadeOf(r.year, now);
    if (d) decades.add(d);
    r.genres.forEach((g) => genres.set(g, (genres.get(g) ?? 0) + 1));
  }
  const storeOrder: PlatformKey[] = ['steam', 'gog', 'epic', 'xbox', 'ea', 'ubisoft', 'battlenet'];
  const groupOrder: PlatformGroup[] = ['pc', 'playstation', 'xbox', 'nintendo', 'mac', 'linux', 'mobile'];
  const decadeOrder: Decade[] = ['upcoming', '2020s', '2010s', '2000s', 'older'];
  return {
    stores: storeOrder.filter((s) => stores.has(s)),
    platforms: groupOrder.filter((p) => platforms.has(p)),
    decades: decadeOrder.filter((d) => decades.has(d)),
    genres: [...genres.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([g]) => g),
  };
}

// ---------------- library ----------------

/**
 * Splits results into "In your library" and the rest. Library matches the local search already shows are dropped,
 * so a game never appears twice.
 */
export function splitByLibrary(results: DiscoverResult[], shownLibraryIds: ReadonlySet<string>) {
  const owned: DiscoverResult[] = [];
  const rest: DiscoverResult[] = [];
  for (const r of results) {
    if (r.libraryGameId) {
      if (!shownLibraryIds.has(r.libraryGameId)) owned.push(r);
    } else rest.push(r);
  }
  return { owned, rest };
}

// ---------------- prices ----------------

export function formatStorePrice(p: StorePrice | null | undefined, locale?: string): { now: string; was: string | null; cut: number } | null {
  if (!p || !/^[A-Z]{3}$/.test(p.currency) || p.finalCents < 0) return null;
  try {
    const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: p.currency });
    const cut = p.initialCents > p.finalCents && p.initialCents > 0 ? Math.round((1 - p.finalCents / p.initialCents) * 100) : 0;
    if (p.finalCents === 0) return { now: 'Free', was: cut ? fmt.format(p.initialCents / 100) : null, cut };
    return { now: fmt.format(p.finalCents / 100), was: cut > 0 ? fmt.format(p.initialCents / 100) : null, cut };
  } catch {
    return null;
  }
}

// ---------------- sources ----------------

export const SOURCE_NAMES: Record<DiscoverSourceId, string> = { steam: 'Steam', igdb: 'IGDB', rawg: 'RAWG', wikidata: 'Wikidata' };

/** A short, friendly line for where one source stands. */
export function sourceLine(s: DiscoverSourceState): string {
  if (s.state === 'pending') return `Asking ${s.name}…`;
  if (s.state === 'done') return s.count === 0 ? `${s.name}: nothing found` : `${s.name}: ${s.count} ${s.count === 1 ? 'match' : 'matches'}`;
  const why: Record<string, string> = {
    off: 'turned off',
    noKey: 'not connected',
    offline: 'Offline mode is on',
    rateLimited: 'asked VYSTRAL to slow down',
    invalidKey: 'didn’t accept your key',
    unavailable: 'couldn’t be reached',
  };
  return `${s.name}: ${why[s.reason ?? ''] ?? (s.state === 'failed' ? 'couldn’t answer' : 'skipped')}`;
}

/** How far a search has got: sources still answering, and whether anything at all is being asked. */
export function progressOf(search: DiscoverSearch | null): { pending: number; asked: number; answered: number } {
  const sources = search?.sources ?? [];
  const asked = sources.filter((s) => s.state !== 'skipped').length;
  const pending = sources.filter((s) => s.state === 'pending').length;
  return { pending, asked, answered: asked - pending };
}

/** True when `next` should replace `prev` for the same channel (newer search, or the same one further along). */
export function isNewer(prev: DiscoverSearch | null, next: DiscoverSearch): boolean {
  if (!prev) return true;
  const n = (id: string) => Number(id.replace(/\D/g, '')) || 0;
  if (n(next.searchId) !== n(prev.searchId)) return n(next.searchId) > n(prev.searchId);
  if (next.page !== prev.page) return next.page > prev.page;
  return progressOf(next).answered >= progressOf(prev).answered;
}

/** Plain words for a details note code ("igdb:noKey"). Null for codes that need no explanation. */
export function noteText(code: string): string | null {
  const [source, what] = code.split(':');
  const name = SOURCE_NAMES[source as DiscoverSourceId] ?? source;
  switch (what) {
    case 'noKey': return source === 'igdb' ? 'Connect IGDB in Settings → Library & stores → Data sources to see time to beat and more details.' : `${name} isn’t connected.`;
    case 'off': return source === 'steam' ? 'Steam store details are off (Settings → Library & stores → “Fetch game details”).' : `${name} is turned off.`;
    case 'rateLimited': return `${name} asked VYSTRAL to slow down, so some details are missing. Try again in a few minutes.`;
    case 'invalidKey': return `${name} didn’t accept your key. Check it in Settings → Data sources.`;
    case 'unavailable': return `${name} couldn’t be reached, so some details are missing.`;
    default: return null;
  }
}

/** Seconds as "12 h" / "45 min" for time to beat. */
export function hoursLabel(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = seconds / 3600;
  if (h < 1) return `${Math.max(1, Math.round(seconds / 60))} min`;
  return h < 10 ? `${Math.round(h * 2) / 2} h` : `${Math.round(h)} h`;
}
