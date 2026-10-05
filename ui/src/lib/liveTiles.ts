/**
 * Live tiles: when a Home tile may animate, and which few do. Pure so the rules are tested in one
 * place; components/game/LiveTile.tsx feeds them live state.
 */

export interface LiveConditions {
  /** `home.liveTiles` */
  setting: boolean;
  /** Data saver on (manually, or automatically on a metered connection). */
  dataSaver: boolean;
  /** Offline mode (`privacy.localOnly`). */
  offline: boolean;
  reducedMotion: boolean;
  quality: 'high' | 'balanced' | 'low';
  /** A game is starting or running (Performance Mode). */
  gameActive: boolean;
  /** The page is hidden (minimized, another app full screen). */
  hidden: boolean;
  safeMode: boolean;
}

export type LiveBlock = 'off' | 'safeMode' | 'dataSaver' | 'offline' | 'gameActive' | 'hidden' | 'reducedMotion' | 'lowQuality';

/** Why no tile may animate right now, or null when they may. */
export function liveTileBlock(c: LiveConditions): LiveBlock | null {
  if (!c.setting) return 'off';
  if (c.safeMode) return 'safeMode';
  if (c.dataSaver) return 'dataSaver';
  if (c.offline) return 'offline';
  if (c.gameActive) return 'gameActive';
  if (c.hidden) return 'hidden';
  if (c.reducedMotion) return 'reducedMotion';
  if (c.quality === 'low') return 'lowQuality';
  return null;
}

/** At most this many tiles play at once (decoders are not free, and calm beats busy). */
export const MAX_PLAYING = 2;
/** A tile needs at least this much of itself on screen to play. */
export const MIN_VISIBLE = 0.5;
/** After playing this long, a tile yields to one that hasn't played yet … */
export const STINT_MS = 24_000;
/** … and rests at least this long before it may play again by itself. */
export const REST_MS = 40_000;

export interface TileSnapshot {
  key: string;
  /** Fraction of the tile on screen (IntersectionObserver ratio). */
  ratio: number;
  /** A micro-trailer exists and is known. */
  hasVideo: boolean;
  /** Pointer over it or keyboard/controller focus on it. */
  hovered: boolean;
  /** Reading order on screen (top-to-bottom, left-to-right). */
  order: number;
  /** When its current stint began, or null when it isn't playing. */
  playingSince: number | null;
  /** Not before this time, unless hovered. */
  restUntil: number;
  /** When it last stopped playing (0 = never played). */
  lastPlayedAt: number;
}

/**
 * Which tiles play. Hovered/focused tiles always win (up to `max`); the remaining slots keep
 * whatever is already playing (no flicker), then go to the tile that played least recently, then
 * reading order. Tiles that are mostly off screen, have no video, or are resting never play by
 * themselves.
 */
export function pickPlaying(tiles: readonly TileSnapshot[], now: number, max = MAX_PLAYING): string[] {
  const eligible = tiles.filter((t) => t.hasVideo && t.ratio >= MIN_VISIBLE);
  const hovered = eligible.filter((t) => t.hovered).sort((a, b) => a.order - b.order);
  const rest = eligible
    .filter((t) => !t.hovered && t.restUntil <= now)
    .sort((a, b) => Number(b.playingSince != null) - Number(a.playingSince != null) || a.lastPlayedAt - b.lastPlayedAt || a.order - b.order);
  return [...hovered, ...rest].slice(0, max).map((t) => t.key);
}

/**
 * Ends stints that ran past {@link STINT_MS} when another eligible tile is waiting, so a Home page
 * full of trailers gently takes turns instead of the first two looping forever. Returns new
 * snapshots (inputs are not mutated).
 */
export function rotate(tiles: readonly TileSnapshot[], now: number): TileSnapshot[] {
  const waiting = tiles.some((t) => t.hasVideo && t.ratio >= MIN_VISIBLE && t.playingSince == null && t.restUntil <= now);
  if (!waiting) return tiles.slice();
  return tiles.map((t) =>
    t.playingSince != null && !t.hovered && now - t.playingSince >= STINT_MS
      ? { ...t, playingSince: null, lastPlayedAt: now, restUntil: now + REST_MS }
      : t,
  );
}
