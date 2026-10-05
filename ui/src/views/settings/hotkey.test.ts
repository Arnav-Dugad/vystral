import { describe, expect, it } from 'vitest';
import { shortcutFromKey, validateShortcut, type KeyLike } from './hotkey';

const key = (code: string, k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k, code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods,
});

describe('validateShortcut', () => {
  it.each([
    ['Ctrl+Alt+V', 'Ctrl+Alt+V'],
    ['alt+ctrl+v', 'Ctrl+Alt+V'],
    ['Win+Shift+G', 'Shift+Win+G'],
    ['Ctrl+F12', 'Ctrl+F12'],
    [' Control + Alt + 1 ', 'Ctrl+Alt+1'],
  ])('accepts %s as %s', (input, expected) => {
    expect(validateShortcut(input)).toEqual({ ok: true, shortcut: expected });
  });

  it.each(['', 'V', 'Shift+V', 'Ctrl+Alt', 'Ctrl+V+B', 'Ctrl+Ctrl+V', 'Ctrl+Alt+Esc', 'Ctrl+F25', 'Ctrl+é'])('rejects %j', (input) => {
    const r = validateShortcut(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
  });
});

describe('shortcutFromKey', () => {
  it('waits while only modifiers are held', () => {
    expect(shortcutFromKey(key('ControlLeft', 'Control', { ctrlKey: true }))).toBeNull();
    expect(shortcutFromKey(key('AltLeft', 'Alt', { ctrlKey: true, altKey: true }))).toBeNull();
  });

  it('uses the physical key so keyboard layouts don’t matter', () => {
    // AZERTY: the key labelled "A" reports code KeyQ; Cyrillic reports "м" for KeyV.
    expect(shortcutFromKey(key('KeyV', 'м', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+V');
    expect(shortcutFromKey(key('Digit7', 'è', { altKey: true, shiftKey: true }))).toBe('Alt+Shift+7');
    expect(shortcutFromKey(key('F9', 'F9', { metaKey: true }))).toBe('Win+F9');
  });

  it('reports other keys so validation can explain them', () => {
    const text = shortcutFromKey(key('Escape', 'Escape', { ctrlKey: true }))!;
    expect(text).toBe('Ctrl+Escape');
    expect(validateShortcut(text).ok).toBe(false);
  });
});
