import { describe, expect, it } from 'vitest';
import type { Game, Installation } from '../bridge/types';
import { EMPTY_SELECTION, between, extend, inOrder, prune, selectAll, selectRange, storeInstallation, summarize, toggle } from './selection';

const ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const ids = (s: { ids: ReadonlySet<string> }) => [...s.ids].sort();

function inst(over: Partial<Installation> = {}): Installation {
  return {
    id: Math.random().toString(16).slice(2), platform: 'steam', platformGameId: '1', title: 't', state: 'installed', installPath: null,
    drive: null, sizeBytes: null, clientRequired: true, launchKind: 'Uri', importedLastPlayed: null, importedPlaytimeMinutes: 0,
    userLaunchArgs: null, manualLink: false, lastSeen: '2026-10-01T00:00:00Z', ...over,
  };
}
function game(id: string, over: Partial<Game> = {}, installs: Installation[] = [inst()]): Game {
  return {
    id, title: id, sortTitle: id, description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: installs, collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01T00:00:00Z', ...over,
  } as Game;
}

describe('selection model', () => {
  it('toggles one game at a time and anchors on it', () => {
    let s = toggle(EMPTY_SELECTION, 'c');
    expect(ids(s)).toEqual(['c']);
    expect(s.anchor).toBe('c');
    s = toggle(s, 'e');
    expect(ids(s)).toEqual(['c', 'e']);
    s = toggle(s, 'c');
    expect(ids(s)).toEqual(['e']);
    expect(s.anchor).toBe('c');
  });

  it('shift-click selects the range from the anchor on top of the earlier selection, in either direction', () => {
    let s = toggle(EMPTY_SELECTION, 'a');
    s = toggle(s, 'd');
    s = selectRange(s, ORDER, 'f');
    expect(ids(s)).toEqual(['a', 'd', 'e', 'f']);
    // A second shift-click re-draws the range from the same anchor (it doesn't accumulate).
    s = selectRange(s, ORDER, 'b');
    expect(ids(s)).toEqual(['a', 'b', 'c', 'd']);
    expect(between(ORDER, 'f', 'd')).toEqual(['d', 'e', 'f']);
    expect(between(ORDER, 'x', 'd')).toEqual([]);
  });

  it('shift-click without an anchor just toggles', () => {
    const s = selectRange(EMPTY_SELECTION, ORDER, 'c');
    expect(ids(s)).toEqual(['c']);
  });

  it('shift+arrows extend from the anchor and shrink again when moving back', () => {
    // A 4-column grid: down is +4.
    let r = extend(EMPTY_SELECTION, ORDER, 'b', 1);
    expect(r.focus).toBe('c');
    expect(ids(r.selection)).toEqual(['b', 'c']);
    r = extend(r.selection, ORDER, 'c', 4);
    expect(r.focus).toBe('g');
    expect(ids(r.selection)).toEqual(['b', 'c', 'd', 'e', 'f', 'g']);
    r = extend(r.selection, ORDER, 'g', -4);
    expect(ids(r.selection)).toEqual(['b', 'c']);
    // Clamped at the ends.
    r = extend(r.selection, ORDER, 'c', -10);
    expect(r.focus).toBe('a');
    expect(ids(r.selection)).toEqual(['a', 'b']);
  });

  it('extending keeps games selected before the range started', () => {
    const s = toggle(toggle(EMPTY_SELECTION, 'a'), 'g'); // anchor g
    const r = extend(s, ORDER, 'g', -2);
    expect(ids(r.selection)).toEqual(['a', 'e', 'f', 'g']);
  });

  it('select all takes everything shown; prune drops what the filter hides', () => {
    let s = selectAll(ORDER);
    expect(s.ids.size).toBe(8);
    s = prune(s, ['b', 'c', 'z']);
    expect(ids(s)).toEqual(['b', 'c']);
    const same = prune(s, ['a', 'b', 'c']);
    expect(same).toBe(s); // nothing to drop: same object, no re-render
    const t = prune(toggle(EMPTY_SELECTION, 'q'), ORDER);
    expect(t.anchor).toBeNull();
    expect(inOrder(selectAll(['c', 'a', 'b']), ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });
});

describe('selection summary', () => {
  it('labels the toggles from what every selected game has in common', () => {
    const s = summarize([game('a', { favorite: true, status: 'beaten' }), game('b', { favorite: true, status: 'beaten', hidden: true })]);
    expect(s).toMatchObject({ count: 2, allFavorite: true, allHidden: false, status: 'beaten', withStore: 2 });
    expect(summarize([game('a', { status: 'beaten' }), game('b')]).status).toBe('mixed');
    expect(summarize([game('a'), game('b')]).status).toBeNull();
    expect(summarize([]).allFavorite).toBe(false);
  });

  it('uses the user’s own hidden flag for games Steam no longer lists', () => {
    const refunded = game('r', { hidden: true, notOwned: true, userHidden: false });
    expect(summarize([refunded]).allHidden).toBe(false);
    expect(summarize([{ ...refunded, userHidden: true }]).allHidden).toBe(true);
  });

  it('opens the preferred store copy, never a game you added yourself', () => {
    const a = inst({ id: 'steam1' });
    const b = inst({ id: 'epic1', platform: 'epic' });
    expect(storeInstallation(game('x', { preferredInstallationId: 'epic1' }, [a, b]))).toBe('epic1');
    expect(storeInstallation(game('x', {}, [inst({ id: 'm', platform: 'manual' }), b]))).toBe('epic1');
    expect(storeInstallation(game('x', {}, [inst({ id: 'm', platform: 'manual' })]))).toBeNull();
    expect(summarize([game('x', {}, [inst({ platform: 'manual' })])]).withStore).toBe(0);
  });
});
