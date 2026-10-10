import { describe, expect, it } from 'vitest';
import type { WishlistItem } from '../bridge/types';
import {
  agendaWhen, dayKey, dayWords, firstDayOfWeek, gridMove, indexWishlist, markersOf, monthAgenda, monthCounts, monthGrid, nearestMonthWithReleases,
  nextRelease, parseDay, precisionFromText, precisionNote, releaseLanes, releaseOf, releaseWords, weekdayNames,
} from './wishlistCalendar';

const base: WishlistItem = {
  appId: '1', name: 'Game', priority: 0, added: null, releaseDate: null, comingSoon: true, releaseText: null, isFree: false,
  priceCents: null, regularCents: null, discount: 0, currency: null, priceText: null, notSold: false, lowestCents: null, lowestCurrency: null,
  lowestSource: null, lowestAt: null, history: [], header: null, gameId: null, pricedAt: null,
};
const item = (o: Partial<WishlistItem>): WishlistItem => ({ ...base, ...o });
const TODAY = new Date(2026, 9, 10, 15, 0); // Saturday 10 October 2026, local

describe('release precision', () => {
  it('puts a game on a day only when Steam gives a day', () => {
    const fable = releaseOf(item({ releaseDate: new Date(2027, 1, 23, 21, 30).toISOString(), releasePrecision: 'day', releaseFrom: '2027-02-23', releaseTo: '2027-02-23' }));
    expect(fable.precision).toBe('day');
    expect(dayKey(fable.day!)).toBe('2027-02-23');
    expect(fable.label).toBeNull();

    const ill = releaseOf(item({ releaseText: '2027', releasePrecision: 'year', releaseFrom: '2027-01-01', releaseTo: '2027-12-31', releaseLabel: '2027' }));
    expect(ill).toMatchObject({ precision: 'year', day: null, label: '2027' });
    expect(dayKey(ill.from!)).toBe('2027-01-01');
    expect(dayKey(ill.to!)).toBe('2027-12-31');

    const sod3 = releaseOf(item({ releaseText: 'To be announced', releasePrecision: 'tba', releaseLabel: 'To be announced' }));
    expect(sod3).toMatchObject({ precision: 'tba', day: null, from: null, label: 'To be announced' });
  });

  it('uses the local day of the release instant (when it unlocks here)', () => {
    const at = new Date(2026, 9, 28, 23, 30); // late evening local
    const r = releaseOf(item({ releaseDate: at.toISOString(), releasePrecision: 'day', releaseFrom: '2026-10-29' }));
    expect(dayKey(r.day!)).toBe('2026-10-28');
  });

  it('a day from free text alone uses the window day', () => {
    const r = releaseOf(item({ releaseText: '15 Jan, 2027', releasePrecision: 'day', releaseFrom: '2027-01-15', releaseTo: '2027-01-15' }));
    expect(dayKey(r.day!)).toBe('2027-01-15');
  });

  it('broken windows fall back to "no date", never a guess', () => {
    expect(releaseOf(item({ releasePrecision: 'quarter', releaseFrom: 'nope', releaseTo: null, releaseLabel: 'Q1 2027' }))).toMatchObject({ precision: 'tba', label: 'Q1 2027' });
    expect(releaseOf(item({ releasePrecision: 'day', releaseFrom: '2027-02-30' })).precision).toBe('tba'); // no such day
    expect(parseDay('2027-13-01')).toBeNull();
  });

  it('reads older answers without a precision field', () => {
    expect(releaseOf(item({ releaseDate: new Date(2026, 9, 13, 9).toISOString() })).precision).toBe('day');
    expect(precisionFromText('2027')).toMatchObject({ precision: 'year' });
    expect(precisionFromText('Q1 2027').precision).toBe('quarter');
    expect(dayKey(precisionFromText('Q1 2027').to!)).toBe('2027-03-31');
    expect(precisionFromText('February 2027').precision).toBe('month');
    expect(dayKey(precisionFromText('February 2027').to!)).toBe('2027-02-28');
    expect(precisionFromText('Coming soon').precision).toBe('tba');
    expect(precisionFromText(null).precision).toBe('tba');
    expect(releaseOf(item({ releaseText: 'Q2 2027' }))).toMatchObject({ precision: 'quarter', label: 'Q2 2027' });
  });

  it('says how precise each date is, in plain words', () => {
    expect(precisionNote('quarter')).toBe('Steam gives only the quarter');
    expect(precisionNote('year')).toBe('Steam gives only the year');
    expect(precisionNote('tba')).toBe('no date yet');
    expect(releaseWords({ precision: 'tba', day: null, from: null, to: null, label: null }, true)).toBe('To be announced');
    expect(releaseWords({ precision: 'tba', day: null, from: null, to: null, label: null }, false)).toBe('Out now');
  });
});

describe('month grid', () => {
  it('covers whole weeks starting on the locale’s first day', () => {
    const monday = monthGrid(2026, 9, 1, TODAY); // October 2026 starts on a Thursday
    expect(monday).toHaveLength(5);
    expect(dayKey(monday[0][0].date)).toBe('2026-09-28');
    expect(monday[0][0].inMonth).toBe(false);
    expect(dayKey(monday[0][3].date)).toBe('2026-10-01');
    expect(monday.flat().filter((c) => c.isToday).map((c) => c.key)).toEqual(['2026-10-10']);
    expect(monday.flat().find((c) => c.key === '2026-10-09')!.isPast).toBe(true);
    const sunday = monthGrid(2026, 9, 0, TODAY);
    expect(dayKey(sunday[0][0].date)).toBe('2026-09-27');
    expect(sunday[0][4].key).toBe('2026-10-01');
    // February 2026 starts on a Sunday and has 28 days: exactly four Sunday-first weeks.
    expect(monthGrid(2026, 1, 0, TODAY)).toHaveLength(4);
    // A month needing six rows.
    expect(monthGrid(2026, 7, 1, TODAY)).toHaveLength(6); // August 2026 starts on a Saturday
  });

  it('knows Sunday-first and Monday-first locales', () => {
    expect(firstDayOfWeek('en-US')).toBe(0);
    expect(firstDayOfWeek('en-GB')).toBe(1);
    expect(firstDayOfWeek('de-DE')).toBe(1);
    expect(firstDayOfWeek('not a locale!')).toBe(1);
    expect(weekdayNames(1, 'long')[0]).toMatch(/^Mon/);
    expect(weekdayNames(0)[0]).toMatch(/^Sun/);
  });
});

describe('placing games', () => {
  const games = [
    item({ appId: 'a', name: 'Out Today', priority: 2, releaseDate: new Date(2026, 9, 10, 9).toISOString(), comingSoon: false, releasePrecision: 'day' }),
    item({ appId: 'b', name: 'Same Day', priority: 1, releaseDate: new Date(2026, 9, 10, 18).toISOString(), releasePrecision: 'day' }),
    item({ appId: 'c', name: 'Released', releaseDate: new Date(2026, 8, 8, 15).toISOString(), comingSoon: false, releasePrecision: 'day' }),
    item({ appId: 'd', name: 'Next Month', releaseDate: new Date(2026, 10, 3, 12).toISOString(), releasePrecision: 'day' }),
    item({ appId: 'e', name: 'December Only', releasePrecision: 'month', releaseFrom: '2026-12-01', releaseTo: '2026-12-31', releaseLabel: 'December 2026' }),
    item({ appId: 'f', name: 'Late This Year', releasePrecision: 'season', releaseFrom: '2026-09-01', releaseTo: '2026-12-31', releaseLabel: 'Late 2026' }),
    item({ appId: 'g', name: 'Q1 Next', releasePrecision: 'quarter', releaseFrom: '2027-01-01', releaseTo: '2027-03-31', releaseLabel: 'Q1 2027' }),
    item({ appId: 'h', name: 'Next Year', priority: 1, releasePrecision: 'year', releaseFrom: '2027-01-01', releaseTo: '2027-12-31', releaseLabel: '2027' }),
    item({ appId: 'i', name: 'Far Out', releasePrecision: 'year', releaseFrom: '2029-01-01', releaseTo: '2029-12-31', releaseLabel: '2029' }),
    item({ appId: 'j', name: 'TBA', releasePrecision: 'tba', releaseLabel: 'To be announced' }),
    item({ appId: 'k', name: 'Overdue', releasePrecision: 'quarter', releaseFrom: '2025-07-01', releaseTo: '2025-09-30', releaseLabel: 'Q3 2025' }),
    item({ appId: 'l', name: 'Undated But Out', comingSoon: false, releasePrecision: 'tba', releaseLabel: 'Out now' }),
  ];
  const index = indexWishlist(games);

  it('puts exact days on the grid in your wishlist order', () => {
    expect(index.byDay.get('2026-10-10')!.map((p) => p.item.name)).toEqual(['Same Day', 'Out Today']);
    expect(index.byDay.get('2026-09-08')!.map((p) => p.item.name)).toEqual(['Released']); // released games stay on their day
    expect(index.byMonth.get('2026-12')!.map((p) => p.item.name)).toEqual(['December Only']);
    expect(index.vague.map((p) => p.item.appId).sort()).toEqual(['e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
  });

  it('builds the month agenda and year-strip counts', () => {
    const oct = monthAgenda(index, 2026, 9);
    expect(oct.days.map((d) => dayKey(d.date))).toEqual(['2026-10-10']);
    expect(monthAgenda(index, 2026, 11).sometime.map((p) => p.item.name)).toEqual(['December Only']);
    expect(monthCounts(index, 2026)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 1]);
    expect(monthCounts(index, 2030).every((n) => n === 0)).toBe(true);
  });

  it('finds the next release and the nearest months with releases', () => {
    expect(nextRelease(index, TODAY)!.item.name).toBe('Same Day');
    expect(nextRelease(index, new Date(2026, 9, 11))!.item.name).toBe('Next Month');
    expect(nextRelease(index, new Date(2027, 0, 1))).toBeNull();
    expect(nearestMonthWithReleases(index, 2026, 9, 1)).toEqual({ year: 2026, month: 10 });
    expect(nearestMonthWithReleases(index, 2026, 9, -1)).toEqual({ year: 2026, month: 8 });
    expect(nearestMonthWithReleases(index, 2026, 11, 1)).toBeNull();
  });

  it('sorts vague dates into honest lanes', () => {
    const lanes = releaseLanes(index.vague, TODAY);
    const names = Object.fromEntries(lanes.map((l) => [l.id, l.items.map((p) => p.item.name)]));
    expect(lanes.map((l) => l.id)).toEqual(['thisYear', 'nextYear', 'later', 'tba', 'out']);
    // Overdue windows still coming soon count as this year; earliest window first.
    expect(names.thisYear).toEqual(['Overdue', 'Late This Year', 'December Only']);
    // Same start: the narrower window (a quarter) before the whole year.
    expect(names.nextYear).toEqual(['Q1 Next', 'Next Year']);
    expect(names.later).toEqual(['Far Out']);
    expect(names.tba).toEqual(['TBA']);
    expect(names.out).toEqual(['Undated But Out']);
    expect(lanes.find((l) => l.id === 'later')!.sub).toBe('2028 and later');
    expect(releaseLanes([], TODAY)).toEqual([]);
  });
});

describe('words and markers', () => {
  it('describes a day relative to today', () => {
    expect(dayWords({ comingSoon: false }, new Date(2026, 9, 10), TODAY)).toBe('Out today');
    expect(dayWords({ comingSoon: true }, new Date(2026, 9, 11), TODAY)).toBe('Out tomorrow');
    expect(dayWords({ comingSoon: true }, new Date(2026, 9, 15), TODAY)).toBe('Out in 5 days');
    expect(dayWords({ comingSoon: true }, new Date(2027, 1, 23), TODAY)).toMatch(/^Out .*2027$/);
    expect(dayWords({ comingSoon: false }, new Date(2026, 8, 8), TODAY)).toMatch(/^Came out .*2026$/);
  });

  it('keeps the agenda line short (the day sits next to it)', () => {
    const soon = { comingSoon: true };
    expect(agendaWhen(soon, new Date(2026, 9, 10), TODAY)).toBe('Out today');
    expect(agendaWhen(soon, new Date(2026, 9, 11), TODAY)).toBe('Out tomorrow');
    expect(agendaWhen(soon, new Date(2026, 9, 21), TODAY)).toBe('In 11 days');
    expect(agendaWhen(soon, new Date(2026, 10, 3), TODAY)).toBe('In 3 weeks');
    expect(agendaWhen(soon, new Date(2027, 1, 23), TODAY)).toBe('In 4 months');
    expect(agendaWhen({ comingSoon: false }, new Date(2026, 9, 9), TODAY)).toBe('Came out yesterday');
    expect(agendaWhen({ comingSoon: false }, new Date(2026, 9, 5), TODAY)).toBe('Came out 5 days ago');
    expect(agendaWhen({ comingSoon: false }, new Date(2026, 8, 8), TODAY)).toBe('Out now');
  });

  it('marks price drops and the lowest price ever (same currency only)', () => {
    expect(markersOf(item({ discount: 40, priceCents: 600, currency: 'USD', lowestCents: 600, lowestCurrency: 'USD' }))).toEqual({ cut: 40, lowest: true, belowLowest: false });
    expect(markersOf(item({ discount: 0, priceCents: 500, currency: 'USD', lowestCents: 600, lowestCurrency: 'USD' }))).toEqual({ cut: null, lowest: true, belowLowest: true });
    expect(markersOf(item({ discount: 10, priceCents: 500, currency: 'INR', lowestCents: 600, lowestCurrency: 'USD' }))).toEqual({ cut: 10, lowest: false, belowLowest: false });
  });
});

describe('keyboard movement', () => {
  // Week rows: [0: col 1, col 1 (two games one day), col 5], [1: col 0], [3: col 6]
  const pos = [{ row: 0, col: 1 }, { row: 0, col: 1 }, { row: 0, col: 5 }, { row: 1, col: 0 }, { row: 3, col: 6 }];
  it('steps through games in date order and jumps between weeks', () => {
    expect(gridMove(pos, 0, 'right')).toBe(1);
    expect(gridMove(pos, 4, 'right')).toBe(4);   // the last game stays
    expect(gridMove(pos, 0, 'left')).toBe(0);
    expect(gridMove(pos, 2, 'down')).toBe(3);    // the next week with a game, nearest column
    expect(gridMove(pos, 3, 'down')).toBe(4);    // skips empty weeks
    expect(gridMove(pos, 4, 'up')).toBe(3);
    expect(gridMove(pos, 3, 'up')).toBe(0);      // nearest column in the week above (col 1 beats col 5)
    expect(gridMove(pos, 0, 'up')).toBe(0);
    expect(gridMove(pos, 2, 'home')).toBe(0);
    expect(gridMove(pos, 0, 'end')).toBe(4);
    expect(gridMove([], 0, 'down')).toBe(-1);
  });
});
