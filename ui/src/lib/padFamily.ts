import { useSyncExternalStore } from 'react';
import { on } from '../bridge/bridge';
import { useStore } from '../state/store';

/**
 * Which controller family's button glyphs to draw (Track T). VYSTRAL's button names are
 * positional, Xbox-style (A = bottom face button, View/Menu = the two small centre buttons); a
 * PlayStation pad shows ✕ ○ □ △ in the same places, a Nintendo pad its own letters in the same
 * places (so the bottom button reads "B", exactly as printed on it).
 *
 * "Auto" follows the controller Windows reports to the page through the standard Gamepad API (the
 * `id` names the vendor). Chromium exposes a pad there only after one of its buttons was pressed,
 * so detection settles on the first press. Unknown pads use Xbox glyphs.
 */
export type PadFamily = 'xbox' | 'playstation' | 'nintendo';
export type GlyphPreference = 'auto' | PadFamily;

const VENDORS: Record<string, PadFamily> = { '054c': 'playstation', '057e': 'nintendo', '045e': 'xbox' };

/** The family a Gamepad `id` belongs to, or null when it doesn't say. Pure (unit-tested). */
export function familyFromId(id: string | null | undefined): PadFamily | null {
  if (!id || typeof id !== 'string') return null;
  const s = id.slice(0, 200).toLowerCase();
  // Chromium: "… (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"; Firefox: "054c-0ce6-…".
  const vendor = /vendor:\s*([0-9a-f]{4})/.exec(s)?.[1] ?? /^([0-9a-f]{4})-[0-9a-f]{4}-/.exec(s)?.[1];
  if (vendor && VENDORS[vendor]) return VENDORS[vendor];
  if (/dualsense|dualshock|playstation|\bps[345]\b/.test(s)) return 'playstation';
  if (/nintendo|pro controller|joy-?con|\bswitch\b/.test(s)) return 'nintendo';
  if (/xbox|xinput/.test(s)) return 'xbox';
  return null;
}

/** The family to draw: an explicit choice wins; "auto" uses what was detected, else Xbox. */
export function resolveFamily(pref: unknown, detected: PadFamily | null): PadFamily {
  if (pref === 'xbox' || pref === 'playstation' || pref === 'nintendo') return pref;
  return detected ?? 'xbox';
}

/* ------------------------------------------------------------------ detection */

let detected: PadFamily | null = null;
const listeners = new Set<() => void>();
let started = false;
let lastScan = 0;

function setDetected(f: PadFamily | null) {
  if (f === detected) return;
  detected = f;
  for (const l of listeners) l();
}

/** Re-reads the connected pads: the most recently connected one that names its family wins. */
export function scanPads() {
  lastScan = performance.now();
  let pads: (Gamepad | null)[] = [];
  try {
    pads = typeof navigator !== 'undefined' && navigator.getGamepads ? [...navigator.getGamepads()] : [];
  } catch {
    pads = [];
  }
  const connected = pads.filter((p): p is Gamepad => !!p && p.connected !== false);
  if (!connected.length) return;
  const newest = [...connected].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  for (const p of newest) {
    const f = familyFromId(p.id);
    if (f) return setDetected(f);
  }
  setDetected('xbox');
}

function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('gamepadconnected', (e) => {
    const f = familyFromId((e as GamepadEvent).gamepad?.id);
    setDetected(f ?? 'xbox');
  });
  window.addEventListener('gamepaddisconnected', () => {
    detected = null;
    scanPads();
    for (const l of listeners) l();
  });
  // Native input arrives through the bridge; the page's own Gamepad list fills after a press.
  on('gamepad.connection', () => scanPads());
  on('gamepad.button', () => {
    if (detected === null && performance.now() - lastScan > 2000) scanPads();
  });
  scanPads();
}

function subscribe(l: () => void) {
  start();
  listeners.add(l);
  return () => listeners.delete(l);
}

export const detectedFamily = () => detected;

/** The glyph family to draw now (setting `controller.glyphs` + detection). */
export function usePadFamily(): PadFamily {
  const pref = useStore((s) => s.settings?.['controller.glyphs']);
  const d = useSyncExternalStore(subscribe, detectedFamily, () => null);
  return resolveFamily(pref, d);
}

export const FAMILY_LABEL: Record<PadFamily, string> = { xbox: 'Xbox', playstation: 'PlayStation', nintendo: 'Nintendo' };
