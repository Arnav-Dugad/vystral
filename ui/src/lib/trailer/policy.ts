/**
 * When a hero trailer may play. Pure so the rules are tested in one place; the component
 * feeds it live state. Any reason here keeps the artwork still and fetches nothing.
 */
export interface TrailerConditions {
  active: boolean;
  autoplay: boolean;
  dataSaver: boolean;
  offline: boolean;
  reducedMotion: boolean;
  /** Effective visual quality (after "auto" is resolved). */
  quality: 'high' | 'balanced' | 'low';
  /** A game is starting or running. */
  gameActive: boolean;
  /** document.visibilityState === 'hidden' (VYSTRAL minimized or suspended). */
  hidden: boolean;
  safeMode: boolean;
}

export type TrailerBlock = 'inactive' | 'autoplayOff' | 'dataSaver' | 'offline' | 'reducedMotion' | 'lowQuality' | 'gameActive' | 'hidden' | 'safeMode';

/** Reasons that stop a trailer from starting by itself. `null` means it may autoplay. */
export function autoplayBlock(c: TrailerConditions): TrailerBlock | null {
  return manualBlock(c) ?? (!c.autoplay ? 'autoplayOff' : c.reducedMotion ? 'reducedMotion' : null);
}

/**
 * Reasons that stop a trailer even when you ask for it with the play button. Reduced motion and
 * the autoplay switch only stop *automatic* playback; a deliberate click still plays.
 */
export function manualBlock(c: TrailerConditions): TrailerBlock | null {
  if (!c.active) return 'inactive';
  if (c.safeMode) return 'safeMode';
  if (c.offline) return 'offline';
  if (c.dataSaver) return 'dataSaver';
  if (c.gameActive) return 'gameActive';
  if (c.hidden) return 'hidden';
  if (c.quality === 'low') return 'lowQuality';
  return null;
}

/** Resolution cap per quality: 1080p only when you've asked for high quality. */
export function maxTrailerHeight(quality: TrailerConditions['quality'], viewportHeight: number): number {
  if (quality === 'high') return viewportHeight > 900 ? 1080 : 720;
  return 720;
}

/** Same rule App.tsx uses to resolve "auto" quality. */
export function effectiveQuality(setting: string | undefined, cores: number | undefined): TrailerConditions['quality'] {
  if (setting === 'high' || setting === 'balanced' || setting === 'low') return setting;
  return (cores ?? 8) <= 4 ? 'low' : 'balanced';
}

/** Delay before an idle, visible detail page starts its trailer. */
export const IDLE_DELAY_MS = 2500;
/** How many times a trailer plays by itself: once, then one loop. */
export const MAX_PLAYS = 2;
