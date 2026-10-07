import { describe, expect, it } from 'vitest';
import type { WishlistItem } from '../bridge/types';
import {
  daysUntil, filterWishlist, formatMoney, priceVerdict, releaseBadge, releaseLabel, sortWishlist, sparkline, sparklineSummary, wishlistSummary,
} from './wishlist';

const NOW = new Date(2026, 2, 10, 15, 0, 0); // 10 Mar 2026, 15:00 local

function item(p: Partial<WishlistItem>): WishlistItem {
  return {
    appId: '1', name: 'Game', priority: 0, added: null, releaseDate: null, comingSoon: false, releaseText: null, isFree: false,
    priceCents: 1999, regularCents: 1999, discount: 0, currency: 'USD', priceText: '$19.99', notSold: false,
    lowestCents: null, lowestCurrency: null, lowestSource: null, lowestAt: null, history: [], header: null, gameId: null, pricedAt: null,
    ...p,
  };
}

describe('release badges', () => {
  it('says Released! on launch day only', () => {
    expect(releaseBadge(item({ releaseDate: new Date(2026, 2, 10, 9).toISOString() }), NOW)).toBe('today');
    expect(releaseBadge(item({ releaseDate: new Date(2026, 2, 9, 9).toISOString() }), NOW)).toBeNull();
    // Still "coming soon" on Steam later today: not yet released.
    expect(releaseBadge(item({ releaseDate: new Date(2026, 2, 10, 20).toISOString(), comingSoon: true }), NOW)).toBe('soon');
  });

  it('flags games out within a week', () => {
    expect(releaseBadge(item({ releaseDate: new Date(2026, 2, 13).toISOString(), comingSoon: true }), NOW)).toBe('soon');
    expect(releaseBadge(item({ releaseDate: new Date(2026, 3, 13).toISOString(), comingSoon: true }), NOW)).toBeNull();
    expect(releaseBadge(item({ releaseDate: null, comingSoon: true, releaseText: 'Q2 2027' }), NOW)).toBeNull();
    expect(releaseBadge(item({ releaseDate: 'not a date' }), NOW)).toBeNull();
  });

  it('describes the release in plain words', () => {
    expect(releaseLabel(item({ releaseDate: new Date(2026, 2, 10, 9).toISOString() }), NOW)).toBe('Out today');
    expect(releaseLabel(item({ releaseDate: new Date(2026, 2, 11, 9).toISOString(), comingSoon: true }), NOW)).toBe('Out tomorrow');
    expect(releaseLabel(item({ releaseDate: new Date(2026, 2, 13, 9).toISOString(), comingSoon: true }), NOW)).toBe('Out in 3 days');
    expect(releaseLabel(item({ comingSoon: true, releaseText: 'Q2 2027' }), NOW)).toBe('Coming Q2 2027');
    expect(releaseLabel(item({ comingSoon: true, releaseText: 'Coming soon™' }), NOW)).toBe('Coming soon™');
    expect(releaseLabel(item({ comingSoon: true }), NOW)).toBe('Coming soon');
    expect(releaseLabel(item({ releaseDate: new Date(2020, 0, 5).toISOString() }), NOW)).toMatch(/^Released /);
    expect(daysUntil(new Date(2026, 2, 12, 1).toISOString(), NOW)).toBe(2);
  });
});

describe('prices', () => {
  it('compares with the lowest price ever only in the same currency', () => {
    expect(priceVerdict(item({ priceCents: 999, lowestCents: 999, lowestCurrency: 'USD' }))).toMatchObject({ comparable: true, atLowest: true, belowLowest: false, aboveLowest: 0 });
    expect(priceVerdict(item({ priceCents: 749, lowestCents: 999, lowestCurrency: 'USD' }))).toMatchObject({ atLowest: true, belowLowest: true });
    expect(priceVerdict(item({ priceCents: 1999, lowestCents: 999, lowestCurrency: 'USD' })).aboveLowest).toBeCloseTo(1.001, 2);
    expect(priceVerdict(item({ priceCents: 999, lowestCents: 999, lowestCurrency: 'EUR' })).comparable).toBe(false);
    expect(priceVerdict(item({ priceCents: null, lowestCents: 999, lowestCurrency: 'USD' })).comparable).toBe(false);
    expect(priceVerdict(item({ priceCents: 0, lowestCents: 0, lowestCurrency: 'USD' })).atLowest).toBe(false); // free isn't a deal
  });

  it('formats Steam hundredths in any currency', () => {
    expect(formatMoney(1999, 'USD')).toMatch(/19\.99/);
    expect(formatMoney(198000, 'JPY')).toMatch(/1,?980/);
    expect(formatMoney(500, null)).toBe('5.00');
    expect(formatMoney(500, 'bad')).toBe('5.00');
  });
});

describe('sorting and filtering', () => {
  const list = [
    item({ appId: 'a', name: 'Alpha', priority: 2, discount: 0, added: '2026-01-01T00:00:00Z', releaseDate: '2024-01-01T00:00:00Z' }),
    item({ appId: 'b', name: 'Bravo', priority: 1, discount: 50, added: '2026-03-01T00:00:00Z', releaseDate: '2025-06-01T00:00:00Z', priceCents: 999, lowestCents: 999, lowestCurrency: 'USD' }),
    item({ appId: 'c', name: 'Charlie', priority: 0, discount: 50, added: '2025-01-01T00:00:00Z', comingSoon: true, releaseDate: '2026-04-01T00:00:00Z' }),
    item({ appId: 'd', name: 'Delta', priority: 3, comingSoon: true, releaseText: 'Q3 2027' }),
    item({ appId: 'e', name: 'Echo', priority: 4, comingSoon: true, releaseDate: '2026-03-20T00:00:00Z' }),
  ];
  const ids = (l: WishlistItem[]) => l.map((i) => i.appId).join('');

  it('sorts by your order (unranked last), price drop, release date and date added', () => {
    expect(ids(sortWishlist(list, 'priority'))).toBe('badec');
    expect(ids(sortWishlist(list, 'drop'))).toBe('bcade');   // 50% at the lowest ever beats 50% not
    expect(ids(sortWishlist(list, 'release'))).toBe('ecdba'); // upcoming soonest, undated upcoming, then newest releases
    expect(ids(sortWishlist(list, 'added'))).toBe('bacde');
    expect(ids(list)).toBe('abcde'); // never sorted in place
  });

  it('filters and searches', () => {
    expect(ids(filterWishlist(list, 'sale'))).toBe('bc');
    expect(ids(filterWishlist(list, 'lowest'))).toBe('b');
    expect(ids(filterWishlist(list, 'upcoming'))).toBe('cde');
    expect(ids(filterWishlist(list, 'all', '  ECH '))).toBe('e');
  });

  it('summarises the list', () => {
    expect(wishlistSummary(list, NOW)).toEqual({ onSale: 2, atLowest: 1, upcoming: 3, outToday: 0 });
  });
});

describe('sparkline', () => {
  const history = [{ day: '2026-01-01', cents: 2000 }, { day: '2026-02-01', cents: 1000 }, { day: '2026-03-01', cents: 1500 }];

  it('needs at least two points', () => {
    expect(sparkline([], 100, 40)).toBeNull();
    expect(sparkline([history[0]], 100, 40)).toBeNull();
    expect(sparkline([{ day: 'bad', cents: 1 }, history[0]], 100, 40)).toBeNull();
  });

  it('draws steps over real time to today, inside the box', () => {
    const s = sparkline(history, 100, 40, 800, new Date(Date.UTC(2026, 2, 31)))!;
    expect(s.line.startsWith('M0,')).toBe(true);
    expect(s.line.endsWith('H100')).toBe(true);
    expect(s.line).toMatch(/H\d+(\.\d+)? V/);
    expect(s.area.endsWith('Z')).toBe(true);
    const ys = [...s.line.matchAll(/V([\d.]+)/g)].map((m) => Number(m[1]));
    for (const y of [...ys, s.lowY!, s.last.y]) { expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThanOrEqual(40); }
    expect(s.lowY).toBeGreaterThan(ys[0]); // the lowest ever sits below every recorded price
    expect(s.min).toBe(1000);
    expect(s.max).toBe(2000);
    expect(s.days).toBe(89);
  });

  it('handles a flat history without dividing by zero', () => {
    const s = sparkline([{ day: '2026-01-01', cents: 500 }, { day: '2026-01-02', cents: 500 }], 100, 40)!;
    expect(s.line).not.toMatch(/NaN|Infinity/);
  });

  it('describes the history for screen readers', () => {
    expect(sparklineSummary(history, 'USD')).toMatch(/between .*10\.00 and .*20\.00, now .*15\.00/);
    expect(sparklineSummary([history[0]], 'USD')).toBe('');
  });
});
