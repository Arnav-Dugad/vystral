import type { SystemAppearance } from '../bridge/types';

/** Matches --dur-backdrop in components/shell/backdrop.css. */
export const BACKDROP_FADE_MS = 420;

/** Plain-language state of the Mica backdrop for Settings → Appearance. */
export function backdropHint(a: SystemAppearance | null, livingCanvas: boolean, theme: string | undefined): string {
  if (livingCanvas) return 'When it’s off, the title bar and sidebar use the Windows Mica material and pick up your desktop’s colours.';
  if (theme !== 'obsidian' && theme !== 'light') return 'Mica is used with the Obsidian and Light themes; this theme keeps a solid background.';
  if (!a) return 'The title bar and sidebar use the Windows Mica material.';
  switch (a.backdrop === 'mica' ? null : a.backdropReason) {
    case 'unsupported': return 'Mica needs Windows 11, so VYSTRAL keeps a solid background.';
    case 'transparencyOff': return 'Transparency effects are off in Windows, so VYSTRAL keeps a solid background.';
    case 'energySaver': return 'Energy saver is on, so VYSTRAL keeps a solid background to save power.';
    case 'highContrast': return 'Windows contrast themes keep a solid background.';
    case 'safeMode': return 'Safe mode keeps a solid background.';
    case 'preview': return 'Mica appears in the VYSTRAL app (not in this browser preview).';
    default: return 'The title bar and sidebar use the Windows Mica material.';
  }
}
