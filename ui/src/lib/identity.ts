/**
 * Track D4: words for the cross-store identity resolver. Pure, so the honesty rules ("say how it was matched and how
 * sure we are; Steam data for a non-Steam game is always labelled") are tested in one place.
 */
import type { Game, IdLevel, IdMethod, IdSource, ResolvedId, ResolvedIdentity } from '../bridge/types';

export const LEVEL_LABEL: Record<IdLevel, string> = {
  certain: 'Certain',
  high: 'High confidence',
  good: 'Good match',
  medium: 'Possible match',
  low: 'Unlikely',
};

export const SOURCE_LABEL: Record<IdSource, string> = {
  store: 'the store',
  pin: 'you',
  wikidata: 'Wikidata',
  igdb: 'IGDB',
  rawg: 'RAWG',
  steam: 'Steam store search',
  gog: 'GOG catalogue',
};

const METHOD_LABEL: Record<IdMethod, string> = {
  native: 'its own store ID',
  chosen: 'your choice',
  storeId: 'a store ID link',
  exactTitleYear: 'same title and year',
  exactTitle: 'same title',
  editionTitle: 'another edition’s title',
  crossCheck: 'confirmed listing',
  earlierMatch: 'an earlier exact-title match',
};

/** "Wikidata (same title and year) and Steam store search (same title and year)". Strongest first, one mention per source. */
export function matchedVia(id: Pick<ResolvedId, 'status' | 'evidence'>): string {
  if (id.status === 'native') return 'From the store itself';
  if (id.status === 'pinned') return 'You chose this';
  const seen = new Set<IdSource>();
  const parts: string[] = [];
  for (const e of [...id.evidence].sort((a, b) => b.confidence - a.confidence)) {
    if (e.source === 'store' || e.source === 'pin' || seen.has(e.source)) continue;
    seen.add(e.source);
    parts.push(`${SOURCE_LABEL[e.source]} (${METHOD_LABEL[e.method]})`);
  }
  if (parts.length === 0) return 'Matched';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Matched via ${list}`;
}

/** 0.913 → "91%". Never shows 100% for a match: only the store itself or your choice is certain. */
export function confidencePercent(id: Pick<ResolvedId, 'status' | 'confidence'>): string {
  if (id.status === 'native' || id.status === 'pinned') return '100%';
  return `${Math.min(99, Math.round(id.confidence * 100))}%`;
}

export const isSteamGame = (game: Pick<Game, 'installations'>) => game.installations.some((i) => i.platform === 'steam');

export interface SteamLink {
  appId: string | null;
  /** The game's own Steam app (a Steam game). */
  native: boolean;
  /** For a non-Steam game: how its Steam app was found, for the label shown next to Steam data. */
  via: 'matched' | 'pinned' | null;
  /** The matched Steam app's name, when known. */
  name: string | null;
}

/**
 * The Steam app a game's Steam-keyed sections (reviews, tags, price, news, Deck, ProtonDB) are about, or null when
 * none: a Steam game's own, or — only when VYSTRAL uses it — a matched or chosen one.
 */
export function steamLinkOf(game: Pick<Game, 'installations'>, identity: ResolvedIdentity | null | undefined): SteamLink | null {
  if (isSteamGame(game)) return { appId: game.installations.find((i) => i.platform === 'steam')?.platformGameId ?? null, native: true, via: null, name: null };
  const s = identity?.steam;
  if (!identity || !s || !s.used) return null;
  if (identity.status === 'matched') return { appId: s.value, native: false, via: 'matched', name: s.name };
  if (identity.status === 'pinned') return { appId: s.value, native: false, via: 'pinned', name: s.name };
  return null;
}

/** The short label next to Steam data of a non-Steam game. */
export function steamDataLabel(link: SteamLink | null): string | null {
  if (!link || link.native) return null;
  const app = link.name ? `“${link.name}” on Steam` : 'the Steam version';
  return link.via === 'pinned' ? `Steam data for ${app}, the version you chose` : `Steam data for ${app}, matched automatically`;
}

/** One calm sentence for the identity card's header. */
export function identitySummary(identity: ResolvedIdentity): string {
  switch (identity.status) {
    case 'native':
      return 'A Steam game: Steam’s own data is used.';
    case 'matched':
      return 'Matched to its Steam page, so Steam reviews, tags, trailers, prices and news can be shown, labelled as Steam data.';
    case 'pinned':
      return 'You chose its Steam page. Steam data is shown for it, labelled as Steam data.';
    case 'notOnSteam':
      return 'You said this game isn’t on Steam, so no Steam data is shown.';
    case 'suggested':
      return 'Probably this Steam game, but not certain enough to use on its own. Confirm it to see Steam data.';
    case 'conflict':
      return 'Sources disagree about its Steam page. Choose the right one to see Steam data.';
    case 'none':
      return 'No matching Steam page was found.';
    default:
      return identity.reason === 'off' ? 'Matching across stores is turned off.'
        : identity.reason === 'offline' ? 'Not checked yet: Offline mode is on.'
        : 'Not checked yet. Matching uses Wikidata, the Steam store, IGDB, RAWG and the GOG catalogue — whichever are turned on in Data sources.';
  }
}
