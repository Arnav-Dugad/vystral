import { describe, expect, it } from 'vitest';
import type { Game } from '../bridge/types';
import { bulkBody, bulkParams, bulkPatch, bulkTitle, nothingToChange, planBulk, snapshotOf, userHiddenOf } from './bulk';

const NOW = '2026-10-10T12:00:00.000Z';

function game(id: string, over: Partial<Game> = {}): Game {
  return {
    id, title: id, sortTitle: id, description: null, developer: null, publisher: null, releaseDate: null, genres: [],
    favorite: false, hidden: false, userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [], collections: [], trackedSeconds: 0,
    sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01T00:00:00Z', ...over,
  } as Game;
}

describe('bulk patches', () => {
  it('only changes games that aren’t already that way', () => {
    expect(bulkPatch(game('a', { status: 'beaten' }), { kind: 'status', status: 'beaten' }, NOW)).toBeNull();
    expect(bulkPatch(game('a'), { kind: 'status', status: 'beaten' }, NOW)).toEqual({ status: 'beaten', statusChangedAt: NOW });
    expect(bulkPatch(game('a'), { kind: 'status', status: null }, NOW)).toBeNull();
    expect(bulkPatch(game('a', { favorite: true }), { kind: 'favorite', value: true }, NOW)).toBeNull();
    expect(bulkPatch(game('a'), { kind: 'played', value: true }, NOW)).toEqual({ playedMarkedAt: NOW });
    expect(bulkPatch(game('a', { playedMarkedAt: NOW }), { kind: 'played', value: false }, NOW)).toEqual({ playedMarkedAt: null });
    expect(bulkPatch(game('a', { collections: ['c1'] }), { kind: 'collection', collectionId: 'c1', value: true }, NOW)).toBeNull();
    expect(bulkPatch(game('a', { collections: ['c1', 'c2'] }), { kind: 'collection', collectionId: 'c1', value: false }, NOW)).toEqual({ collections: ['c2'] });
  });

  it('keeps games Steam no longer lists out of view when unhiding them', () => {
    const refunded = game('r', { hidden: true, notOwned: true, userHidden: true });
    expect(userHiddenOf(refunded)).toBe(true);
    expect(bulkPatch(refunded, { kind: 'hidden', value: false }, NOW)).toEqual({ userHidden: false, hidden: true });
    expect(bulkPatch(game('a'), { kind: 'hidden', value: true }, NOW)).toEqual({ userHidden: true, hidden: true });
  });

  it('plans the change and remembers exactly what each game was, for a revert', () => {
    const a = game('a', { status: 'playing', statusChangedAt: '2026-02-02T00:00:00Z' });
    const b = game('b');
    const c = game('c', { status: 'beaten' });
    const plan = planBulk([a, b, c], { kind: 'status', status: 'beaten' }, NOW);
    expect([...plan.patches.keys()]).toEqual(['a', 'b']);
    expect(plan.before.get('a')).toEqual({ status: 'playing', statusChangedAt: '2026-02-02T00:00:00Z' });
    expect(plan.before.get('b')).toEqual({ status: null, statusChangedAt: null });
    // Applying the plan and then its "before" is a no-op.
    const after = { ...a, ...plan.patches.get('a') };
    expect({ ...after, ...plan.before.get('a') }).toEqual(a);
    expect(snapshotOf(game('h', { hidden: true }), { hidden: false, userHidden: false })).toEqual({ hidden: true, userHidden: true });
  });

  it('sends the right bridge parameters for each action', () => {
    expect(bulkParams(['a'], { kind: 'status', status: null })).toEqual({ gameIds: ['a'], action: 'status', status: null });
    expect(bulkParams(['a'], { kind: 'hidden', value: true })).toEqual({ gameIds: ['a'], action: 'hidden', value: true });
    expect(bulkParams(['a'], { kind: 'collection', collectionId: 'c', value: false })).toEqual({ gameIds: ['a'], action: 'collection', value: false, collectionId: 'c' });
  });
});

describe('bulk words', () => {
  it('says what happened in plain words', () => {
    expect(bulkTitle({ kind: 'status', status: 'beaten' }, 12)).toBe('12 games marked Beaten');
    expect(bulkTitle({ kind: 'status', status: null }, 1)).toBe('Status cleared for one game');
    expect(bulkTitle({ kind: 'favorite', value: true }, 1)).toBe('One game added to favorites');
    expect(bulkTitle({ kind: 'hidden', value: false }, 3)).toBe('3 games back in your library');
    expect(bulkTitle({ kind: 'collection', collectionId: 'c', value: true }, 5, 'Couch co-op')).toBe('Added 5 games to Couch co-op');
    expect(bulkTitle({ kind: 'played', value: true }, 2)).toBe('2 games marked as played');
  });

  it('mentions games that were already that way, and where hidden games went', () => {
    expect(bulkBody({ kind: 'favorite', value: true }, 3, 3)).toBeUndefined();
    expect(bulkBody({ kind: 'favorite', value: true }, 3, 4)).toBe('One was already that way.');
    expect(bulkBody({ kind: 'hidden', value: true }, 2, 5)).toBe('3 were already that way. Find them with the “Hidden” filter.');
    expect(nothingToChange({ kind: 'status', status: 'playing' })).toBe('They’re all Playing already.');
  });
});
