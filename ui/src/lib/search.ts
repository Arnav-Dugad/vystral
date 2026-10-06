import type { AiQuery, DriveInfo, Game, GameStatus, PlatformKey } from '../bridge/types';
import { isInstalled, isMissing, lastPlayed, sizeOf, PLATFORM_NAMES } from './format';
import { hasNeverBeenPlayed } from './neverPlayed';

/**
 * Deterministic library query engine. Understands everyday phrasing without any AI:
 *   "installed racing games under 20 GB", "launch forza", "games I haven't played recently",
 *   "everything on my second SSD", "steam horror", "unplayed favorites".
 * Every interpretation is shown back to the user as a chip, so nothing is hidden.
 */

export interface QueryFilters {
  installed?: boolean;
  favorite?: boolean;
  hidden?: boolean;
  platforms?: PlatformKey[];
  genres?: string[];
  maxSizeBytes?: number;
  minSizeBytes?: number;
  notPlayedDays?: number;
  playedWithinDays?: number;
  neverPlayed?: boolean;
  /** Files gone from disk (a known install is missing), see {@link isMissing}. */
  missing?: boolean;
  status?: GameStatus;
  drives?: string[];
}

export interface ParsedQuery {
  intent: 'search' | 'launch';
  text: string;
  filters: QueryFilters;
  chips: string[];
  /** True when every word was understood as a filter (no free-text title search). */
  structured: boolean;
}

export interface QueryContext {
  genres: string[];
  drives: DriveInfo[];
  now?: number;
}

const PLATFORM_WORDS: [RegExp, PlatformKey][] = [
  [/\bsteam\b/, 'steam'],
  [/\b(xbox|game ?pass|microsoft store)\b/, 'xbox'],
  [/\b(epic|epic games)\b/, 'epic'],
  [/\b(gog|galaxy)\b/, 'gog'],
  [/\b(ea app|ea|origin)\b/, 'ea'],
  [/\b(ubisoft|uplay|ubisoft connect)\b/, 'ubisoft'],
  [/\b(battle\.?net|blizzard)\b/, 'battlenet'],
  [/\b(added by me|manual|my programs?|custom)\b/, 'manual'],
];

const GENRE_SYNONYMS: Record<string, string[]> = {
  racing: ['racing', 'driving', 'race', 'races', 'cars?'],
  horror: ['horror', 'scary', 'spooky'],
  rpg: ['rpg', 'rpgs', 'role[- ]?playing'],
  shooter: ['shooter', 'shooters', 'fps', 'shooting'],
  strategy: ['strategy', 'rts', 'tactics', 'tactical'],
  simulation: ['simulation', 'sim', 'sims', 'simulator'],
  puzzle: ['puzzle', 'puzzles'],
  sports: ['sports?', 'football', 'soccer'],
  space: ['space', 'sci[- ]?fi', 'science fiction'],
  fantasy: ['fantasy'],
  platformer: ['platformer', 'platformers', 'platforming'],
  adventure: ['adventure', 'adventures'],
  action: ['action'],
  indie: ['indie'],
  survival: ['survival'],
  multiplayer: ['multiplayer', 'co-?op', 'online'],
  casual: ['casual', 'relaxing', 'cozy'],
  'open world': ['open[- ]?world'],
};

const NOISE = /\b(show|me|my|all|the|a|an|games?|titles?|that|which|i|i've|have|ive|with|of|please|find|list|everything|stuff|are|is|in|from|what)\b/g;

const GB = 1024 ** 3;

export function parseQuery(input: string, ctx: QueryContext): ParsedQuery {
  let q = ` ${input.toLowerCase().replace(/[’']/g, "'").trim()} `;
  const filters: QueryFilters = {};
  const chips: string[] = [];
  let intent = 'search' as ParsedQuery['intent'];

  const take = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    const m = q.match(re);
    if (m) {
      fn(m);
      q = q.replace(re, ' ');
    }
  };

  take(/^\s*(launch|play|start|run|open)\s+/, () => (intent = 'launch'));

  // Recency (must run before "played"/"installed" words are consumed elsewhere).
  take(/\b(never played|unplayed|not played yet|haven't played yet)\b/, () => {
    filters.neverPlayed = true;
    chips.push('Never played');
  });
  // "backlog" is a play status the user sets, not the same thing as never played.
  take(/\b(on my backlog|backlogged|backlog)\b/, () => {
    filters.status = 'backlog';
    chips.push('Backlog');
  });
  take(/\b(haven't|have not|not|didn't|did not)\s+played?\s+(in|for)\s+(\d+|a|one|two|three|six)\s+(day|week|month|year)s?\b/, (m) => {
    const n = wordNumber(m[3]);
    const days = n * ({ day: 1, week: 7, month: 30, year: 365 } as const)[m[4] as 'day' | 'week' | 'month' | 'year'];
    filters.notPlayedDays = days;
    chips.push(`Not played in ${n} ${m[4]}${n === 1 ? '' : 's'}`);
  });
  take(/\b(haven't|have not|not|didn't|did not)\s+(been\s+)?play(ed)?\s+(recently|lately|in a while)\b/, () => {
    filters.notPlayedDays = 30;
    chips.push('Not played in 30 days');
  });
  take(/\b(recently played|played recently|recent|played this week|this week)\b/, (m) => {
    filters.playedWithinDays = m[0].includes('week') ? 7 : 14;
    chips.push(`Played in the last ${filters.playedWithinDays} days`);
  });

  // Installation state.
  take(/\b(missing from disk|missing)\b/, () => {
    filters.missing = true;
    chips.push('Missing');
  });
  take(/\b(not installed|uninstalled)\b/, () => {
    filters.installed = false;
    chips.push('Not installed');
  });
  take(/\b(installed|playable|ready to play)\b/, () => {
    filters.installed = true;
    chips.push('Installed');
  });
  take(/\b(favou?rites?|favou?rited|starred|pinned)\b/, () => {
    filters.favorite = true;
    chips.push('Favorites');
  });
  take(/\bhidden\b/, () => {
    filters.hidden = true;
    chips.push('Hidden');
  });

  // Size: "under 20 gb", "< 20gb", "smaller than 1.5 tb", "over 50 gb".
  take(/\b(under|below|less than|smaller than|<)\s*(\d+(?:\.\d+)?)\s*(gb|g|tb|mb)\b/, (m) => {
    filters.maxSizeBytes = toBytes(m[2], m[3]);
    chips.push(`Under ${m[2]} ${m[3].toUpperCase().replace(/^G$/, 'GB')}`);
  });
  take(/\b(over|above|more than|bigger than|larger than|>)\s*(\d+(?:\.\d+)?)\s*(gb|g|tb|mb)\b/, (m) => {
    filters.minSizeBytes = toBytes(m[2], m[3]);
    chips.push(`Over ${m[2]} ${m[3].toUpperCase().replace(/^G$/, 'GB')}`);
  });

  // Drives: "on d:", "on drive d", "on my second ssd", "on the system drive".
  take(/\bon\s+(?:my\s+|the\s+)?(?:drive\s+)?([a-z]):?(?:\s+drive)?\b(?!\w)/, (m) => {
    const letter = `${m[1].toUpperCase()}:`;
    if (ctx.drives.length === 0 || ctx.drives.some((d) => d.name.toUpperCase() === letter)) {
      filters.drives = [letter];
      chips.push(`On ${letter}`);
    }
  });
  take(/\bon\s+(?:my\s+|the\s+)?(second|other|external|secondary|non-?system|game|games)\s+(ssd|drive|disk|hdd|nvme)\b/, (m) => {
    const others = ctx.drives.filter((d) => !d.isSystem).sort((a, b) => a.name.localeCompare(b.name));
    const pick = m[1] === 'external' ? others.filter((d) => d.removable) : m[1] === 'second' ? others.slice(0, 1) : others;
    filters.drives = pick.map((d) => d.name.toUpperCase());
    chips.push(pick.length ? `On ${pick.map((d) => d.name).join(', ')}` : 'On another drive (none found)');
  });
  take(/\bon\s+(?:my\s+|the\s+)?(system|main|windows|boot)\s+(ssd|drive|disk)\b/, () => {
    const sys = ctx.drives.find((d) => d.isSystem);
    filters.drives = sys ? [sys.name.toUpperCase()] : ['C:'];
    chips.push(`On ${filters.drives[0]}`);
  });

  // Platforms.
  for (const [re, key] of PLATFORM_WORDS) {
    if (re.test(q)) {
      (filters.platforms ??= []).push(key);
      chips.push(PLATFORM_NAMES[key]);
      q = q.replace(re, ' ');
    }
  }

  // Genres: library genres first (exact words), then synonyms.
  const libraryGenres = new Map(ctx.genres.map((g) => [g.toLowerCase(), g]));
  for (const [canonical, words] of Object.entries(GENRE_SYNONYMS)) {
    const re = new RegExp(`\\b(${words.join('|')})\\b`);
    if (re.test(q)) {
      const match = [...libraryGenres.entries()].find(([k]) => k === canonical || new RegExp(`^(${words.join('|')})$`).test(k));
      const label = match?.[1] ?? canonical.replace(/\b\w/g, (c) => c.toUpperCase());
      (filters.genres ??= []).push(label);
      chips.push(label);
      q = q.replace(re, ' ');
    }
  }
  for (const [lower, original] of libraryGenres) {
    if (lower.length < 3 || filters.genres?.includes(original)) continue;
    const re = new RegExp(`\\b${escapeRe(lower)}\\b`);
    if (re.test(q)) {
      (filters.genres ??= []).push(original);
      chips.push(original);
      q = q.replace(re, ' ');
    }
  }

  const text = q.replace(intent === 'launch' ? /$^/ : NOISE, ' ').replace(/\s+/g, ' ').trim();
  return { intent, text, filters, chips, structured: text.length === 0 && chips.length > 0 };
}

export function fromAiQuery(ai: AiQuery): ParsedQuery {
  const filters: QueryFilters = {};
  const chips: string[] = [];
  if (ai.installed != null) { filters.installed = ai.installed; chips.push(ai.installed ? 'Installed' : 'Not installed'); }
  if (ai.favorite) { filters.favorite = true; chips.push('Favorites'); }
  if (ai.platforms?.length) { filters.platforms = ai.platforms; chips.push(...ai.platforms.map((p) => PLATFORM_NAMES[p])); }
  if (ai.genres?.length) { filters.genres = ai.genres; chips.push(...ai.genres); }
  if (ai.maxSizeGb != null) { filters.maxSizeBytes = ai.maxSizeGb * GB; chips.push(`Under ${ai.maxSizeGb} GB`); }
  if (ai.minSizeGb != null) { filters.minSizeBytes = ai.minSizeGb * GB; chips.push(`Over ${ai.minSizeGb} GB`); }
  if (ai.notPlayedDays != null) { filters.notPlayedDays = ai.notPlayedDays; chips.push(`Not played in ${ai.notPlayedDays} days`); }
  if (ai.playedWithinDays != null) { filters.playedWithinDays = ai.playedWithinDays; chips.push(`Played in ${ai.playedWithinDays} days`); }
  if (ai.drive) { filters.drives = [ai.drive]; chips.push(`On ${ai.drive}`); }
  return { intent: ai.intent === 'launch' ? 'launch' : 'search', text: ai.title ?? '', filters, chips: [...chips, 'via local AI'], structured: !ai.title };
}

export function matchesFilters(game: Game, f: QueryFilters, now = Date.now()): boolean {
  if (f.hidden !== undefined ? game.hidden !== f.hidden : game.hidden) return false;
  if (f.installed !== undefined && isInstalled(game) !== f.installed) return false;
  if (f.favorite && !game.favorite) return false;
  if (f.platforms?.length && !game.installations.some((i) => f.platforms!.includes(i.platform))) return false;
  if (f.genres?.length) {
    const g = game.genres.map((x) => x.toLowerCase());
    if (!f.genres.every((want) => g.some((x) => x === want.toLowerCase() || x.includes(want.toLowerCase())))) return false;
  }
  if (f.maxSizeBytes != null || f.minSizeBytes != null) {
    const size = sizeOf(game);
    if (size == null) return false;
    if (f.maxSizeBytes != null && size > f.maxSizeBytes) return false;
    if (f.minSizeBytes != null && size < f.minSizeBytes) return false;
  }
  if (f.drives?.length && !game.installations.some((i) => i.state === 'installed' && i.drive && f.drives!.includes(i.drive.toUpperCase()))) return false;
  const lp = lastPlayed(game).at;
  if (f.neverPlayed && !hasNeverBeenPlayed(game)) return false;
  if (f.missing && !isMissing(game)) return false;
  if (f.status && game.status !== f.status) return false;
  if (f.notPlayedDays != null && lp && now - Date.parse(lp) < f.notPlayedDays * 86400000) return false;
  if (f.playedWithinDays != null && (!lp || now - Date.parse(lp) > f.playedWithinDays * 86400000)) return false;
  return true;
}

/**
 * Title relevance. 0 = no match. Exact > prefix > word-prefix > acronym > substring > fuzzy.
 * Handles "rdr2", "forza", "witcher 3", "ashen".
 */
export function titleScore(title: string, query: string): number {
  if (!query) return 1;
  const t = normalize(title);
  const q = normalize(query);
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 90 - Math.min(20, t.length - q.length) * 0.2;
  const words = t.split(' ');
  if (words.some((w) => w.startsWith(q))) return 75;
  const qWords = q.split(' ');
  if (qWords.every((qw) => words.some((w) => w.startsWith(qw)))) return 70;
  const acronym = words.map((w) => (/^\d+$/.test(w) ? w : w[0])).join('');
  if (acronym.startsWith(q.replace(/ /g, ''))) return 65;
  if (t.includes(q)) return 55;
  // Subsequence fuzzy match with gap penalty.
  let ti = 0, gaps = 0, matched = 0;
  const compact = q.replace(/ /g, '');
  for (const ch of compact) {
    const idx = t.indexOf(ch, ti);
    if (idx < 0) return 0;
    gaps += idx - ti;
    ti = idx + 1;
    matched++;
  }
  return matched === compact.length && compact.length >= 3 ? Math.max(1, 40 - gaps) : 0;
}

export function searchGames(games: Game[], parsed: ParsedQuery, now = Date.now()): Game[] {
  const scored: { g: Game; s: number }[] = [];
  for (const g of games) {
    if (!matchesFilters(g, parsed.filters, now)) continue;
    const s = parsed.text ? titleScore(g.title, parsed.text) : 1;
    if (s > 0) scored.push({ g, s });
  }
  scored.sort((a, b) => b.s - a.s || a.g.sortTitle.localeCompare(b.g.sortTitle));
  return scored.map((x) => x.g);
}

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, (r) => String({ ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }[r]))
    .trim();
}

function toBytes(n: string, unit: string) {
  const v = parseFloat(n);
  return unit.startsWith('t') ? v * 1024 * GB : unit.startsWith('m') ? v * 1024 * 1024 : v * GB;
}

function wordNumber(w: string) {
  return ({ a: 1, one: 1, two: 2, three: 3, six: 6 } as Record<string, number>)[w] ?? parseInt(w, 10);
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
