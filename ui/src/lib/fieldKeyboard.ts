/**
 * Track S: the docked on-screen keyboard for desktop mode — pure model.
 *
 * Whenever someone drives desktop mode with a controller, any text field (search boxes, notes,
 * collection names, settings fields, API keys, the AI chat box, rename dialogs, the command
 * palette…) gets a Big Picture-style keyboard. Everything here is pure so the feel is unit-tested:
 * - classifyField: what kind of keyboard a field wants (letters, email, URL, number pad, phone pad),
 *   whether it is a secret (masked preview, no predictions, nothing remembered), its length limit,
 *   and whether "Done" should press Enter for it.
 * - layouts: letters / symbols / accents layers (plus email and URL variants) on a 10-column grid,
 *   and a 4-column number or phone pad.
 * - editing: insert / erase / caret / selection, respecting maxLength and the field kind.
 * - navigation: the D-pad reducer over keys and the suggestion row (sticky columns, wrapping rows).
 * - recent words: a small local word bank for suggestions in ordinary text fields (never secrets).
 *
 * The Immersive search keyboard (components/controller/OnScreenKeyboard.tsx, lib/osk.ts) is a
 * separate, search-only surface and is untouched by this file.
 */

// ---------------------------------------------------------------- field classification

export type FieldKind = 'text' | 'search' | 'email' | 'url' | 'number' | 'tel' | 'multiline';
export type Predict = 'games' | 'recent' | 'none';

export interface FieldSpec {
  kind: FieldKind;
  /** Password, API key or one-time code: masked preview, no predictions, nothing stored. */
  secret: boolean;
  /** Number pad: a decimal point is allowed. */
  decimal: boolean;
  /** Number pad: a minus sign is allowed. */
  negative: boolean;
  /** Effective length limit (the field's maxLength, or a generous default). */
  maxLength: number;
  /** Whether the field set its own maxLength (shown as a counter). */
  limited: boolean;
  predict: Predict;
  /** "Done" presses Enter in the field (single-line fields, or a textarea that sends on Enter). */
  submit: boolean;
}

/** What the DOM tells us about a field (gathered by lib/textEntry.ts; plain data so it is testable). */
export interface FieldTraits {
  tag: 'input' | 'textarea';
  /** The input's type attribute (lower case); '' for textareas. */
  type: string;
  inputMode?: string;
  autocomplete?: string;
  /** -1 or 0 when unset. */
  maxLength?: number;
  min?: string;
  step?: string;
  role?: string | null;
  /** The field's accessible name (label, aria-label, placeholder…). */
  label?: string;
  /** Explicit hints a view can set: data-osk-predict, data-osk-submit, data-osk-secret. */
  predict?: string | null;
  submit?: string | null;
  secret?: boolean;
  /** Inside a <form> (a textarea in a form sends on Enter, like the AI chat box). */
  inForm?: boolean;
}

/** Input types that take typed text (everything else — checkboxes, ranges, dates, files… — is not ours). */
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export function isTextEntryType(tag: string, type: string | null | undefined): boolean {
  const t = tag.toLowerCase();
  if (t === 'textarea') return true;
  return t === 'input' && TEXT_TYPES.has((type ?? '').toLowerCase());
}

const DEFAULT_MAX = 500;
const NUMBER_MAX = 24;
const SECRET_LABEL = /\b(password|passcode|secret|api[\s-]?key|access[\s-]?token|token|pin)\b/i;

export function classifyField(t: FieldTraits): FieldSpec {
  const type = (t.type || 'text').toLowerCase();
  const mode = (t.inputMode ?? '').toLowerCase();
  const auto = (t.autocomplete ?? '').toLowerCase();
  const multiline = t.tag === 'textarea';

  const secret =
    !multiline &&
    (t.secret === true ||
      type === 'password' ||
      /\b(current-password|new-password|one-time-code)\b/.test(auto) ||
      (type !== 'search' && SECRET_LABEL.test(t.label ?? '')));

  let kind: FieldKind;
  if (multiline) kind = 'multiline';
  else if (type === 'number' || mode === 'numeric' || mode === 'decimal') kind = 'number';
  else if (type === 'tel' || mode === 'tel') kind = 'tel';
  else if (type === 'email' || mode === 'email') kind = 'email';
  else if (type === 'url' || mode === 'url') kind = 'url';
  else if (type === 'search' || mode === 'search' || t.role === 'searchbox' || t.role === 'combobox') kind = 'search';
  else kind = 'text';

  const step = (t.step ?? '').trim().toLowerCase();
  const decimal = kind === 'number' && (mode === 'decimal' || step === 'any' || (step !== '' && !Number.isInteger(Number(step))));
  const min = t.min?.trim() ? Number(t.min) : NaN;
  // Numeric text inputs (inputmode=numeric) are digit strings like codes: no minus sign.
  const negative = kind === 'number' && type === 'number' && !(min >= 0);

  const own = t.maxLength && t.maxLength > 0 ? t.maxLength : 0;
  const maxLength = own || (kind === 'number' ? NUMBER_MAX : DEFAULT_MAX);

  let predict: Predict = 'none';
  if (!secret && (kind === 'text' || kind === 'search' || kind === 'multiline')) predict = t.predict === 'games' ? 'games' : t.predict === 'none' ? 'none' : 'recent';

  const submit = t.submit === 'none' ? false : t.submit === 'enter' ? true : multiline ? !!t.inForm : true;

  return { kind, secret, decimal, negative, maxLength, limited: own > 0, predict, submit };
}

// ---------------------------------------------------------------- layouts

export type Layer = 'letters' | 'symbols' | 'accents' | 'pad';
export type KeyKind = 'char' | 'text' | 'space' | 'backspace' | 'clear' | 'sign' | 'done' | 'layer' | 'shift' | 'newline';

export interface FkKey {
  id: string;
  kind: KeyKind;
  label: string;
  /** Text inserted by char/text keys. */
  value?: string;
  /** Width in grid columns. */
  span: number;
  /** Layer a layer key switches to. */
  target?: Layer;
}

export const FK_COLUMNS = 10;
export const PAD_COLUMNS = 3;

const chars = (row: string, prefix: string): FkKey[] =>
  [...row].map((c, i) => ({ id: `${prefix}${i}`, kind: 'char', label: c, value: c, span: 1 }));
const key = (id: string, kind: KeyKind, label: string, span: number, extra: Partial<FkKey> = {}): FkKey => ({ id, kind, label, span, ...extra });
const shiftKey = () => key('shift', 'shift', 'Shift', 1);
const done = (span: number) => key('done', 'done', 'Done', span);
const back = (span: number) => key('backspace', 'backspace', 'Backspace', span);

/** Each layer's switch key leads on to the next layer (letters → symbols → accents → letters). */
const NEXT_LAYER: Record<Exclude<Layer, 'pad'>, Exclude<Layer, 'pad'>> = { letters: 'symbols', symbols: 'accents', accents: 'letters' };
const LAYER_LABEL: Record<Exclude<Layer, 'pad'>, string> = { letters: 'abc', symbols: '&?123', accents: 'àéü' };

export function nextLayer(layer: Layer): Layer {
  return layer === 'pad' ? 'pad' : NEXT_LAYER[layer];
}

function actionRow(spec: FieldSpec, layer: Exclude<Layer, 'pad'>): FkKey[] {
  const next = NEXT_LAYER[layer];
  const layerKey = key('layer', 'layer', LAYER_LABEL[next], 2, { target: next });
  if (spec.kind === 'email') {
    return [layerKey, key('at', 'char', '@', 1, { value: '@' }), key('dot', 'char', '.', 1, { value: '.' }), key('dotcom', 'text', '.com', 2, { value: '.com' }), back(2), done(2)];
  }
  if (spec.kind === 'url') {
    return [layerKey, key('slash', 'char', '/', 1, { value: '/' }), key('dot', 'char', '.', 1, { value: '.' }), key('dotcom', 'text', '.com', 2, { value: '.com' }), back(2), done(2)];
  }
  if (spec.kind === 'multiline') {
    return [layerKey, key('space', 'space', 'Space', 3), key('newline', 'newline', 'New line', 2), back(1), done(2)];
  }
  return [layerKey, key('space', 'space', 'Space', 4), back(2), done(2)];
}

function lettersRow3(spec: FieldSpec): FkKey[] {
  // Shift, then z–m, then two punctuation keys that suit the field.
  const tail = spec.kind === 'email' ? '-_' : spec.kind === 'url' ? '-:' : ',.';
  return [shiftKey(), ...chars(`zxcvbnm${tail}`, 'l3-')];
}

export function layoutFor(spec: FieldSpec, layer: Layer): FkKey[][] {
  if (spec.kind === 'number' || spec.kind === 'tel' || layer === 'pad') return padLayout(spec);
  switch (layer) {
    case 'symbols':
      return [
        chars('1234567890', 'd'),
        chars('!@#$%^&*()', 's1-'),
        chars('-_=+[]{};:', 's2-'),
        [shiftKey(), ...chars(`'"/\\|~<>?`, 's3-')],
        actionRow(spec, 'symbols'),
      ];
    case 'accents':
      return [
        chars('àáâäãåæçèé', 'a0-'),
        chars('êëìíîïñòóô', 'a1-'),
        chars('öõøœùúûüýß', 'a2-'),
        [shiftKey(), ...chars('¿¡€£¥«»°…', 'a3-')],
        actionRow(spec, 'accents'),
      ];
    default:
      return [
        chars('1234567890', 'd'),
        chars('qwertyuiop', 'l1-'),
        chars("asdfghjkl'", 'l2-'),
        lettersRow3(spec),
        actionRow(spec, 'letters'),
      ];
  }
}

/** The number / phone pad: a 3×3 digit block like a phone, Backspace beside 0, Done along the bottom. */
function padLayout(spec: FieldSpec): FkKey[][] {
  const d = (c: string) => key(`p${c}`, 'char', c, 1, { value: c });
  const digits = [[d('1'), d('2'), d('3')], [d('4'), d('5'), d('6')], [d('7'), d('8'), d('9')]];
  if (spec.kind === 'tel') {
    return [
      ...digits,
      [key('star', 'char', '*', 1, { value: '*' }), d('0'), key('hash', 'char', '#', 1, { value: '#' })],
      [key('plus', 'char', '+', 1, { value: '+' }), back(1), done(1)],
    ];
  }
  const sign = key('sign', 'sign', '±', 1);
  const left = spec.decimal ? key('point', 'char', '.', 1, { value: '.' }) : spec.negative ? sign : null;
  const corner = spec.decimal && spec.negative ? sign : key('clear', 'clear', 'Clear', 1);
  return [
    ...digits,
    left ? [left, d('0'), back(1)] : [key('p0', 'char', '0', 2, { value: '0' }), back(1)],
    [corner, done(2)],
  ];
}

export function columnsFor(spec: FieldSpec): number {
  return spec.kind === 'number' || spec.kind === 'tel' ? PAD_COLUMNS : FK_COLUMNS;
}

export function initialLayer(spec: FieldSpec): Layer {
  return spec.kind === 'number' || spec.kind === 'tel' ? 'pad' : 'letters';
}

// ---------------------------------------------------------------- shift

/** off → once (next letter) → lock (caps) → off. */
export type Shift = 'off' | 'once' | 'lock';

export function cycleShift(s: Shift): Shift {
  return s === 'off' ? 'once' : s === 'once' ? 'lock' : 'off';
}

/** A character as shifted; characters without a same-length capital (ß, digits, symbols) stay. */
export function shifted(ch: string, shift: Shift): string {
  if (shift === 'off') return ch;
  const up = ch.toLocaleUpperCase();
  return [...up].length === [...ch].length ? up : ch;
}

// ---------------------------------------------------------------- editing

/** Text with a caret and a selection anchor (anchor === caret means no selection). */
export interface FkText {
  text: string;
  caret: number;
  anchor: number;
}

export const at = (text: string, caret = text.length): FkText => ({ text, caret, anchor: caret });

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}

export function selection(t: FkText): [number, number] {
  const a = clamp(t.anchor, 0, t.text.length);
  const c = clamp(t.caret, 0, t.text.length);
  return a <= c ? [a, c] : [c, a];
}

export function hasSelection(t: FkText): boolean {
  const [s, e] = selection(t);
  return e > s;
}

/** Which characters a field accepts (the rest are dropped, so the field never holds junk). */
export function accepts(spec: FieldSpec, ch: string): boolean {
  switch (spec.kind) {
    case 'number':
      return /[0-9]/.test(ch) || (ch === '.' && spec.decimal) || (ch === '-' && spec.negative);
    case 'tel':
      return /[0-9+*#() .-]/.test(ch);
    case 'email':
    case 'url':
      return ch !== ' ' && ch !== '\n';
    case 'multiline':
      return true;
    default:
      return ch !== '\n';
  }
}

export interface EditResult {
  next: FkText;
  /** Something was refused: the length limit, or a character the field doesn't take. */
  refused: boolean;
}

/** Inserts (replacing any selection), keeping to the field's rules and length limit. */
export function insert(spec: FieldSpec, t: FkText, s: string): EditResult {
  const [start, end] = selection(t);
  let add = [...s].filter((ch) => accepts(spec, ch)).join('');
  if (spec.kind === 'number') add = numberInsert(t.text, start, end, add);
  const room = spec.maxLength - (t.text.length - (end - start));
  const refused = add.length < s.length || room < add.length;
  add = add.slice(0, Math.max(0, room));
  if (!add && start === end) return { next: t, refused: true };
  const text = t.text.slice(0, start) + add + t.text.slice(end);
  return { next: at(text, start + add.length), refused };
}

/** Number fields: one minus, only at the start; one decimal point. */
function numberInsert(text: string, start: number, end: number, add: string): string {
  const rest = text.slice(0, start) + text.slice(end);
  let out = '';
  for (const ch of add) {
    const pos = start + out.length;
    if (ch === '-' && (pos !== 0 || rest.startsWith('-') || out.includes('-'))) continue;
    if (ch === '.' && (rest.includes('.') || out.includes('.'))) continue;
    out += ch;
  }
  return out;
}

/** Backspace: deletes the selection, else the character before the caret. */
export function erase(t: FkText): EditResult {
  const [start, end] = selection(t);
  if (end > start) return { next: at(t.text.slice(0, start) + t.text.slice(end), start), refused: false };
  if (start === 0) return { next: t, refused: true };
  // Whole code points, so an emoji or accent never leaves half a character behind.
  const before = [...t.text.slice(0, start)];
  const removed = before.pop() ?? '';
  return { next: at(before.join('') + t.text.slice(start), start - removed.length), refused: false };
}

/** LB/RB: move the caret; with `extend` (Shift), grow the selection instead. Collapses a selection first. */
export function moveCaret(t: FkText, delta: number, extend = false): EditResult {
  const len = t.text.length;
  if (extend) {
    const caret = clamp(t.caret + delta, 0, len);
    return { next: { text: t.text, caret, anchor: t.anchor }, refused: caret === t.caret };
  }
  const [start, end] = selection(t);
  if (end > start) {
    const c = delta < 0 ? start : end;
    return { next: at(t.text, c), refused: false };
  }
  const caret = clamp(t.caret + delta, 0, len);
  return { next: at(t.text, caret), refused: caret === t.caret };
}

export function selectAll(t: FkText): FkText {
  return { text: t.text, caret: t.text.length, anchor: 0 };
}

/** ± on the number pad: flips the sign wherever the caret is. */
export function toggleSign(t: FkText): FkText {
  if (t.text.startsWith('-')) return at(t.text.slice(1), Math.max(0, t.caret - 1));
  return at(`-${t.text}`, t.caret + 1);
}

/** A number field's value can only hold complete numbers: "-" or "1." are kept on the keyboard until finished. */
export function numberValue(text: string): string | null {
  if (text === '') return '';
  return /^-?(\d+(\.\d+)?|\.\d+)$/.test(text) ? text : null;
}

/** What the field itself should hold for this text (null: leave the field as it is for now). */
export function fieldValue(spec: FieldSpec, text: string): string | null {
  return spec.kind === 'number' ? numberValue(text) : text;
}

/** The masked preview of a secret: one dot per character. */
export function mask(text: string): string {
  return '•'.repeat([...text].length);
}

// ---------------------------------------------------------------- suggestions

export interface Suggestion {
  id: string;
  label: string;
  /** The text after accepting it. */
  result: FkText;
  /** A whole game title (shown with a game mark), rather than a word. */
  title?: boolean;
}

/** The word being typed just before the caret, and where it starts. */
export function fragmentAt(t: FkText): { fragment: string; start: number } {
  const before = t.text.slice(0, clamp(t.caret, 0, t.text.length));
  const m = /[\p{L}\p{N}'’-]*$/u.exec(before);
  const fragment = m ? m[0] : '';
  return { fragment, start: before.length - fragment.length };
}

/** Replaces the fragment before the caret with `word` and a space. */
export function completeWord(spec: FieldSpec, t: FkText, word: string): FkText {
  const caret = clamp(t.caret, 0, t.text.length);
  const { start } = fragmentAt({ ...t, caret, anchor: caret });
  const after = t.text.slice(caret);
  const space = after.startsWith(' ') ? '' : ' ';
  let text = t.text.slice(0, start) + word + space + after;
  if (text.length > spec.maxLength) text = text.slice(0, spec.maxLength);
  return at(text, Math.min(text.length, start + word.length + space.length));
}

// ---------------------------------------------------------------- recent words

/** Remembered words: letters only (no digits, so codes and numbers are never kept), 3–24 long. */
const WORD = /^[\p{L}][\p{L}'’-]{2,23}$/u;
export const WORD_BANK_LIMIT = 300;

export interface WordBank {
  v: 1;
  /** lower-case word → spelling as typed, uses, last use (ms). */
  words: Record<string, { w: string; n: number; t: number }>;
}

export const emptyBank = (): WordBank => ({ v: 1, words: {} });

export function parseBank(raw: string | null): WordBank {
  if (!raw || raw.length > 200_000) return emptyBank();
  try {
    const data = JSON.parse(raw) as WordBank;
    if (data?.v !== 1 || typeof data.words !== 'object' || !data.words) return emptyBank();
    const words: WordBank['words'] = {};
    for (const [k, e] of Object.entries(data.words).slice(0, WORD_BANK_LIMIT)) {
      if (e && typeof e.w === 'string' && WORD.test(e.w) && k === e.w.toLocaleLowerCase() && Number.isFinite(e.n) && Number.isFinite(e.t)) {
        words[k] = { w: e.w, n: Math.max(1, Math.min(9999, Math.floor(e.n))), t: e.t };
      }
    }
    return { v: 1, words };
  } catch {
    return emptyBank();
  }
}

export function learnWords(bank: WordBank, text: string, now: number): WordBank {
  const words = { ...bank.words };
  const seen = new Set<string>();
  for (const raw of text.split(/[^\p{L}'’-]+/u)) {
    const w = raw.replace(/^['’-]+|['’-]+$/g, '');
    if (!WORD.test(w)) continue;
    const k = w.toLocaleLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = words[k];
    words[k] = { w: hit && w === k ? hit.w : w, n: (hit?.n ?? 0) + 1, t: now };
  }
  const keys = Object.keys(words);
  if (keys.length > WORD_BANK_LIMIT) {
    keys.sort((a, b) => words[a].t - words[b].t || words[a].n - words[b].n);
    for (const k of keys.slice(0, keys.length - WORD_BANK_LIMIT)) delete words[k];
  }
  return { v: 1, words };
}

/** Completions of the word before the caret from the bank: most used first, then most recent. */
export function recentSuggestions(spec: FieldSpec, bank: WordBank, t: FkText, limit = 5): Suggestion[] {
  if (spec.predict !== 'recent' || spec.secret) return [];
  const { fragment } = fragmentAt(t);
  if (!fragment) return [];
  const f = fragment.toLocaleLowerCase();
  return Object.entries(bank.words)
    .filter(([k]) => k.length > f.length && k.startsWith(f))
    .sort(([, a], [, b]) => b.n - a.n || b.t - a.t || a.w.localeCompare(b.w))
    .slice(0, limit)
    .map(([k, e]) => {
      // Match how the user started the word: "Kin" → "Kingsfall"; "kin" → "kingsfall", unless the
      // word has capitals inside it ("PlayStation"), which are kept as remembered.
      const upper = fragment[0] !== fragment[0].toLocaleLowerCase();
      const plainCap = e.w.slice(1) === e.w.slice(1).toLocaleLowerCase();
      const word = upper ? e.w[0].toLocaleUpperCase() + e.w.slice(1) : plainCap ? k : e.w;
      return { id: `w-${k}`, label: word, result: completeWord(spec, t, word) };
    });
}

// ---------------------------------------------------------------- navigation

export type Dir = 'up' | 'down' | 'left' | 'right';

export interface FkNav {
  zone: 'keys' | 'suggest';
  row: number;
  col: number;
  /** Sticky horizontal position (grid units, key centre) for vertical moves. */
  x: number;
  /** Position in the suggestion row. */
  s: number;
}

export interface FkMove {
  nav: FkNav;
  moved: boolean;
  /** Ran into an edge (haptic bump). */
  blocked: boolean;
  zoneChanged: boolean;
}

type Grid = readonly (readonly { span: number }[])[];

export function keyStarts(row: readonly { span: number }[]): number[] {
  const out: number[] = [];
  let x = 0;
  for (const k of row) {
    out.push(x);
    x += k.span;
  }
  return out;
}

export function keyCentre(layout: Grid, row: number, col: number): number {
  return keyStarts(layout[row])[col] + layout[row][col].span / 2;
}

export function keyAt(layout: Grid, row: number, x: number): number {
  const starts = keyStarts(layout[row]);
  for (let i = starts.length - 1; i >= 0; i--) if (x >= starts[i]) return i;
  return 0;
}

/** Where focus starts: "q" on letter layouts (like a console keyboard), "1" on a number pad. */
export function startNav(layout: Grid, layer: Layer): FkNav {
  const row = layer === 'pad' ? 0 : 1;
  return { zone: 'keys', row, col: 0, x: keyCentre(layout, row, 0), s: 0 };
}

/** Finds a key by id (to keep focus on the same key when the layer or field changes). */
export function navToKey(layout: readonly (readonly FkKey[])[], id: string, fallback: FkNav): FkNav {
  for (let r = 0; r < layout.length; r++) {
    const c = layout[r].findIndex((k) => k.id === id);
    if (c >= 0) return { ...fallback, zone: 'keys', row: r, col: c, x: keyCentre(layout, r, c) };
  }
  return normalizeNav(layout, fallback, 0);
}

export function normalizeNav(layout: Grid, nav: FkNav, suggestions: number): FkNav {
  const row = clamp(nav.row, 0, layout.length - 1);
  const col = clamp(nav.col, 0, layout[row].length - 1);
  const s = clamp(nav.s, 0, suggestions - 1);
  const zone = nav.zone === 'suggest' && suggestions === 0 ? 'keys' : nav.zone;
  return { ...nav, zone, row, col, s };
}

export function moveNav(layout: Grid, nav: FkNav, dir: Dir, suggestions: number): FkMove {
  const from = normalizeNav(layout, nav, suggestions);
  const result = (n: FkNav): FkMove => ({
    nav: n,
    moved: n.zone !== from.zone || (n.zone === 'keys' ? n.row !== from.row || n.col !== from.col : n.s !== from.s),
    blocked: false,
    zoneChanged: n.zone !== from.zone,
  });
  const blocked = (): FkMove => ({ nav: from, moved: false, blocked: true, zoneChanged: false });

  if (from.zone === 'suggest') {
    switch (dir) {
      case 'left': return from.s > 0 ? result({ ...from, s: from.s - 1 }) : blocked();
      case 'right': return from.s < suggestions - 1 ? result({ ...from, s: from.s + 1 }) : blocked();
      case 'up': return blocked();
      case 'down': return result({ ...from, zone: 'keys', row: 0, col: keyAt(layout, 0, from.x) });
    }
  }

  const row = layout[from.row];
  switch (dir) {
    case 'left':
    case 'right': {
      const col = (from.col + (dir === 'left' ? -1 : 1) + row.length) % row.length;
      return result({ ...from, col, x: keyCentre(layout, from.row, col) });
    }
    case 'up':
      if (from.row > 0) return result({ ...from, row: from.row - 1, col: keyAt(layout, from.row - 1, from.x) });
      return suggestions > 0 ? result({ ...from, zone: 'suggest' }) : blocked();
    case 'down':
      if (from.row < layout.length - 1) return result({ ...from, row: from.row + 1, col: keyAt(layout, from.row + 1, from.x) });
      return blocked();
  }
}

// ---------------------------------------------------------------- spoken names

export function keyName(k: FkKey, shift: Shift): string {
  switch (k.kind) {
    case 'space': return 'Space';
    case 'backspace': return 'Backspace';
    case 'done': return 'Done';
    case 'newline': return 'New line';
    case 'shift': return shift === 'lock' ? 'Caps lock, on' : shift === 'once' ? 'Shift, on' : 'Shift';
    case 'layer': return k.target === 'letters' ? 'Letters' : k.target === 'symbols' ? 'Symbols' : 'Accents';
    case 'clear': return 'Clear';
    case 'sign': return 'Plus or minus';
    case 'text': return k.label;
    default: {
      const SPOKEN: Record<string, string> = { "'": 'Apostrophe', '.': 'Period', ',': 'Comma', '-': 'Dash', '_': 'Underscore', '/': 'Slash', '\\': 'Backslash', '@': 'At', ':': 'Colon', '"': 'Quote' };
      return SPOKEN[k.label] ?? shifted(k.label, shift);
    }
  }
}
