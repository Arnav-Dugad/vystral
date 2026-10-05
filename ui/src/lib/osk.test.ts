import { describe, expect, it } from 'vitest';
import {
  backspace, initialNav, insertText, keyAt, keyCentre, moveCaret, moveNav, normalizeNav, OSK_COLUMNS, OSK_LAYOUTS, OSK_MAX_LENGTH,
  type OskNav,
} from './osk';

const L = OSK_LAYOUTS.letters;
const none = { games: 0, words: 0 };
const both = { games: 5, words: 3 };

function keyLabel(nav: OskNav) {
  return L[nav.row][nav.col].label;
}

describe('layouts', () => {
  it('every row spans exactly the grid and both layouts share a shape', () => {
    for (const layout of Object.values(OSK_LAYOUTS)) {
      for (const row of layout) expect(row.reduce((n, k) => n + k.span, 0)).toBe(OSK_COLUMNS);
      expect(layout.map((r) => r.length)).toEqual(L.map((r) => r.length));
    }
  });

  it('key ids are unique within a layout', () => {
    for (const layout of Object.values(OSK_LAYOUTS)) {
      const ids = layout.flat().map((k) => k.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('has letters, digits, space, backspace, clear and done', () => {
    const kinds = new Set(L.flat().map((k) => k.kind));
    expect([...kinds].sort()).toEqual(['backspace', 'char', 'clear', 'done', 'layout', 'space']);
    const values = L.flat().map((k) => k.value).join('');
    for (const c of 'abcdefghijklmnopqrstuvwxyz0123456789') expect(values).toContain(c);
  });
});

describe('moveNav', () => {
  it('starts on q', () => {
    expect(keyLabel(initialNav(L))).toBe('q');
  });

  it('wraps horizontally within a row', () => {
    const start = initialNav(L);
    const r = moveNav(L, start, 'left', none);
    expect(keyLabel(r.nav)).toBe('p');
    expect(r.wrapped).toBe(true);
    expect(r.blocked).toBe(false);
    expect(keyLabel(moveNav(L, r.nav, 'right', none).nav)).toBe('q');
  });

  it('keeps a sticky column through wide keys', () => {
    // From "c" (col 2 of the z row) down onto Space (span 4) and back up to "c".
    let nav: OskNav = { ...initialNav(L), row: 3, col: 2, x: keyCentre(L, 3, 2) };
    nav = moveNav(L, nav, 'down', none).nav;
    expect(L[nav.row][nav.col].kind).toBe('space');
    nav = moveNav(L, nav, 'up', none).nav;
    expect(keyLabel(nav)).toBe('c');
  });

  it('is blocked at the bottom row and at the top without predictions', () => {
    const bottom: OskNav = { ...initialNav(L), row: 4, col: 0, x: 1 };
    expect(moveNav(L, bottom, 'down', none)).toMatchObject({ blocked: true, moved: false });
    const top: OskNav = { ...initialNav(L), row: 0, col: 3, x: 3.5 };
    expect(moveNav(L, top, 'up', none)).toMatchObject({ blocked: true, moved: false });
  });

  it('moves up from the keys into word predictions, then games, and back down to the same column', () => {
    const top: OskNav = { ...initialNav(L), row: 0, col: 6, x: keyCentre(L, 0, 6) };
    const words = moveNav(L, top, 'up', both);
    expect(words.nav.zone).toBe('words');
    expect(words.zoneChanged).toBe(true);
    const games = moveNav(L, words.nav, 'up', both);
    expect(games.nav.zone).toBe('games');
    expect(moveNav(L, games.nav, 'up', both).blocked).toBe(true);
    const back = moveNav(L, moveNav(L, games.nav, 'down', both).nav, 'down', both).nav;
    expect(back.zone).toBe('keys');
    expect(L[back.row][back.col].label).toBe('7');
  });

  it('skips an empty word zone', () => {
    const top: OskNav = { ...initialNav(L), row: 0, col: 0, x: 0.5 };
    expect(moveNav(L, top, 'up', { games: 2, words: 0 }).nav.zone).toBe('games');
    const fromGames = moveNav(L, { ...top, zone: 'games' }, 'down', { games: 2, words: 0 }).nav;
    expect(fromGames.zone).toBe('keys');
  });

  it('prediction rows do not wrap', () => {
    const g: OskNav = { ...initialNav(L), zone: 'games', game: 0 };
    expect(moveNav(L, g, 'left', both).blocked).toBe(true);
    const last = { ...g, game: 4 };
    expect(moveNav(L, last, 'right', both).blocked).toBe(true);
    expect(moveNav(L, g, 'right', both).nav.game).toBe(1);
  });

  it('normalizes when predictions disappear', () => {
    const inGames: OskNav = { ...initialNav(L), zone: 'games', game: 6 };
    expect(normalizeNav(L, inGames, { games: 3, words: 0 }).game).toBe(2);
    expect(normalizeNav(L, inGames, { games: 0, words: 2 }).zone).toBe('words');
    expect(normalizeNav(L, inGames, none).zone).toBe('keys');
  });

  it('keyAt maps positions onto spanning keys', () => {
    expect(L[4][keyAt(L, 4, 0.2)].kind).toBe('layout');
    expect(L[4][keyAt(L, 4, 5.9)].kind).toBe('space');
    expect(L[4][keyAt(L, 4, 9.5)].kind).toBe('done');
  });
});

describe('text editing', () => {
  it('inserts at the caret and moves it', () => {
    expect(insertText({ text: 'ashn', caret: 3 }, 'e')).toEqual({ text: 'ashen', caret: 4 });
  });

  it('never inserts a leading or double space', () => {
    expect(insertText({ text: '', caret: 0 }, ' ')).toEqual({ text: '', caret: 0 });
    expect(insertText({ text: 'a ', caret: 2 }, ' ')).toEqual({ text: 'a ', caret: 2 });
  });

  it('caps the length', () => {
    const full = { text: 'x'.repeat(OSK_MAX_LENGTH), caret: OSK_MAX_LENGTH };
    expect(insertText(full, 'y')).toEqual(full);
  });

  it('backspace and caret moves stay in range', () => {
    expect(backspace({ text: 'abc', caret: 0 })).toEqual({ text: 'abc', caret: 0 });
    expect(backspace({ text: 'abc', caret: 2 })).toEqual({ text: 'ac', caret: 1 });
    expect(moveCaret({ text: 'abc', caret: 3 }, 1).caret).toBe(3);
    expect(moveCaret({ text: 'abc', caret: 0 }, -1).caret).toBe(0);
  });
});
