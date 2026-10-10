import { describe, expect, it } from 'vitest';
import type { DiscoverResult, DiscoverShelf, WishlistItem } from '../bridge/types';
import {
  baseTitle, becauseLine, cardPrice, DISCOVER_GENRES, genreById, groupEditions, heroPicks, releaseLabel, titleKey, wishlistOnSale,
} from './discover';

// Track C3: Discover 2.0's pure helpers.

const r = (over: Partial<DiscoverResult>): DiscoverResult => ({
  key: `steam-${over.title?.length ?? 1}`, title: 'Game', year: 2020, stores: ['steam'], platforms: ['PC'], genres: [], sources: ['steam'],
  steamAppId: '1', libraryGameId: null, price: null, hasCover: true, cover: null, score: 50, kind: 'game', ...over,
});

const shelf = (id: string, items: DiscoverResult[], over: Partial<DiscoverShelf> = {}): DiscoverShelf => ({
  id, kind: id.startsWith('because:') ? 'because' : 'store', title: id, reason: null, source: 'steam', seed: null, items, ...over,
});

describe('editions and add-ons', () => {
  it('finds the base title behind edition words', () => {
    expect(baseTitle('Forza Horizon 5: Premium Edition')).toBe('Forza Horizon 5');
    expect(baseTitle('The Witcher 3: Wild Hunt - Game of the Year Edition')).toBe('The Witcher 3: Wild Hunt');
    expect(baseTitle('Cyberpunk 2077 Ultimate Edition')).toBe('Cyberpunk 2077');
    expect(baseTitle('Death Stranding Director’s Cut')).toBe('Death Stranding');
    expect(baseTitle('Hades (GOTY)')).toBe('Hades');
    expect(baseTitle('Edition')).toBe('Edition'); // nothing would be left
    expect(baseTitle('Portal 2')).toBe('Portal 2');
    expect(titleKey('STAR WARS™: Galactic Racer')).toBe('star wars galactic racer');
  });

  it('folds editions and add-ons under their game, keeping order and dropping nothing', () => {
    const list = [
      r({ key: 'a', title: 'Forza Horizon 5: Premium Edition' }),
      r({ key: 'b', title: 'Forza Horizon 5' }),
      r({ key: 'c', title: 'Forza Horizon 4' }),
      r({ key: 'd', title: 'Forza Horizon 5: Rally Adventure', kind: 'extra' }),
      r({ key: 'e', title: 'Forza Horizon 4 Ultimate Edition' }),
      r({ key: 'f', title: 'Forza Motorsport Soundtrack', kind: 'extra' }), // no base game here
      r({ key: 'g', title: 'Forza Horizon 50' }), // a different game, not an add-on of "Forza Horizon 5"
    ];
    const groups = groupEditions(list);
    expect(groups.map((g) => [g.base.key, g.children.map((c) => c.key)])).toEqual([
      ['b', ['a', 'd']], // sits where its best-ranked member was
      ['c', ['e']],
      ['f', []],
      ['g', []],
    ]);
    expect(groups.flatMap((g) => [g.base, ...g.children])).toHaveLength(list.length);
  });

  it('never makes an extra a parent, and leaves lone editions alone', () => {
    const groups = groupEditions([r({ key: 'x', title: 'Hades II Deluxe Edition' }), r({ key: 'y', title: 'Hades II: Soundtrack', kind: 'extra' })]);
    expect(groups.map((g) => g.base.key)).toEqual(['x', 'y']);
  });
});

describe('prices and dates on cards', () => {
  it('shows free games as Free, else Steam’s price, else the store’s own text', () => {
    expect(cardPrice(r({ free: true, price: { finalCents: 999, initialCents: 999, currency: 'USD' } }))).toEqual({ now: 'Free', was: null, cut: 0 });
    expect(cardPrice(r({ price: { finalCents: 1999, initialCents: 3999, currency: 'USD' } }), 'en-US')).toEqual({ now: '$19.99', was: '$39.99', cut: 50 });
    expect(cardPrice(r({ priceText: '$27.99', discountPercent: 30 }))).toEqual({ now: '$27.99', was: null, cut: 30 });
    expect(cardPrice(r({ priceText: '  ' }))).toBeNull();
    expect(cardPrice(r({ comingSoon: true, price: { finalCents: 0, initialCents: 0, currency: 'USD' } }))).toBeNull();
  });

  it('says when a game comes out, only as exactly as the store does', () => {
    const now = new Date('2026-10-10T12:00:00Z');
    expect(releaseLabel(r({ releaseDate: '2026-11-01', comingSoon: true }), now)).toBe('Coming 1 Nov 2026');
    expect(releaseLabel(r({ releaseDate: '2026-12' }), now)).toBe('Coming Dec 2026');
    expect(releaseLabel(r({ comingSoon: true, year: 2027 }), now)).toBe('Coming 2027');
    expect(releaseLabel(r({ comingSoon: true, year: null }), now)).toBe('Coming soon');
    expect(releaseLabel(r({ releaseDate: '2026-09-20' }), now)).toBe('Out 20 Sept 2026');
    expect(releaseLabel(r({ releaseDate: '2025-01-02' }), now)).toBeNull(); // out for a while: the year says enough
    expect(releaseLabel(r({ releaseDate: 'soon' }), now)).toBeNull();
  });
});

describe('the hero', () => {
  it('leads with games like yours, then a wishlist deal, then Steam’s lists; never twice and never one you own', () => {
    const fh5 = r({ key: 'steam-5', title: 'Forza Horizon 5' });
    const owned = r({ key: 'steam-6', title: 'Owned', libraryGameId: 'g1' });
    const deal = r({ key: 'steam-7', title: 'Deal', price: { finalCents: 500, initialCents: 1000, currency: 'USD' } });
    const picks = heroPicks(
      [shelf('because:a', [fh5], { title: 'Because you played Forza Horizon 4' }), shelf('because:b', [fh5, r({ key: 'steam-8', title: 'Crew' })], { title: 'Because you played X' })],
      [shelf('specials', [owned, deal]), shelf('trending', [deal, r({ key: 'steam-9', title: 'Top' }), r({ key: 'steam-10', title: 'Top 2' })])],
      [r({ key: 'steam-11', title: 'Wish', discountPercent: 40 })],
    );
    expect(picks.map((p) => [p.result.title, p.eyebrow])).toEqual([
      ['Forza Horizon 5', 'Because you played Forza Horizon 4'],
      ['Crew', 'Because you played X'],
      ['Wish', 'On your wishlist · −40%'],
      ['Deal', 'On sale · −50% on Steam'],
      ['Top', 'Trending on Steam'],
      ['Top 2', 'Trending on Steam'],
    ]);
    expect(heroPicks([], [], [])).toEqual([]);
  });
});

describe('wishlist deals', () => {
  const w = (over: Partial<WishlistItem>): WishlistItem => ({
    appId: '10', name: 'W', priority: 0, added: null, releaseDate: '2024-05-01', comingSoon: false, releaseText: null, isFree: false,
    priceCents: 999, regularCents: 1999, discount: 50, currency: 'USD', priceText: '$9.99', notSold: false, lowestCents: null, lowestCurrency: null,
    lowestSource: null, lowestAt: null, history: [], header: null, gameId: null, pricedAt: null, ...over,
  });

  it('keeps games on sale you don’t own, biggest discount first, as Steam results', () => {
    const list = wishlistOnSale([
      w({ appId: '1', name: 'Small cut', discount: 10 }),
      w({ appId: '2', name: 'Big cut', discount: 75, priceCents: 374, regularCents: 1499 }),
      w({ appId: '3', name: 'Owned', discount: 90, gameId: 'g' }),
      w({ appId: '4', name: 'Full price', discount: 0 }),
      w({ appId: '5', name: 'Not sold', discount: 20, notSold: true }),
      w({ appId: 'x1', name: 'Bad id', discount: 30 }),
    ]);
    expect(list.map((x) => x.title)).toEqual(['Big cut', 'Small cut']);
    expect(list[0]).toMatchObject({ key: 'steam-2', steamAppId: '2', year: 2024, price: { finalCents: 374, initialCents: 1499, currency: 'USD' }, discountPercent: 75 });
  });
});

describe('genres and shelf lines', () => {
  it('knows every genre once', () => {
    expect(new Set(DISCOVER_GENRES.map((g) => g.id)).size).toBe(DISCOVER_GENRES.length);
    expect(genreById('racing')?.label).toBe('Racing');
    expect(genreById('../x')).toBeNull();
  });

  it('explains a “Because you played” row', () => {
    expect(becauseLine({ seed: { gameId: 'g', title: 'X', why: 'recent' }, source: 'igdb', reason: 'Similar games, according to IGDB' }))
      .toBe('You played it recently · Similar games, according to IGDB');
    expect(becauseLine({ seed: { gameId: 'g', title: 'X', why: 'mostPlayed' }, source: 'steam', reason: null })).toBe('One of your most played');
  });
});
