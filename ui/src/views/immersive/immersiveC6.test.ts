import { describe, expect, it } from 'vitest';
import type { DiscoverDetails, DiscoverResult, DiscoverSearch, DiscoverWatch, Game, WishlistItem } from '../../bridge/types';
import { discoverItemSpeech, discoverRows, fromWishlist, libraryMatches, pageSummary, seriesIdeas, seriesName, type DiscoverInput } from './discoverRows';
import { IMM_TABS, INITIAL_NAV, switchTab, tabBeside } from './nav';
import { tileLabel, tileGame } from './rows';
import { tileSpeech } from './speech';

function game(id: string, title: string, extra: Partial<Game> = {}): Game {
  return {
    id, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false, hidden: false,
    userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null,
    art: { cover: null, hero: null, logo: null, header: null, icon: null }, installations: [], collections: [], trackedSeconds: 0, sessionCount: 0,
    lastTrackedPlay: null, added: '2026-01-01T00:00:00Z', ...extra,
  };
}

function result(key: string, title: string, extra: Partial<DiscoverResult> = {}): DiscoverResult {
  return {
    key, title, year: 2024, stores: ['steam'], platforms: ['PC'], genres: ['RPG'], sources: ['steam'], steamAppId: null, libraryGameId: null,
    price: { finalCents: 1999, initialCents: 3999, currency: 'USD' }, hasCover: true, cover: null, score: 80, kind: 'game', ...extra,
  };
}

function search(results: DiscoverResult[], extra: Partial<DiscoverSearch> = {}): DiscoverSearch {
  return { searchId: 's1', channel: 'page', query: 'ashen', page: 0, sources: [], results, done: true, hasMore: false, reason: null, ...extra };
}

const base = (extra: Partial<DiscoverInput> = {}): DiscoverInput => ({
  query: null, search: null, busy: false, error: null, loadingMore: false, reason: null, preview: false, watching: [], wishlist: null, library: [], ...extra,
});

const ids = (input: DiscoverInput) => discoverRows(input).map((r) => r.id);

describe('Discover sections', () => {
  it('LB/RB step through Home, All games and Discover, stopping at the ends', () => {
    expect(IMM_TABS).toEqual(['home', 'library', 'discover']);
    expect(tabBeside('home', -1)).toBeNull();
    expect(tabBeside('library', 1)).toBe('discover');
    expect(tabBeside('discover', 1)).toBeNull();
    expect(switchTab(INITIAL_NAV, 'discover')).toMatchObject({ tab: 'discover', row: 0, rowId: null });
    expect(switchTab(INITIAL_NAV).tab).toBe('library');
  });
});

describe('discoverRows', () => {
  it('starts with the search card and an empty Watching row', () => {
    const rows = discoverRows(base());
    expect(rows.map((r) => r.id)).toEqual(['disc-find', 'disc-watching']);
    expect(rows[0].tiles[0]).toMatchObject({ kind: 'search', query: null, label: 'Search any game' });
    expect(rows[1].tiles[0]).toMatchObject({ kind: 'note', key: 'watch-empty' });
  });

  it('labels preview results as fictional', () => {
    expect(discoverRows(base({ preview: true }))[0].meta).toMatch(/Preview/);
  });

  it('shows shimmering placeholders while the first answers come in', () => {
    const rows = discoverRows(base({ query: 'ashen', busy: true }));
    const res = rows.find((r) => r.id === 'disc-results')!;
    expect(res.meta).toBe('Searching…');
    expect(res.tiles.every((t) => t.kind === 'note' && t.busy)).toBe(true);
  });

  it('puts games first and add-ons last, and moves games you own to their own row', () => {
    const lib = [game('g1', 'Ashen Crown'), game('g2', 'Ashen Embers')];
    const rows = discoverRows(base({
      query: 'ashen', library: lib,
      search: search([result('steam-1', 'Ashen Soundtrack', { kind: 'extra' }), result('steam-2', 'Ashen Peaks'), result('steam-3', 'Ashen Crown', { libraryGameId: 'g1' })]),
    }));
    const res = rows.find((r) => r.id === 'disc-results')!;
    expect(res.tiles.map((t) => (t.kind === 'discover' ? t.item.title : t.kind))).toEqual(['Ashen Peaks', 'Ashen Soundtrack']);
    const owned = rows.find((r) => r.id === 'disc-owned')!;
    expect(owned.tiles.map((t) => (t.kind === 'game' ? t.game.id : ''))).toEqual(['g1', 'g2']);
  });

  it('says when nothing was found, and offers more when sources have more', () => {
    const none = discoverRows(base({ query: 'zzz', search: search([]) })).find((r) => r.id === 'disc-results')!;
    expect(none.tiles[0]).toMatchObject({ kind: 'note', key: 'none', action: 'search' });
    expect(none.meta).toBe('Nothing found');
    const more = discoverRows(base({ query: 'ashen', search: search([result('steam-2', 'Ashen Peaks')], { hasMore: true }) })).find((r) => r.id === 'disc-results')!;
    expect(more.tiles.at(-1)).toMatchObject({ kind: 'note', key: 'more', action: 'more' });
  });

  it('offers Try again after an error', () => {
    const rows = discoverRows(base({ query: 'ashen', error: 'Steam couldn’t be reached.' }));
    expect(rows.find((r) => r.id === 'disc-results')!.tiles.at(-1)).toMatchObject({ kind: 'note', action: 'retry' });
  });

  it('explains Offline mode and search being off instead of showing results', () => {
    const offline = discoverRows(base({ query: 'ashen', reason: 'offline' }));
    expect(offline.map((r) => r.id)).not.toContain('disc-results');
    expect(offline[0].tiles[1]).toMatchObject({ kind: 'note', key: 'offline', action: null });
    const off = discoverRows(base({ reason: 'off' }));
    expect(off[0].tiles[1]).toMatchObject({ kind: 'note', key: 'off', action: 'turnOn' });
  });

  it('lists Watching and the wishlist, leaving out owned and already-watched wishlist games', () => {
    const watching: DiscoverWatch[] = [{ key: 'steam-5', title: 'Lighthouse', year: 2019, steamAppId: '5', addedAt: '2026-03-01T00:00:00Z', priceWhenAdded: '$14.99', cover: null }];
    const wish = (appId: string, name: string, extra: Partial<WishlistItem> = {}): WishlistItem => ({
      appId, name, priority: 1, added: null, releaseDate: null, comingSoon: false, releaseText: null, isFree: false, priceCents: 999, regularCents: 999, discount: 0,
      currency: 'USD', priceText: '$9.99', notSold: false, lowestCents: null, lowestCurrency: null, lowestSource: null, lowestAt: null, history: [], header: null,
      gameId: null, pricedAt: null, ...extra,
    });
    const rows = discoverRows(base({ watching, wishlist: [wish('5', 'Lighthouse'), wish('6', 'Owned', { gameId: 'g9' }), wish('7', 'Paper Comets', { priority: 2, discount: 40 })] }));
    const w = rows.find((r) => r.id === 'disc-watching')!;
    expect(w.tiles[0]).toMatchObject({ kind: 'discover', item: { key: 'steam-5', note: '$14.99 when you started watching' } });
    const wl = rows.find((r) => r.id === 'disc-wishlist')!;
    expect(wl.tiles.map((t) => (t.kind === 'discover' ? t.item.key : ''))).toEqual(['steam-7']);
    expect(fromWishlist(wish('x', 'Bad'))).toBeNull();
  });

  it('suggests searches from the series you play most', () => {
    const lib = [
      game('a', 'Ashen Crown II: Embers', { trackedSeconds: 9000 }),
      game('b', 'Ashen Crown', { trackedSeconds: 100 }),
      game('c', 'Nebula Drift Remastered', { trackedSeconds: 5000 }),
      game('d', 'Never Played'),
    ];
    expect(seriesIdeas(lib).map((i) => i.query)).toEqual(['Ashen Crown', 'Nebula Drift']);
    expect(seriesName('Tales of the Ninth Moon: Director’s Cut')).toBe('Tales of the Ninth Moon');
    expect(seriesName('X2')).toBeNull();
    expect(ids(base({ library: lib }))).toContain('disc-ideas');
  });

  it('matches library titles by the start of each word', () => {
    const lib = [game('a', 'Ashen Crown'), game('b', 'Crown of Cinders'), game('c', 'Hidden', { hidden: true })];
    expect(libraryMatches(lib, 'crown').map((g) => g.id)).toEqual(['b', 'a']);
    expect(libraryMatches(lib, 'ash cro').map((g) => g.id)).toEqual(['a']);
    expect(libraryMatches(lib, 'hidden')).toEqual([]);
  });
});

describe('Discover words', () => {
  it('voice-over and labels for cards', () => {
    const rows = discoverRows(base({ query: 'ashen', search: search([result('steam-2', 'Ashen Peaks')]) }));
    const tile = rows.find((r) => r.id === 'disc-results')!.tiles[0];
    expect(tileGame(tile)).toBeNull();
    expect(tileLabel(tile)).toBe('Ashen Peaks, 2024, $19.99. Not in your library');
    expect(tileSpeech(tile)).toMatch(/Ashen Peaks\. 2024\. \$19\.99, 50 percent off\. Not in your library\. Press A for details/);
    expect(tileSpeech(rows[0].tiles[0])).toMatch(/Search any game/);
    if (tile.kind === 'discover') expect(discoverItemSpeech({ ...tile.item, source: 'watching' })).toContain('On your Watching list');
  });

  it('a page says its price, time to beat and how to watch it', () => {
    const d = {
      title: 'Ashen Peaks', libraryGameId: null, price: { formatted: '$19.99', initial: '$39.99', discountPercent: 50, currency: 'USD', free: false, comingSoon: false, country: 'US' },
      timeToBeat: { hastilySeconds: 12 * 3600, normallySeconds: null, completelySeconds: null, count: 10 },
    } as unknown as DiscoverDetails;
    expect(pageSummary(d, false)).toBe('Ashen Peaks. Not in your library. $19.99 on Steam, 50 percent off. About 12 hours to beat. Press Y to watch it.');
    expect(pageSummary(d, true)).toContain('Watching. Press Y to stop watching');
  });
});
