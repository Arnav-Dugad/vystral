/**
 * The desktop ↔ Immersive switch (Track L). Pure rules and a small phase machine, so the timing
 * contract is unit-tested; components/shell/ModeTransition.tsx drives it and draws it.
 *
 * Sequence: `out` (the old layout folds away under a full-window overlay that ends fully opaque)
 * → `commit` (the layout swaps and the native window changes presenter underneath the overlay)
 * → `settle` (wait for the native resize to land, at most a few frames) → `in` (the new layout
 * rises in while the overlay clears). Any input skips: before the commit it is swallowed (the
 * layout it was aimed at is going away); after the commit it also reaches the new layout.
 */

export type AppMode = 'desktop' | 'immersive';
export type SwitchKind = 'cinematic' | 'fade' | 'instant';
export type SwitchPhase = 'idle' | 'out' | 'commit' | 'settle' | 'in';

export interface SwitchConditions {
  /** `immersive.cinematicSwitch`. Off = a quick crossfade (still hides the resize). */
  setting: boolean;
  reducedMotion: boolean;
  /** A game is starting or running: never animate then. */
  gameActive: boolean;
  /** The window is hidden or minimized: nobody would see it. */
  hidden: boolean;
  safeMode: boolean;
}

export function switchKind(c: SwitchConditions): SwitchKind {
  if (c.gameActive || c.hidden) return 'instant';
  if (c.reducedMotion || !c.setting || c.safeMode) return 'fade';
  return 'cinematic';
}

export interface SwitchTiming {
  /** Fold-away, ending on a fully covered window. */
  out: number;
  /** Longest wait for the native window to finish resizing after the commit. */
  settleMax: number;
  /** Rise-in of the new layout while the overlay clears. */
  in: number;
}

/** ~900 ms end to end for the cinematic switch (plus however long Windows takes to resize). */
export const SWITCH_TIMING: Record<Exclude<SwitchKind, 'instant'>, SwitchTiming> = {
  cinematic: { out: 380, settleMax: 320, in: 500 },
  fade: { out: 130, settleMax: 320, in: 170 },
};

export function totalDuration(kind: SwitchKind): number {
  if (kind === 'instant') return 0;
  const t = SWITCH_TIMING[kind];
  return t.out + t.in;
}

export interface SwitchState {
  phase: SwitchPhase;
  target: AppMode | null;
  /** Any input arrived: finish as fast as possible. */
  skipped: boolean;
}

export type SwitchEvent =
  | { type: 'start'; target: AppMode }
  | { type: 'outDone' }
  | { type: 'committed' }
  | { type: 'settled' }
  | { type: 'inDone' }
  | { type: 'skip' };

export const IDLE: SwitchState = { phase: 'idle', target: null, skipped: false };

export function switchReducer(s: SwitchState, e: SwitchEvent): SwitchState {
  switch (e.type) {
    case 'start':
      return s.phase === 'idle' ? { phase: 'out', target: e.target, skipped: false } : s;
    case 'outDone':
      return s.phase === 'out' ? { ...s, phase: 'commit' } : s;
    case 'committed':
      return s.phase === 'commit' ? { ...s, phase: 'settle' } : s;
    case 'settled':
      if (s.phase !== 'settle') return s;
      return s.skipped ? IDLE : { ...s, phase: 'in' };
    case 'inDone':
      return s.phase === 'in' ? IDLE : s;
    case 'skip':
      if (s.phase === 'idle') return s;
      if (s.phase === 'out') return { ...s, phase: 'commit', skipped: true };
      if (s.phase === 'in') return IDLE;
      return { ...s, skipped: true };
  }
}

/** What happens to an input event that arrives in this phase (it always skips the animation). */
export function inputPolicy(phase: SwitchPhase): 'none' | 'swallow' | 'pass' {
  if (phase === 'idle') return 'none';
  return phase === 'out' || phase === 'commit' ? 'swallow' : 'pass';
}

/**
 * The game the transition zoomed into, handed to Immersive so it opens focused on exactly the art
 * the overlay was showing (no jump when the overlay clears). Valid for a few seconds (React's
 * development double-render may read it twice), so a later, unrelated mount never picks it up.
 */
let entryFocus: { id: string; at: number } | null = null;
export const ENTRY_FOCUS_TTL_MS = 3000;
export function setEntryFocus(gameId: string | null, now = Date.now()) {
  entryFocus = gameId ? { id: gameId, at: now } : null;
}
export function takeEntryFocus(now = Date.now()): string | null {
  return entryFocus && now - entryFocus.at <= ENTRY_FOCUS_TTL_MS ? entryFocus.id : null;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Transform that makes a full-window layer start on `from` (an artwork rect on screen): uniform
 * scale so the art never stretches, centred on the rect. Clamped so a tiny or missing rect still
 * starts as a readable card in the middle of the window.
 */
export function zoomFrom(from: Rect | null, vw: number, vh: number): { x: number; y: number; scale: number } {
  if (!(vw > 0) || !(vh > 0)) return { x: 0, y: 0, scale: 1 };
  const r = from && from.w > 8 && from.h > 8 ? from : { x: vw * 0.35, y: vh * 0.3, w: vw * 0.3, h: vh * 0.4 };
  const scale = Math.max(0.12, Math.min(0.9, Math.max(r.w / vw, r.h / vh)));
  return { x: r.x + r.w / 2 - vw / 2, y: r.y + r.h / 2 - vh / 2, scale };
}
