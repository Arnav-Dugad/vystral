import { describe, expect, it } from 'vitest';
import type { ValueGame } from '../bridge/types';
import { cumulativeValue, formatHours, formatMoney, gridMove, keyLooksValid, matchLabel, storesIn, topValue, yearMarkers } from './dataSources';
import { placeholderArt } from '../bridge/preview.dataSources';

const game = (id: string, since: string, cents: number | null, platforms: ValueGame['platforms'] = ['steam'], currency: string | null = cents == null ? null : 'USD'): ValueGame => ({
  gameId: id, title: id, platforms, since, sinceSource: 'firstSeen', priceCents: cents, regularCents: cents, currency, formatted: null, notSold: false, pricedAt: null,
});

describe('library value', () => {
  const games = [
    game('b', '2023-05-01T00:00:00Z', 1999),
    game('a', '2021-02-01T00:00:00Z', 999),
    game('c', '2024-08-01T00:00:00Z', null, ['gog']),
    game('d', '2024-09-01T00:00:00Z', 4999, ['steam'], 'EUR'), // other currency: counted, not added
  ];

  it('accumulates current prices in date order and counts unpriced games', () => {
    const pts = cumulativeValue(games, 'USD');
    expect(pts.map((p) => p.gameId)).toEqual(['a', 'b', 'c', 'd']);
    expect(pts.map((p) => p.cents)).toEqual([999, 2998, 2998, 2998]);
    expect(pts.map((p) => p.count)).toEqual([1, 2, 3, 4]);
  });

  it('filters by store', () => {
    expect(cumulativeValue(games, 'USD', 'gog').map((p) => p.gameId)).toEqual(['c']);
    expect(storesIn(games)).toEqual(['steam', 'gog']);
  });

  it('marks each new year inside the span', () => {
    const years = yearMarkers(cumulativeValue(games, 'USD')).map((y) => y.year);
    expect(years).toEqual([2022, 2023, 2024]);
    expect(yearMarkers([])).toEqual([]);
  });

  it('ranks top value in the main currency only', () => {
    expect(topValue(games, 'USD', 5).map((g) => g.gameId)).toEqual(['b', 'a']);
  });

  it('ignores unparseable dates instead of drawing them', () => {
    expect(cumulativeValue([game('x', 'not a date', 100)], 'USD')).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats money with a currency, or plainly without one', () => {
    expect(formatMoney(19.99, 'USD')).toMatch(/19\.99/);
    expect(formatMoney(5, null)).toBe('5.00');
    expect(formatMoney(5, '<b>')).toBe('5.00');
    expect(formatMoney(Number.NaN, 'USD')).toBe('—');
  });

  it('formats time to beat from seconds', () => {
    expect(formatHours(45 * 60)).toBe('45 min');
    expect(formatHours(90 * 60)).toBe('1 h 30 min');
    expect(formatHours(12 * 3600 + 20 * 60)).toBe('12 h');
    expect(formatHours(null)).toBeNull();
    expect(formatHours(-5)).toBeNull();
  });

  it('describes how a game was matched', () => {
    expect(matchLabel({ matchMethod: 'steam-appid', confidence: 1 })).toBe('matched by Steam app ID');
    expect(matchLabel({ matchMethod: 'exact-title', confidence: 0.85 })).toBe('matched by exact title (85% confidence)');
  });
});

describe('keys and keyboard', () => {
  it('checks key shapes like the native side', () => {
    expect(keyLooksValid('steamgriddb', '0123456789abcdef0123456789abcdef')).toBe(true);
    expect(keyLooksValid('rawg', 'has space in it 0123456789')).toBe(false);
    expect(keyLooksValid('itad', '1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d')).toBe(true);
    expect(keyLooksValid('igdb', 'abcdefghijklmnopqrstuvwxyz0123', 'zyxwvutsrqponmlkjihgfedcba9876')).toBe(true);
    expect(keyLooksValid('igdb', 'abcdefghijklmnopqrstuvwxyz0123', '')).toBe(false);
    expect(keyLooksValid('igdb', 'abcdefghijklmnopqrstuvwxyz0123', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).toBe(false);
  });

  it('moves through the picker grid', () => {
    expect(gridMove(0, 'ArrowRight', 10, 4)).toBe(1);
    expect(gridMove(0, 'ArrowLeft', 10, 4)).toBe(0);
    expect(gridMove(1, 'ArrowDown', 10, 4)).toBe(5);
    expect(gridMove(8, 'ArrowDown', 10, 4)).toBe(9);
    expect(gridMove(2, 'ArrowUp', 10, 4)).toBe(2);
    expect(gridMove(6, 'ArrowUp', 10, 4)).toBe(2);
    expect(gridMove(5, 'End', 10, 4)).toBe(9);
    expect(gridMove(5, 'Home', 10, 4)).toBe(0);
    expect(gridMove(0, 'ArrowRight', 0, 4)).toBe(-1);
  });
});

describe('preview artwork', () => {
  it('is generated locally as an SVG data URL, never a remote image', () => {
    const url = placeholderArt('cover', 'Nebula Drift', 0, 'alternate');
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(url)).toContain('ND');
    expect(decodeURIComponent(placeholderArt('cover', 'Nebula Drift', 0, 'no_logo'))).not.toContain('>ND<');
    expect(url).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });
});
