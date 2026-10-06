import { describe, expect, it } from 'vitest';
import {
  at, classifyField, columnsFor, completeWord, cycleShift, emptyBank, erase, fieldValue, initialLayer, insert, isTextEntryType, keyName, layoutFor,
  learnWords, mask, moveCaret, moveNav, nextLayer, normalizeNav, numberValue, parseBank, recentSuggestions, selectAll, shifted, startNav, toggleSign,
  WORD_BANK_LIMIT, type FieldSpec, type FieldTraits, type FkKey,
} from './fieldKeyboard';

const spec = (t: Partial<FieldTraits> = {}): FieldSpec => classifyField({ tag: 'input', type: 'text', ...t });
const width = (row: FkKey[]) => row.reduce((n, k) => n + k.span, 0);

describe('classifyField', () => {
  it('knows text-like inputs from everything else', () => {
    for (const t of ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']) expect(isTextEntryType('input', t)).toBe(true);
    for (const t of ['checkbox', 'radio', 'range', 'color', 'file', 'date', 'hidden', 'submit']) expect(isTextEntryType('input', t)).toBe(false);
    expect(isTextEntryType('TEXTAREA', null)).toBe(true);
    expect(isTextEntryType('select', null)).toBe(false);
  });

  it('gives number and inputmode fields a number pad', () => {
    expect(spec({ type: 'number' }).kind).toBe('number');
    expect(spec({ inputMode: 'numeric' }).kind).toBe('number');
    expect(spec({ inputMode: 'decimal' }).decimal).toBe(true);
    expect(spec({ type: 'number', step: '0.5' }).decimal).toBe(true);
    expect(spec({ type: 'number', step: '1' }).decimal).toBe(false);
    expect(spec({ type: 'number' }).negative).toBe(true);
    expect(spec({ type: 'number', min: '0' }).negative).toBe(false);
    expect(spec({ inputMode: 'numeric' }).negative).toBe(false);
    expect(spec({ type: 'tel' }).kind).toBe('tel');
  });

  it('spots email, URL and search fields', () => {
    expect(spec({ type: 'email' }).kind).toBe('email');
    expect(spec({ inputMode: 'url' }).kind).toBe('url');
    expect(spec({ type: 'search' }).kind).toBe('search');
    expect(spec({ role: 'combobox' }).kind).toBe('search');
    expect(classifyField({ tag: 'textarea', type: '' }).kind).toBe('multiline');
  });

  it('treats passwords and keys as secrets: no predictions', () => {
    for (const s of [spec({ type: 'password' }), spec({ autocomplete: 'one-time-code' }), spec({ label: 'Steam API key' }), spec({ secret: true })]) {
      expect(s.secret).toBe(true);
      expect(s.predict).toBe('none');
    }
    expect(spec({ label: 'Twitch client ID' }).secret).toBe(false);
    expect(spec({ type: 'search', label: 'Search for a token' }).secret).toBe(false);
  });

  it('chooses predictions: games only where a view asks, recent words elsewhere, none for numbers', () => {
    expect(spec({ predict: 'games' }).predict).toBe('games');
    expect(spec().predict).toBe('recent');
    expect(spec({ predict: 'none' }).predict).toBe('none');
    expect(spec({ type: 'number' }).predict).toBe('none');
    expect(spec({ type: 'email' }).predict).toBe('none');
  });

  it('respects maxLength and decides when Done presses Enter', () => {
    expect(spec({ maxLength: 60 })).toMatchObject({ maxLength: 60, limited: true });
    expect(spec({ maxLength: -1 })).toMatchObject({ maxLength: 500, limited: false });
    expect(spec().submit).toBe(true);
    expect(classifyField({ tag: 'textarea', type: '' }).submit).toBe(false); // notes: Done just closes
    expect(classifyField({ tag: 'textarea', type: '', inForm: true }).submit).toBe(true); // the AI chat box sends
    expect(spec({ submit: 'none' }).submit).toBe(false);
  });
});

describe('layouts', () => {
  it('every letter layer is a full 10-column grid with the same shape', () => {
    for (const kind of [{}, { type: 'email' }, { type: 'url' }] as Partial<FieldTraits>[]) {
      const s = spec(kind);
      for (const layer of ['letters', 'symbols', 'accents'] as const) {
        const rows = layoutFor(s, layer);
        expect(rows).toHaveLength(5);
        for (const row of rows) expect(width(row)).toBe(10);
        expect(new Set(rows.flat().map((k) => k.id)).size).toBe(rows.flat().length);
      }
    }
    const multi = classifyField({ tag: 'textarea', type: '' });
    expect(layoutFor(multi, 'letters')[4].some((k) => k.kind === 'newline')).toBe(true);
  });

  it('email and URL layouts carry @, .com and /', () => {
    const email = layoutFor(spec({ type: 'email' }), 'letters').flat().map((k) => k.value);
    expect(email).toEqual(expect.arrayContaining(['@', '.com', '.']));
    const url = layoutFor(spec({ type: 'url' }), 'letters').flat().map((k) => k.value);
    expect(url).toEqual(expect.arrayContaining(['/', '.com', ':']));
  });

  it('layers cycle letters → symbols → accents → letters', () => {
    expect(nextLayer('letters')).toBe('symbols');
    expect(nextLayer('symbols')).toBe('accents');
    expect(nextLayer('accents')).toBe('letters');
    expect(layoutFor(spec(), 'letters')[4][0]).toMatchObject({ kind: 'layer', target: 'symbols' });
  });

  it('number pads are 3 wide with only the keys the field accepts', () => {
    const int = spec({ type: 'number', min: '0' });
    expect(initialLayer(int)).toBe('pad');
    expect(columnsFor(int)).toBe(3);
    const rows = layoutFor(int, 'pad');
    for (const row of rows) expect(width(row)).toBe(3);
    const values = rows.flat().map((k) => k.value ?? k.kind);
    expect(values).not.toContain('.');
    expect(values).not.toContain('sign');
    const dec = layoutFor(spec({ type: 'number', step: 'any' }), 'pad').flat().map((k) => k.value ?? k.kind);
    expect(dec).toEqual(expect.arrayContaining(['.', 'sign']));
    for (const row of layoutFor(spec({ type: 'tel' }), 'pad')) expect(width(row)).toBe(3);
  });
});

describe('editing', () => {
  const s = spec({ maxLength: 5 });

  it('inserts at the caret and refuses past maxLength', () => {
    let t = at('ab', 1);
    t = insert(s, t, 'X').next;
    expect(t).toEqual({ text: 'aXb', caret: 2, anchor: 2 });
    const full = insert(s, at('abcd'), 'xyz');
    expect(full.next.text).toBe('abcdx');
    expect(full.refused).toBe(true);
    expect(insert(s, at('abcde'), 'q')).toMatchObject({ refused: true, next: { text: 'abcde' } });
  });

  it('typing replaces a selection; backspace deletes it', () => {
    const sel = selectAll(at('hello'));
    expect(insert(s, sel, 'y').next).toEqual(at('y'));
    expect(erase(sel).next).toEqual(at(''));
    expect(erase(at('ab', 0)).refused).toBe(true);
    expect(erase(at('a😀')).next.text).toBe('a'); // whole emoji, not half a surrogate pair
  });

  it('moves and extends the caret within bounds', () => {
    expect(moveCaret(at('abc'), 1).refused).toBe(true);
    expect(moveCaret(at('abc'), -1).next.caret).toBe(2);
    const ext = moveCaret(at('abc'), -2, true).next;
    expect(ext).toEqual({ text: 'abc', caret: 1, anchor: 3 });
    expect(moveCaret(ext, 1).next).toEqual(at('abc', 3)); // collapses to the selection's end
  });

  it('fields only take characters they accept', () => {
    expect(insert(spec({ type: 'email' }), at(''), 'a b').next.text).toBe('ab');
    expect(insert(spec(), at(''), 'a\nb').next.text).toBe('ab');
    expect(insert(classifyField({ tag: 'textarea', type: '' }), at('a'), '\n').next.text).toBe('a\n');
    const num = spec({ type: 'number' });
    expect(insert(num, at('12'), 'a').refused).toBe(true);
    expect(insert(num, at('12', 1), '-').next.text).toBe('12'); // minus only at the start
    expect(insert(num, at('12', 0), '-').next.text).toBe('-12');
    expect(insert(spec({ type: 'number', step: 'any' }), at('1.5'), '.').next.text).toBe('1.5');
  });

  it('number fields only receive complete numbers', () => {
    expect(numberValue('')).toBe('');
    expect(numberValue('-')).toBeNull();
    expect(numberValue('1.')).toBeNull();
    expect(numberValue('-1.25')).toBe('-1.25');
    expect(fieldValue(spec({ type: 'number' }), '1.')).toBeNull();
    expect(fieldValue(spec(), '1.')).toBe('1.');
    expect(toggleSign(at('12'))).toEqual(at('-12', 3));
    expect(toggleSign(at('-12'))).toEqual(at('12', 2));
  });

  it('shift: once, caps lock, off — and only letters change', () => {
    expect(cycleShift('off')).toBe('once');
    expect(cycleShift('once')).toBe('lock');
    expect(cycleShift('lock')).toBe('off');
    expect(shifted('é', 'once')).toBe('É');
    expect(shifted('ß', 'lock')).toBe('ß');
    expect(shifted('1', 'lock')).toBe('1');
    expect(shifted('a', 'off')).toBe('a');
  });

  it('masks secrets one dot per character', () => {
    expect(mask('pa😀')).toBe('•••');
  });
});

describe('recent words', () => {
  const text = spec();

  it('learns letter-only words, never numbers or codes, and suggests completions', () => {
    let bank = learnWords(emptyBank(), 'Backlog weekend backlog 1234 ab x9y2', 1);
    expect(Object.keys(bank.words).sort()).toEqual(['backlog', 'weekend']);
    bank = learnWords(bank, 'my backlog', 2);
    bank = learnWords(bank, 'Backyard', 3);
    const sug = recentSuggestions(text, bank, at('my bac'));
    expect(sug.map((s) => s.label)).toEqual(['backlog', 'backyard']); // used twice beats newer
    expect(sug[0].result).toEqual(at('my backlog '));
    expect(recentSuggestions(text, bank, at('Bac'))[0].label).toBe('Backlog'); // follows the capital
    bank = learnWords(bank, 'PlayStation', 4);
    expect(recentSuggestions(text, bank, at('pla'))[0].label).toBe('PlayStation'); // inner capitals kept
    expect(recentSuggestions(spec({ type: 'password' }), bank, at('bac'))).toEqual([]);
    expect(recentSuggestions(text, bank, at('bac '))).toEqual([]);
  });

  it('caps the bank and survives junk in storage', () => {
    let bank = emptyBank();
    for (let i = 0; i < WORD_BANK_LIMIT + 20; i++) bank = learnWords(bank, `word${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, i);
    expect(Object.keys(bank.words).length).toBe(WORD_BANK_LIMIT);
    expect(parseBank('{nope')).toEqual(emptyBank());
    expect(parseBank(JSON.stringify({ v: 1, words: { x: { w: 'Hello', n: 1, t: 1 } } })).words).toEqual({});
    expect(parseBank(JSON.stringify(bank)).words).toEqual(bank.words);
  });

  it('completing a word keeps the text after the caret', () => {
    expect(completeWord(text, at('ki rest', 2), 'Kingsfall')).toEqual(at('Kingsfall rest', 9));
  });
});

describe('navigation', () => {
  const layout = layoutFor(spec(), 'letters');

  it('starts on q, wraps rows and keeps a sticky column', () => {
    let nav = startNav(layout, 'letters');
    expect(layout[nav.row][nav.col].label).toBe('q');
    nav = moveNav(layout, nav, 'left', 0).nav;
    expect(layout[nav.row][nav.col].label).toBe('p'); // wrapped
    nav = moveNav(layout, nav, 'down', 0).nav;
    nav = moveNav(layout, nav, 'down', 0).nav;
    nav = moveNav(layout, nav, 'down', 0).nav;
    expect(layout[nav.row][nav.col].kind).toBe('done');
    expect(moveNav(layout, nav, 'down', 0).blocked).toBe(true);
    nav = moveNav(layout, nav, 'up', 0).nav;
    expect(layout[nav.row][nav.col].label).toBe('.'); // back up the same column
  });

  it('reaches the suggestion row from the top and returns to the keys', () => {
    let nav = startNav(layout, 'letters');
    nav = moveNav(layout, nav, 'up', 0).nav;
    expect(moveNav(layout, nav, 'up', 0).blocked).toBe(true);
    const into = moveNav(layout, nav, 'up', 3);
    expect(into).toMatchObject({ zoneChanged: true, nav: { zone: 'suggest' } });
    expect(moveNav(layout, into.nav, 'left', 3).blocked).toBe(true);
    expect(moveNav(layout, into.nav, 'down', 3).nav.zone).toBe('keys');
    expect(normalizeNav(layout, into.nav, 0).zone).toBe('keys'); // suggestions vanished
  });

  it('number pads start on 1', () => {
    const pad = layoutFor(spec({ type: 'number' }), 'pad');
    const nav = startNav(pad, 'pad');
    expect(pad[nav.row][nav.col].label).toBe('1');
  });

  it('names keys for screen readers', () => {
    const shift = layout[3][0];
    expect(keyName(shift, 'lock')).toBe('Caps lock, on');
    expect(keyName(layout[2][9], 'off')).toBe('Apostrophe');
    expect(keyName(layout[1][0], 'once')).toBe('Q');
  });
});
