import { describe, expect, it } from 'vitest';
import { glyphSpec, SHAPE_WIDTH, strokeText, TEXT_METRICS, textCenterX, textWidth, type PadButton } from './padGlyphs';
import { familyFromId, resolveFamily, type PadFamily } from './padFamily';

/** Bounds of a stroke-font path: samples lines, the font's semicircle arcs and cubic curves. */
function bounds(d: string) {
  const tokens = d.match(/[MLHVAC]|-?\d*\.?\d+/g)!;
  let i = 0;
  let x = 0;
  let y = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (px: number, py: number) => {
    xs.push(px);
    ys.push(py);
  };
  const num = () => parseFloat(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'L') {
      x = num();
      y = num();
      add(x, y);
    } else if (cmd === 'H') {
      x = num();
      add(x, y);
    } else if (cmd === 'V') {
      y = num();
      add(x, y);
    } else if (cmd === 'A') {
      const r = num();
      num(); num(); num(); num();
      const nx = num();
      const ny = num();
      // The font only uses vertical semicircles bulging right (sweep 1, going down).
      const cy = (y + ny) / 2;
      for (let a = -90; a <= 90; a += 5) add(x + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180));
      x = nx;
      y = ny;
    } else if (cmd === 'C') {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let t = 0; t <= 1; t += 0.05) {
        const u = 1 - t;
        add(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3);
      }
      x = x3;
      y = y3;
    } else throw new Error(`unexpected ${cmd}`);
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

const BUTTONS: PadButton[] = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Menu', 'View', 'LS', 'RS'];
const FAMILIES: PadFamily[] = ['xbox', 'playstation', 'nintendo'];

describe('controller glyphs', () => {
  it('every label is geometrically centred on its shape (within 0.15 of 24 units)', () => {
    for (const family of FAMILIES) {
      for (const button of BUTTONS) {
        const spec = glyphSpec(button, family);
        if (!spec.text) continue;
        const m = TEXT_METRICS[spec.shape];
        const cx = spec.shape === 'stick' ? 12 : textCenterX(spec);
        const b = bounds(strokeText(spec.text, m.cap, cx, m.cy));
        expect(Math.abs((b.minX + b.maxX) / 2 - cx), `${family} ${button} x`).toBeLessThan(0.15);
        expect(Math.abs((b.minY + b.maxY) / 2 - m.cy), `${family} ${button} y`).toBeLessThan(0.15);
        // …and fits inside its shape with room for the stroke.
        expect(b.minX).toBeGreaterThan(1.5);
        expect(b.maxX).toBeLessThan(SHAPE_WIDTH[spec.shape] - 1.5);
      }
    }
  });

  it('measures text from the stroke font, ignoring unknown characters', () => {
    expect(textWidth('A')).toBeCloseTo(7.6);
    expect(textWidth('LB')).toBeGreaterThan(textWidth('L') + textWidth('B'));
    expect(textWidth('L?B')).toBe(textWidth('LB'));
    expect(strokeText('', 10, 12, 12)).toBe('');
  });

  it('names and draws each family: Xbox letters, PlayStation symbols, Nintendo positions', () => {
    expect(glyphSpec('A', 'xbox')).toMatchObject({ shape: 'face', tone: 'a', text: 'A', name: 'A button' });
    expect(glyphSpec('A', 'playstation')).toMatchObject({ symbol: 'cross', name: 'Cross button' });
    expect(glyphSpec('Y', 'playstation')).toMatchObject({ symbol: 'triangle', name: 'Triangle button' });
    // Nintendo prints B where Xbox has A (the bottom button), and so on.
    expect(glyphSpec('A', 'nintendo')).toMatchObject({ text: 'B', name: 'B button' });
    expect(glyphSpec('X', 'nintendo')).toMatchObject({ text: 'Y' });
    expect(glyphSpec('LB', 'playstation')).toMatchObject({ shape: 'bumper', text: 'L1' });
    expect(glyphSpec('RT', 'nintendo')).toMatchObject({ shape: 'trigger', text: 'ZR', mirror: true });
    expect(glyphSpec('Menu', 'xbox')).toMatchObject({ symbol: 'menu', name: 'Menu button' });
    expect(glyphSpec('View', 'xbox')).toMatchObject({ symbol: 'view', name: 'View button' });
    expect(glyphSpec('Menu', 'nintendo')).toMatchObject({ text: '+', name: 'Plus button' });
    expect(glyphSpec('View', 'playstation')).toMatchObject({ symbol: 'create', name: 'Create button' });
    expect(glyphSpec('DpadH', 'xbox')).toMatchObject({ shape: 'dpad', arms: 'h' });
  });

  it('detects the controller family from a Gamepad id', () => {
    expect(familyFromId('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe('playstation');
    expect(familyFromId('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)')).toBe('playstation');
    expect(familyFromId('Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)')).toBe('nintendo');
    expect(familyFromId('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
    expect(familyFromId('045e-0b13-Xbox Wireless Controller')).toBe('xbox');
    expect(familyFromId('Generic USB Joystick (Vendor: 0079 Product: 0006)')).toBeNull();
    expect(familyFromId('')).toBeNull();
    expect(familyFromId(undefined)).toBeNull();
  });

  it('an explicit choice wins over detection; auto falls back to Xbox', () => {
    expect(resolveFamily('nintendo', 'playstation')).toBe('nintendo');
    expect(resolveFamily('auto', 'playstation')).toBe('playstation');
    expect(resolveFamily('auto', null)).toBe('xbox');
    expect(resolveFamily(undefined, null)).toBe('xbox');
    expect(resolveFamily('bogus', 'nintendo')).toBe('nintendo');
  });
});
