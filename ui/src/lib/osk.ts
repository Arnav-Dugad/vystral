/**
 * On-screen keyboard model: key layouts, the controller navigation reducer and text editing.
 * Pure functions so the feel (wrapping, sticky columns, zone changes) is unit-tested.
 *
 * The keyboard is a 10-column grid. Keys can span columns; vertical moves keep a "sticky" x
 * (the centre of the key you came from) so moving up and down a column feels anchored, the
 * same way Immersive Mode's rows do. Above the keys sit two prediction zones: word
 * completions and matching games.
 */

export type KeyKind = 'char' | 'space' | 'backspace' | 'clear' | 'done' | 'layout';
export type OskLayoutName = 'letters' | 'symbols';
export type OskDir = 'up' | 'down' | 'left' | 'right';
export type OskZone = 'games' | 'words' | 'keys';

export interface OskKey {
  id: string;
  kind: KeyKind;
  label: string;
  /** Text inserted by a char key. */
  value?: string;
  /** Width in grid columns. */
  span: number;
}

export const OSK_COLUMNS = 10;
export const OSK_MAX_LENGTH = 60;

const chars = (row: string, prefix: string): OskKey[] =>
  [...row].map((c, i) => ({ id: `${prefix}${i}`, kind: 'char', label: c, value: c, span: 1 }));

function actionRow(layout: OskLayoutName): OskKey[] {
  return [
    { id: 'layout', kind: 'layout', label: layout === 'letters' ? '&?123' : 'abc', span: 2 },
    { id: 'space', kind: 'space', label: 'Space', span: 4 },
    { id: 'backspace', kind: 'backspace', label: 'Backspace', span: 1 },
    { id: 'clear', kind: 'clear', label: 'Clear', span: 1 },
    { id: 'done', kind: 'done', label: 'Done', span: 2 },
  ];
}

export const OSK_LAYOUTS: Record<OskLayoutName, OskKey[][]> = {
  letters: [
    chars('1234567890', 'd'),
    chars('qwertyuiop', 'l1-'),
    chars("asdfghjkl'", 'l2-'),
    chars('zxcvbnm-:.', 'l3-'),
    actionRow('letters'),
  ],
  symbols: [
    chars('1234567890', 'd'),
    chars('!?&#+=()/*', 's1-'),
    chars(';,"_@$%~|\\', 's2-'),
    chars('éöüñçàøß[]', 's3-'),
    actionRow('symbols'),
  ],
};

export interface OskNav {
  zone: OskZone;
  row: number;
  col: number;
  /** Sticky horizontal position (grid units, key centre) used for vertical moves. */
  x: number;
  /** Remembered position in each prediction zone. */
  word: number;
  game: number;
}

export interface OskCounts {
  games: number;
  words: number;
}

export interface NavResult {
  nav: OskNav;
  /** Focus changed. */
  moved: boolean;
  /** The move ran into an edge (feedback: haptic bump). */
  blocked: boolean;
  /** Horizontal move wrapped around the row. */
  wrapped: boolean;
  /** Entered a different zone. */
  zoneChanged: boolean;
}

/** Start of each key in grid columns. */
export function keyStarts(row: OskKey[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const k of row) {
    out.push(at);
    at += k.span;
  }
  return out;
}

export function keyCentre(layout: OskKey[][], row: number, col: number): number {
  const r = layout[row];
  return keyStarts(r)[col] + r[col].span / 2;
}

/** The key in `row` under horizontal position `x`. */
export function keyAt(layout: OskKey[][], row: number, x: number): number {
  const r = layout[row];
  const starts = keyStarts(r);
  for (let i = r.length - 1; i >= 0; i--) if (x >= starts[i]) return i;
  return 0;
}

export function initialNav(layout: OskKey[][]): OskNav {
  // Start on "q" (or its symbol-layout counterpart), like a console keyboard.
  return { zone: 'keys', row: 1, col: 0, x: keyCentre(layout, 1, 0), word: 0, game: 0 };
}

/** Keeps a position valid after predictions or the layout change underneath it. */
export function normalizeNav(layout: OskKey[][], nav: OskNav, counts: OskCounts): OskNav {
  let next = { ...nav, word: clamp(nav.word, 0, counts.words - 1), game: clamp(nav.game, 0, counts.games - 1) };
  if (next.zone === 'games' && counts.games === 0) next = { ...next, zone: counts.words > 0 ? 'words' : 'keys' };
  if (next.zone === 'words' && counts.words === 0) next = { ...next, zone: 'keys' };
  const row = clamp(next.row, 0, layout.length - 1);
  const col = clamp(next.col, 0, layout[row].length - 1);
  return { ...next, row, col };
}

export function moveNav(layout: OskKey[][], nav: OskNav, dir: OskDir, counts: OskCounts): NavResult {
  const at = normalizeNav(layout, nav, counts);
  const result = (n: OskNav, extra: Partial<NavResult> = {}): NavResult => ({
    nav: n,
    moved: n.zone !== at.zone || n.row !== at.row || n.col !== at.col || (n.zone === 'words' && n.word !== at.word) || (n.zone === 'games' && n.game !== at.game),
    blocked: false,
    wrapped: false,
    zoneChanged: n.zone !== at.zone,
    ...extra,
  });
  const blocked = () => result(at, { blocked: true });
  const enterKeys = (): OskNav => {
    const col = keyAt(layout, 0, at.x);
    return { ...at, zone: 'keys', row: 0, col };
  };

  if (at.zone === 'keys') {
    const row = layout[at.row];
    switch (dir) {
      case 'left':
      case 'right': {
        const step = dir === 'left' ? -1 : 1;
        const raw = at.col + step;
        const col = (raw + row.length) % row.length;
        return result({ ...at, col, x: keyCentre(layout, at.row, col) }, { wrapped: raw !== col });
      }
      case 'up':
        if (at.row > 0) return result({ ...at, row: at.row - 1, col: keyAt(layout, at.row - 1, at.x) });
        if (counts.words > 0) return result({ ...at, zone: 'words' });
        if (counts.games > 0) return result({ ...at, zone: 'games' });
        return blocked();
      case 'down':
        if (at.row < layout.length - 1) return result({ ...at, row: at.row + 1, col: keyAt(layout, at.row + 1, at.x) });
        return blocked();
    }
  }

  if (at.zone === 'words') {
    switch (dir) {
      case 'left':
        return at.word > 0 ? result({ ...at, word: at.word - 1 }) : blocked();
      case 'right':
        return at.word < counts.words - 1 ? result({ ...at, word: at.word + 1 }) : blocked();
      case 'up':
        return counts.games > 0 ? result({ ...at, zone: 'games' }) : blocked();
      case 'down':
        return result(enterKeys());
    }
  }

  // games
  switch (dir) {
    case 'left':
      return at.game > 0 ? result({ ...at, game: at.game - 1 }) : blocked();
    case 'right':
      return at.game < counts.games - 1 ? result({ ...at, game: at.game + 1 }) : blocked();
    case 'up':
      return blocked();
    case 'down':
      return counts.words > 0 ? result({ ...at, zone: 'words' }) : result(enterKeys());
  }
}

/** Switching layouts keeps the same grid position (both layouts have the same shape). */
export function switchLayout(name: OskLayoutName): OskLayoutName {
  return name === 'letters' ? 'symbols' : 'letters';
}

// ---------------- Text editing ----------------

export interface OskText {
  text: string;
  caret: number;
}

export function insertText(t: OskText, s: string): OskText {
  const caret = clamp(t.caret, 0, t.text.length);
  // Collapse double spaces and never start with one: they only make searches miss.
  if (s === ' ' && (caret === 0 || t.text[caret - 1] === ' ')) return { text: t.text, caret };
  const room = OSK_MAX_LENGTH - t.text.length;
  if (room <= 0) return { text: t.text, caret };
  const add = s.slice(0, room);
  return { text: t.text.slice(0, caret) + add + t.text.slice(caret), caret: caret + add.length };
}

export function backspace(t: OskText): OskText {
  const caret = clamp(t.caret, 0, t.text.length);
  if (caret === 0) return { text: t.text, caret };
  return { text: t.text.slice(0, caret - 1) + t.text.slice(caret), caret: caret - 1 };
}

export function moveCaret(t: OskText, delta: number): OskText {
  return { text: t.text, caret: clamp(t.caret + delta, 0, t.text.length) };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}
