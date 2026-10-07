import { describe, expect, it } from 'vitest';
import type { DiscoverResult, DiscoverSearch } from '../bridge/types';
import {
  activeFilterCount, applyFilters, cleanQuery, decadeOf, filterOptions, formatStorePrice, highlightParts, hoursLabel, isNewer, NO_FILTERS,
  noteText, platformGroup, progressOf, sourceLine, splitByLibrary,
} from './discover';

const r = (over: Partial<DiscoverResult>): DiscoverResult => ({
  key: 'steam-1', title: 'Game', year: 2020, stores: ['steam'], platforms: ['PC'], genres: [], sources: ['steam'], steamAppId: '1',
  libraryGameId: null, price: null, hasCover: true, cover: null, score: 50, kind: 'game', ...over,
});

const hits = (title: string, q: string) => highlightParts(title, q).filter((p) => p.hit).map((p) => p.text);

describe('cleanQuery', () => {
  it('trims, collapses spaces and needs two characters', () => {
    expect(cleanQuery('  portal   2 ')).toBe('portal 2');
    expect(cleanQuery('p')).toBeNull();
    expect(cleanQuery('po\u0000rtal')).toBe('portal');
    expect(cleanQuery('x'.repeat(101))).toBeNull();
  });
});

describe('highlightParts', () => {
  it('marks the whole text, preferring a word start', () => {
    expect(hits('Bridge Constructor Portal', 'portal')).toEqual(['Portal']);
    expect(hits('Teleportal Portal', 'portal')).toEqual(['Portal']);
  });
  it('ignores case and accents and keeps the original letters', () => {
    expect(hits('Pokémon Legends', 'pokemon')).toEqual(['Pokémon']);
  });
  it('marks each word when the words are apart', () => {
    expect(hits('The Witcher 3: Wild Hunt', 'witcher hunt')).toEqual(['Witcher', 'Hunt']);
  });
  it('falls back to in-order letters', () => {
    expect(hits('Red Dead Redemption', 'rdr').join('')).toBe('RdR');
  });
  it('round-trips the title exactly', () => {
    for (const [t, q] of [['Hollow Knight: Silksong', 'silk'], ['DOOM', 'zz'], ['Ōkami HD', 'okami']]) {
      expect(highlightParts(t, q).map((p) => p.text).join('')).toBe(t);
    }
  });
  it('marks nothing for an empty query', () => {
    expect(highlightParts('Portal', '  ')).toEqual([{ text: 'Portal', hit: false }]);
  });
});

describe('filters', () => {
  const now = new Date('2026-10-07');
  const list = [
    r({ key: 'a', stores: ['steam'], platforms: ['PC', 'PlayStation 5'], year: 2024, genres: ['RPG'] }),
    r({ key: 'b', stores: ['gog'], platforms: ['PC'], year: 2009, genres: ['Strategy', 'RPG'] }),
    r({ key: 'c', stores: ['epic'], platforms: ['Nintendo Switch'], year: 2027, genres: ['Platformer'] }),
    r({ key: 'd', stores: ['steam'], platforms: ['PC'], year: null, kind: 'extra' }),
  ];
  it('narrows by store, platform, decade and genre, and hides extras', () => {
    expect(applyFilters(list, NO_FILTERS, now).map((x) => x.key)).toEqual(['a', 'b', 'c']);
    expect(applyFilters(list, { ...NO_FILTERS, gamesOnly: false }, now)).toHaveLength(4);
    expect(applyFilters(list, { ...NO_FILTERS, store: 'steam' }, now).map((x) => x.key)).toEqual(['a']);
    expect(applyFilters(list, { ...NO_FILTERS, platform: 'playstation' }, now).map((x) => x.key)).toEqual(['a']);
    expect(applyFilters(list, { ...NO_FILTERS, decade: 'upcoming' }, now).map((x) => x.key)).toEqual(['c']);
    expect(applyFilters(list, { ...NO_FILTERS, genre: 'rpg' }, now).map((x) => x.key)).toEqual(['a', 'b']);
    expect(activeFilterCount({ ...NO_FILTERS, store: 'gog', genre: 'RPG' })).toBe(2);
  });
  it('offers only choices some result has, genres by frequency', () => {
    const o = filterOptions(list, now);
    expect(o.stores).toEqual(['steam', 'gog', 'epic']);
    expect(o.platforms).toEqual(['pc', 'playstation', 'nintendo']);
    expect(o.decades).toEqual(['upcoming', '2020s', '2000s']);
    expect(o.genres[0]).toBe('RPG');
  });
  it('groups platform names', () => {
    expect(platformGroup('PC (Microsoft Windows)')).toBe('pc');
    expect(platformGroup('PS4')).toBe('playstation');
    expect(platformGroup('Xbox Series X|S')).toBe('xbox');
    expect(platformGroup('Nintendo Switch 2')).toBe('nintendo');
    expect(platformGroup('Atari 2600')).toBeNull();
    expect(decadeOf(1998, now)).toBe('older');
    expect(decadeOf(null, now)).toBeNull();
  });
});

describe('splitByLibrary', () => {
  it('puts library games first and never shows one twice', () => {
    const list = [r({ key: 'x', libraryGameId: 'g1' }), r({ key: 'y', libraryGameId: 'g2' }), r({ key: 'z' })];
    const { owned, rest } = splitByLibrary(list, new Set(['g1']));
    expect(owned.map((x) => x.key)).toEqual(['y']);
    expect(rest.map((x) => x.key)).toEqual(['z']);
  });
});

describe('prices', () => {
  it('formats a discounted price and a free one', () => {
    const p = formatStorePrice({ finalCents: 199, initialCents: 999, currency: 'USD' }, 'en-US')!;
    expect(p).toEqual({ now: '$1.99', was: '$9.99', cut: 80 });
    expect(formatStorePrice({ finalCents: 0, initialCents: 0, currency: 'EUR' }, 'en-US')!.now).toBe('Free');
    expect(formatStorePrice({ finalCents: 100, initialCents: 100, currency: 'usd' })).toBeNull();
    expect(formatStorePrice(null)).toBeNull();
  });
});

describe('source states', () => {
  const s = (state: 'pending' | 'done' | 'failed' | 'skipped', reason: string | null = null, count = 0) => ({ id: 'igdb' as const, name: 'IGDB', state, reason, count, hasMore: false });
  it('says where each source stands', () => {
    expect(sourceLine(s('pending'))).toBe('Asking IGDB…');
    expect(sourceLine(s('done', null, 3))).toBe('IGDB: 3 matches');
    expect(sourceLine(s('done', null, 0))).toBe('IGDB: nothing found');
    expect(sourceLine(s('skipped', 'noKey'))).toBe('IGDB: not connected');
    expect(sourceLine(s('failed', 'rateLimited'))).toBe('IGDB: asked VYSTRAL to slow down');
  });
  const search = (id: string, page: number, states: ('pending' | 'done' | 'skipped')[]): DiscoverSearch => ({
    searchId: id, channel: 'page', query: 'q', page, results: [], done: !states.includes('pending'), hasMore: false, reason: null,
    sources: states.map((st) => s(st)),
  });
  it('only lets a newer or further-along snapshot replace the current one', () => {
    const a = search('s1', 0, ['pending', 'pending', 'skipped']);
    const b = search('s1', 0, ['done', 'pending', 'skipped']);
    expect(progressOf(b)).toEqual({ pending: 1, asked: 2, answered: 1 });
    expect(isNewer(a, b)).toBe(true);
    expect(isNewer(b, a)).toBe(false); // a late initial reply never overwrites streamed results
    expect(isNewer(b, search('s2', 0, ['pending', 'pending', 'skipped']))).toBe(true);
    expect(isNewer(search('s3', 0, ['done']), search('s2', 0, ['done']))).toBe(false);
    expect(isNewer(null, a)).toBe(true);
  });
});

describe('notes and durations', () => {
  it('explains how to connect sources', () => {
    expect(noteText('igdb:noKey')).toMatch(/Connect IGDB/);
    expect(noteText('rawg:unavailable')).toMatch(/RAWG couldn’t be reached/);
    expect(noteText('steam:whatever')).toBeNull();
  });
  it('rounds hours sensibly', () => {
    expect(hoursLabel(1800)).toBe('30 min');
    expect(hoursLabel(3.4 * 3600)).toBe('3.5 h');
    expect(hoursLabel(42.6 * 3600)).toBe('43 h');
    expect(hoursLabel(null)).toBeNull();
  });
});
