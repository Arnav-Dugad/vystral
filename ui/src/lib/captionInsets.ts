/**
 * Track C2: how much of the title bar the system caption buttons (minimize, maximize, close) cover, in CSS pixels.
 * The native side already falls back when Windows reports 0; this is the interface's own guard, so an old or odd
 * answer can never put VYSTRAL's buttons underneath the window's.
 */
import type { WindowState } from '../bridge/types';

/** Windows 11's three caption buttons at the tall title bar height. */
export const CAPTION_FALLBACK = 138;
/** Breathing room between VYSTRAL's last button and the minimize button. */
export const CAPTION_GAP = 8;
const MAX = 480;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export interface CaptionInsets {
  right: number;
  left: number;
}

export function captionInsets(w: Pick<WindowState, 'mode' | 'fullscreen' | 'captionInsetRight'> & { captionInsetLeft?: number }, native: boolean): CaptionInsets {
  if (w.fullscreen || w.mode === 'immersive') return { right: 0, left: 0 };
  const right = finite(w.captionInsetRight);
  const left = finite(w.captionInsetLeft) ?? 0;
  // In the app the buttons are always there in a normal window; a missing or zero reading means "not known yet".
  const r = right == null || (native && right < 1) ? CAPTION_FALLBACK : right;
  return { right: Math.min(MAX, Math.max(0, r)), left: Math.min(MAX, Math.max(0, left)) };
}

/** Writes the insets as CSS variables on the root, where the title bar (and anything else docked to the top) reads them. */
export function applyCaptionInsets(insets: CaptionInsets, root: HTMLElement = document.documentElement) {
  root.style.setProperty('--caption-inset-right', `${insets.right}px`);
  root.style.setProperty('--caption-inset-left', `${insets.left}px`);
  root.style.setProperty('--caption-gap', `${CAPTION_GAP}px`);
}
