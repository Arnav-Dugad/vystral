/**
 * Controller button glyph geometry (Track T). Every glyph is drawn, never typeset: letters come
 * from a tiny monoline stroke font placed by its own geometric bounds, so "A", "LB" or "ZR" sit
 * exactly in the middle of their shape at any size, in any font, on any DPI. Pure: the bounds and
 * centring are unit-tested.
 *
 * Coordinates: each glyph has a 24-unit-high viewBox; widths vary by shape.
 */
import type { PadFamily } from './padFamily';

export type PadButton =
  | 'A' | 'B' | 'X' | 'Y' | 'LB' | 'RB' | 'LT' | 'RT' | 'Menu' | 'View'
  | 'Dpad' | 'DpadH' | 'DpadV' | 'LS' | 'RS';

type Seg =
  | ['M' | 'L', number, number]
  | ['H', number]
  | ['V', number]
  | ['A', number, 0 | 1, 0 | 1, number, number]
  | ['C', number, number, number, number, number, number];

/** Cap height 10 (y 0 = top), x from 0 to `w` (the stroke centre-line's bounds). */
const FONT: Record<string, { w: number; d: Seg[] }> = {
  A: { w: 7.6, d: [['M', 0, 10], ['L', 3.8, 0], ['L', 7.6, 10], ['M', 1.38, 6.5], ['H', 6.22]] },
  B: { w: 6.6, d: [['M', 0, 10], ['V', 0], ['H', 3.7], ['A', 2.5, 0, 1, 3.7, 5], ['H', 0], ['M', 3.7, 5], ['H', 4.1], ['A', 2.5, 0, 1, 4.1, 10], ['H', 0]] },
  X: { w: 7.2, d: [['M', 0, 0], ['L', 7.2, 10], ['M', 7.2, 0], ['L', 0, 10]] },
  Y: { w: 7.4, d: [['M', 0, 0], ['L', 3.7, 5.1], ['L', 7.4, 0], ['M', 3.7, 5.1], ['V', 10]] },
  L: { w: 5.6, d: [['M', 0, 0], ['V', 10], ['H', 5.6]] },
  R: { w: 6.4, d: [['M', 0, 10], ['V', 0], ['H', 3.6], ['A', 2.6, 0, 1, 3.6, 5.2], ['H', 0], ['M', 3.3, 5.2], ['L', 6.4, 10]] },
  T: { w: 7, d: [['M', 0, 0], ['H', 7], ['M', 3.5, 0], ['V', 10]] },
  Z: { w: 6.6, d: [['M', 0, 0], ['H', 6.6], ['L', 0, 10], ['H', 6.6]] },
  '1': { w: 3, d: [['M', 0, 2.1], ['L', 3, 0], ['V', 10]] },
  '2': { w: 6.3, d: [['M', 0.1, 2.5], ['C', 0.6, 0.8, 1.9, 0, 3.2, 0], ['C', 4.9, 0, 6.1, 1.2, 6.1, 2.8], ['C', 6.1, 4.5, 4.7, 5.6, 3.3, 6.7], ['L', 0, 10], ['H', 6.3]] },
  '+': { w: 7, d: [['M', 3.5, 1.5], ['V', 8.5], ['M', 0, 5], ['H', 7]] },
  '-': { w: 7, d: [['M', 0, 5], ['H', 7]] },
};
const TRACKING = 2.1;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Width of a string in font units (cap height 10). */
export function textWidth(text: string): number {
  const chars = [...text].filter((c) => FONT[c]);
  return chars.reduce((w, c) => w + FONT[c].w, 0) + Math.max(0, chars.length - 1) * TRACKING;
}

/**
 * Path data for `text` drawn with cap height `cap`, its geometric centre at (cx, cy).
 * Strokes are centred on these lines, so the inked bounds are centred too.
 */
export function strokeText(text: string, cap: number, cx: number, cy: number): string {
  const s = cap / 10;
  let x0 = cx - (textWidth(text) * s) / 2;
  const y0 = cy - 5 * s;
  const out: string[] = [];
  for (const c of text) {
    const g = FONT[c];
    if (!g) continue;
    const X = (x: number) => r3(x0 + x * s);
    const Y = (y: number) => r3(y0 + y * s);
    for (const seg of g.d) {
      switch (seg[0]) {
        case 'M': case 'L': out.push(`${seg[0]}${X(seg[1])} ${Y(seg[2])}`); break;
        case 'H': out.push(`H${X(seg[1])}`); break;
        case 'V': out.push(`V${Y(seg[1])}`); break;
        case 'A': out.push(`A${r3(seg[1] * s)} ${r3(seg[1] * s)} 0 ${seg[2]} ${seg[3]} ${X(seg[4])} ${Y(seg[5])}`); break;
        case 'C': out.push(`C${X(seg[1])} ${Y(seg[2])} ${X(seg[3])} ${Y(seg[4])} ${X(seg[5])} ${Y(seg[6])}`); break;
      }
    }
    x0 += (g.w + TRACKING) * s;
  }
  return out.join('');
}

/* ------------------------------------------------------------------ shapes */

export type GlyphShape = 'face' | 'bumper' | 'trigger' | 'center' | 'dpad' | 'stick';

export const SHAPE_WIDTH: Record<GlyphShape, number> = { face: 24, center: 24, dpad: 24, stick: 24, bumper: 34, trigger: 28 };

/** Left bumper outline (34 × 24): a rounded bar whose outer top corner sweeps like the shoulder. */
export const BUMPER_PATH = 'M9.5 4.5H29A3 3 0 0 1 32 7.5V16.5A3 3 0 0 1 29 19.5H5A3 3 0 0 1 2 16.5V12C2 7.86 5.36 4.5 9.5 4.5Z';
/** Left trigger outline (28 × 24): straight top, deep rounded bottom. */
export const TRIGGER_PATH = 'M7 3.25H21A3.5 3.5 0 0 1 24.5 6.75V13.75A7 7 0 0 1 17.5 20.75H10.5A7 7 0 0 1 3.5 13.75V6.75A3.5 3.5 0 0 1 7 3.25Z';
export const DPAD_PATH = 'M9.2 3.6H14.8V9.2H20.4V14.8H14.8V20.4H9.2V14.8H3.6V9.2H9.2Z';

/** Which shape, which drawing and which colour role a button takes in a family. */
export interface GlyphSpec {
  shape: GlyphShape;
  /** Tone class: the fill and ink colours (CSS `data-tone`). */
  tone: string;
  /** Text drawn with the stroke font, if any. */
  text?: string;
  /** A symbol instead of text. */
  symbol?: 'cross' | 'circle' | 'square' | 'triangle' | 'menu' | 'view' | 'options' | 'create';
  /** Spoken name ("A button", "Cross button", "D-pad"). */
  name: string;
  /** Mirror the outline (right bumper/trigger). */
  mirror?: boolean;
  /** D-pad arms to emphasise. */
  arms?: 'all' | 'h' | 'v';
}

const PS_FACE = { A: ['cross', 'Cross'], B: ['circle', 'Circle'], X: ['square', 'Square'], Y: ['triangle', 'Triangle'] } as const;
/** Nintendo prints its letters in other places: the button in Xbox's A position reads "B", and so on. */
const NINTENDO_FACE = { A: 'B', B: 'A', X: 'Y', Y: 'X' } as const;

export function glyphSpec(button: PadButton, family: PadFamily): GlyphSpec {
  const shoulder = (side: 'L' | 'R', trigger: boolean): GlyphSpec => {
    const text = family === 'playstation' ? `${side}${trigger ? 2 : 1}` : family === 'nintendo' ? (trigger ? `Z${side}` : side) : `${side}${trigger ? 'T' : 'B'}`;
    return { shape: trigger ? 'trigger' : 'bumper', tone: 'neutral', text, name: `${text} button`, mirror: side === 'R' };
  };
  switch (button) {
    case 'A': case 'B': case 'X': case 'Y': {
      if (family === 'playstation') {
        const [symbol, name] = PS_FACE[button];
        return { shape: 'face', tone: `ps-${symbol}`, symbol, name: `${name} button` };
      }
      if (family === 'nintendo') {
        const letter = NINTENDO_FACE[button];
        return { shape: 'face', tone: 'dark', text: letter, name: `${letter} button` };
      }
      return { shape: 'face', tone: button.toLowerCase(), text: button, name: `${button} button` };
    }
    case 'LB': return shoulder('L', false);
    case 'RB': return shoulder('R', false);
    case 'LT': return shoulder('L', true);
    case 'RT': return shoulder('R', true);
    case 'Menu':
      if (family === 'playstation') return { shape: 'center', tone: 'neutral', symbol: 'options', name: 'Options button' };
      if (family === 'nintendo') return { shape: 'center', tone: 'neutral', text: '+', name: 'Plus button' };
      return { shape: 'center', tone: 'neutral', symbol: 'menu', name: 'Menu button' };
    case 'View':
      if (family === 'playstation') return { shape: 'center', tone: 'neutral', symbol: 'create', name: 'Create button' };
      if (family === 'nintendo') return { shape: 'center', tone: 'neutral', text: '-', name: 'Minus button' };
      return { shape: 'center', tone: 'neutral', symbol: 'view', name: 'View button' };
    case 'Dpad': return { shape: 'dpad', tone: 'neutral', arms: 'all', name: 'D-pad' };
    case 'DpadH': return { shape: 'dpad', tone: 'neutral', arms: 'h', name: 'D-pad left or right' };
    case 'DpadV': return { shape: 'dpad', tone: 'neutral', arms: 'v', name: 'D-pad up or down' };
    case 'LS': return { shape: 'stick', tone: 'neutral', text: 'L', name: 'Left stick' };
    case 'RS': return { shape: 'stick', tone: 'neutral', text: 'R', name: 'Right stick' };
  }
}

/** Cap height and stroke width of text on each shape (in viewBox units). */
export const TEXT_METRICS: Record<GlyphShape, { cap: number; stroke: number; cy: number }> = {
  face: { cap: 10.4, stroke: 2.2, cy: 12 },
  center: { cap: 9, stroke: 2.2, cy: 12 },
  bumper: { cap: 7.4, stroke: 1.85, cy: 12 },
  // The trigger's mass sits low (deep rounded bottom), so its label sits a hair above the box centre.
  trigger: { cap: 7.4, stroke: 1.85, cy: 11.6 },
  stick: { cap: 7, stroke: 1.9, cy: 12 },
  dpad: { cap: 0, stroke: 0, cy: 12 },
};

/** The x centre of the label on a shape (the bumper's sweep moves its visual centre outward). */
export function textCenterX(spec: GlyphSpec): number {
  const w = SHAPE_WIDTH[spec.shape];
  if (spec.shape === 'bumper') return spec.mirror ? w / 2 - 0.6 : w / 2 + 0.6;
  return w / 2;
}
