/**
 * Shortcut text helpers for the summon-hotkey field. Mirrors Vystral.Windows.Services.Hotkey:
 * one key (A–Z, 0–9, F1–F24) plus Ctrl, Alt and/or Win (Shift is allowed as an extra).
 */

export type ShortcutCheck = { ok: true; shortcut: string } | { ok: false; error: string };

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Win'] as const;
type Mod = (typeof MOD_ORDER)[number];

const MOD_ALIASES: Record<string, Mod> = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', windows: 'Win', meta: 'Win' };

function canonicalKey(part: string): string | null {
  if (/^[a-z]$/i.test(part)) return part.toUpperCase();
  if (/^[0-9]$/.test(part)) return part;
  const f = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(part);
  return f ? `F${f[1]}` : null;
}

export function validateShortcut(text: string): ShortcutCheck {
  if (!text.trim() || text.length > 40) return { ok: false, error: 'Enter a shortcut such as Ctrl+Alt+V.' };
  const mods = new Set<Mod>();
  let key: string | null = null;
  for (const raw of text.split('+')) {
    const part = raw.trim();
    const mod = MOD_ALIASES[part.toLowerCase()];
    if (mod) {
      if (mods.has(mod)) return { ok: false, error: 'A modifier key appears twice.' };
      mods.add(mod);
      continue;
    }
    if (key) return { ok: false, error: 'Use one key plus modifiers, for example Ctrl+Alt+V.' };
    key = canonicalKey(part);
    if (!key) return { ok: false, error: `“${part.slice(0, 12)}” can’t be used. Use a letter, a number or F1–F24.` };
  }
  if (!key) return { ok: false, error: 'Add a letter, number or function key.' };
  if (!mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Win')) {
    return { ok: false, error: 'Include Ctrl, Alt or Win so the shortcut doesn’t interfere with typing.' };
  }
  return { ok: true, shortcut: [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+') };
}

export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Turns a keydown into shortcut text. Returns null while only modifiers are held (keep
 * listening). Uses `code` so the layout (AZERTY, Cyrillic…) doesn't change the result.
 */
export function shortcutFromKey(e: KeyLike): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph'].includes(e.key)) return null;
  else key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Win');
  return [...mods, key].join('+');
}
