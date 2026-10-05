import { describe, expect, it } from 'vitest';
import { ACCENT_MIN_CONTRAST, ACCENT2_MIN_CONTRAST, ACCENT_SURFACE, deriveSystemAccent, parseHex } from './systemAccent';
import { contrastRatio, lchToRgb, type LCh } from './color';
import { PREVIEW_SYSTEM_ACCENTS } from '../bridge/preview.shell';
import { backdropHint } from './backdrop';
import type { SystemAppearance } from '../bridge/types';

const parseOklch = (css: string): LCh => {
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(css);
  if (!m) throw new Error(`not oklch: ${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const contrastOf = (css: string) => contrastRatio(lchToRgb(parseOklch(css)), ACCENT_SURFACE);

// Real Windows palettes (Settings → Personalization → Colours), plus extremes Windows allows.
const PALETTES: [string, string[]][] = [
  ['#0078D4', ['#429CE3', '#76B9ED', '#99EBFF']], // default blue
  ['#E81123', ['#F04E5B', '#F58390', '#FAB8C0']], // red
  ['#FFB900', ['#FFC83D', '#FFD772', '#FFE6A6']], // gold
  ['#107C10', ['#3C9E3C', '#6DBE6D', '#9EDE9E']], // green
  ['#000000', ['#1A1A1A', '#333333', '#4D4D4D']], // custom black
  ['#FFFFFF', ['#FFFFFF', '#FFFFFF', '#FFFFFF']], // custom white
  ['#1B1464', []],                                  // dark custom, no light shades
  ...PREVIEW_SYSTEM_ACCENTS.map((p) => [p.accent, p.accentLight] as [string, string[]]),
];

describe('parseHex', () => {
  it('parses #RRGGBB and #RGB', () => {
    expect(parseHex('#0078D4')).toEqual([0, 120 / 255, 212 / 255]);
    expect(parseHex('#fff')).toEqual([1, 1, 1]);
  });
  it.each(['', '0078D4', '#12345', '#GGGGGG', 'red', 'url(x)', null, undefined])('rejects %s', (v) => {
    expect(parseHex(v as string)).toBeNull();
  });
});

describe('deriveSystemAccent', () => {
  it.each(PALETTES)('keeps %s readable on VYSTRAL panels', (accent, light) => {
    const d = deriveSystemAccent(accent, light)!;
    expect(d).not.toBeNull();
    expect(contrastOf(d.accent)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    expect(contrastOf(d.accent2)).toBeGreaterThanOrEqual(ACCENT2_MIN_CONTRAST);
    expect(d.contrast).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    // Never washed out: stays in the accent band the design is built for.
    expect(parseOklch(d.accent)[0]).toBeLessThanOrEqual(0.87);
  });

  it('stays faithful to the Windows hue', () => {
    const blue = parseOklch(deriveSystemAccent('#0078D4', ['#429CE3', '#76B9ED', '#99EBFF'])!.accent);
    expect(blue[2]).toBeGreaterThan(230);
    expect(blue[2]).toBeLessThan(270);
    const red = parseOklch(deriveSystemAccent('#E81123', ['#F04E5B', '#F58390', '#FAB8C0'])!.accent);
    expect(red[2] < 40 || red[2] > 340).toBe(true);
  });

  it("prefers Windows' own shades before adjusting", () => {
    expect(deriveSystemAccent('#FFB900', ['#FFC83D'])!.source).toBe('accent');
    expect(deriveSystemAccent('#0078D4', ['#429CE3', '#76B9ED', '#99EBFF'])!.source).not.toBe('adjusted');
  });

  it('returns null for garbage', () => {
    expect(deriveSystemAccent('not a colour')).toBeNull();
  });
});

describe('backdropHint', () => {
  const base: SystemAppearance = {
    accent: '#0078D4', accentLight: [], accentDark: [], systemDark: true, highContrast: false, transparencyEffects: true,
    energySaver: false, backdropSupported: true, backdropRequested: true, backdrop: 'mica', backdropReason: null,
  };
  it('explains why Mica is off', () => {
    expect(backdropHint({ ...base, backdrop: 'none', backdropReason: 'transparencyOff' }, false, 'obsidian')).toMatch(/Transparency effects/);
    expect(backdropHint({ ...base, backdrop: 'none', backdropReason: 'unsupported' }, false, 'light')).toMatch(/Windows 11/);
    expect(backdropHint({ ...base, backdrop: 'none', backdropReason: 'energySaver' }, false, 'obsidian')).toMatch(/Energy saver/);
    expect(backdropHint(base, false, 'oled')).toMatch(/solid background/);
    expect(backdropHint(base, false, 'obsidian')).toMatch(/Mica material/);
    expect(backdropHint(base, true, 'obsidian')).toMatch(/When it’s off/);
  });
});
