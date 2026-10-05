import { useEffect, useMemo } from 'react';
import { useReducedMotion, useStore } from '../../state/store';
import { requestBackdrop, startSystemAppearance, useSystemAppearance } from '../../state/systemAppearance';
import { deriveSystemAccent } from '../../lib/systemAccent';
import { BACKDROP_FADE_MS, backdropHint } from '../../lib/backdrop';
import './backdrop.css';

/**
 * Track G. Two jobs, no markup:
 * 1. "Windows accent": applies the (contrast-checked) Windows accent as --game / --game-2.
 * 2. Mica: when Living Canvas is off (desktop mode, Obsidian or Light theme, not safe mode) asks the
 *    shell for a Mica backdrop and, once the shell confirms it, sets `data-backdrop="mica"` so the
 *    title bar and sidebar turn translucent. Turning it off fades the page's own background back in
 *    first, then tells the shell, so the window never shows a see-through gap.
 */
export function SystemBackdrop() {
  const settings = useStore((s) => s.settings);
  const mode = useStore((s) => s.window.mode);
  const safeMode = useStore((s) => s.info?.safeMode ?? false);
  const reduce = useReducedMotion();
  const appearance = useSystemAppearance((s) => s.appearance);

  useEffect(() => startSystemAppearance(), []);

  // ---- Windows accent ----
  const useWindowsAccent = settings?.['appearance.accent'] === 'system';
  const derived = useMemo(
    () => (useWindowsAccent && appearance ? deriveSystemAccent(appearance.accent, appearance.accentLight) : null),
    [useWindowsAccent, appearance],
  );
  useEffect(() => {
    if (!derived) return;
    const style = document.documentElement.style;
    style.setProperty('--game', derived.accent);
    style.setProperty('--game-2', derived.accent2);
  }, [derived]);

  // ---- Mica ----
  const theme = settings?.['appearance.theme'];
  const wanted = !!settings && !settings['appearance.livingCanvas'] && (theme === 'obsidian' || theme === 'light') && mode === 'desktop' && !safeMode;

  useEffect(() => {
    const root = document.documentElement;
    let cancelled = false;
    let timer: number | undefined;
    if (wanted) {
      // The shell turns Mica on first; only then does the page make its chrome transparent.
      void requestBackdrop(true).then((a) => {
        if (!cancelled) root.dataset.backdrop = a?.backdrop === 'mica' ? 'mica' : 'none';
      });
    } else {
      const was = root.dataset.backdrop === 'mica';
      root.dataset.backdrop = 'none';
      timer = window.setTimeout(() => void requestBackdrop(false), was && !reduce ? BACKDROP_FADE_MS : 0);
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [wanted, reduce]);

  // The shell can drop Mica by itself (energy saver, high contrast, transparency effects turned off).
  // It waits for this fade before making the window opaque again.
  useEffect(() => {
    if (!appearance) return;
    const root = document.documentElement;
    if (appearance.backdrop !== 'mica' && root.dataset.backdrop === 'mica') root.dataset.backdrop = 'none';
    else if (appearance.backdrop === 'mica' && wanted) root.dataset.backdrop = 'mica';
  }, [appearance, wanted]);

  return null;
}

/** Settings → Appearance: what the Mica backdrop is doing, and why when it's off. */
export function BackdropHint() {
  const a = useSystemAppearance((s) => s.appearance);
  const livingCanvas = useStore((s) => !!s.settings?.['appearance.livingCanvas']);
  const theme = useStore((s) => s.settings?.['appearance.theme']);
  return <>{backdropHint(a, livingCanvas, theme)}</>;
}
