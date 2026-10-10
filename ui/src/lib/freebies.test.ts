import { describe, expect, it } from 'vitest';
import type { FreebieItem, Game, Installation } from '../bridge/types';
import { claimHost, cleanFreebies, endsLabel, isRunning, orderFreebies, ownedMatch } from './freebies';

const NOW = Date.parse('2026-10-09T12:00:00Z'); // a Friday
const DAY = 86_400_000;

function game(title: string, platform: Installation['platform'], extra: Partial<Game> = {}): Game {
  return {
    id: title, title, sortTitle: title.toLowerCase(), description: null, developer: null, publisher: null, releaseDate: null, genres: [], favorite: false, hidden: false,
    userRating: null, notes: null, preferredInstallationId: null, metadataSource: null, palette: null, art: { cover: null, hero: null, logo: null, header: null, icon: null },
    installations: [{ id: 'i', platform, platformGameId: '1', title, state: 'notinstalled', installPath: null, drive: null, sizeBytes: null, clientRequired: true, launchKind: 'Uri',
      importedLastPlayed: null, importedPlaytimeMinutes: null, userLaunchArgs: null, manualLink: false, lastSeen: '' }],
    collections: [], trackedSeconds: 0, sessionCount: 0, lastTrackedPlay: null, added: '2026-01-01', ...extra,
  };
}

const item = (id: string, title: string, platform: FreebieItem['platform'], endDays: number | null, extra: Partial<FreebieItem> = {}): FreebieItem => ({
  id, title, platform, url: `https://store.example.com/${id}`, image: null, endDate: endDays == null ? null : new Date(NOW + endDays * DAY).toISOString(), ...extra,
});

describe('cleaning what freebies.get returned', () => {
  it('keeps well-formed items only, folds unknown stores into "other" and drops unsafe images and N/A prices', () => {
    const raw = {
      state: 'ready', fetchedAt: null,
      items: [
        { id: '1', title: ' Good ', platform: 'epic', url: 'https://store.epicgames.com/p/good', image: 'https://art.vystral.example/x.png', worth: '$9.99', endDate: '2026-10-12T15:00:00Z' },
        { id: '1', title: 'Duplicate id', platform: 'epic', url: 'https://store.epicgames.com/p/dup', image: null },
        { id: 'abc', title: 'Bad id', platform: 'steam', url: 'https://store.steampowered.com/', image: null },
        { id: '2', title: 'Plain http', platform: 'gog', url: 'http://gog.com/x', image: null },
        { id: '3', title: 'Remote image', platform: 'mystery', url: 'https://example.org/x', image: 'https://evil.example/tracker.png', worth: 'N/A', endDate: 'soon' },
        null,
      ],
    };
    const c = cleanFreebies(raw)!;
    expect(c.items.map((i) => i.id)).toEqual(['1', '3']);
    expect(c.items[0]).toMatchObject({ title: 'Good', worth: '$9.99', image: 'https://art.vystral.example/x.png' });
    expect(c.items[1]).toMatchObject({ platform: 'other', image: null, worth: null, endDate: null });
    expect(cleanFreebies(null)).toBeNull();
    expect(cleanFreebies(true)).toBeNull(); // an old build's no-op answer
  });

  it('shows only the https host of a claim link', () => {
    expect(claimHost('https://www.gog.com/en/game/x')).toBe('gog.com');
    expect(claimHost('javascript:alert(1)')).toBeNull();
    expect(claimHost('not a url')).toBeNull();
  });
});

describe('ownership', () => {
  it('matches titles with editions folded, and knows whether it is the same store', () => {
    const lib = [game('Moss & Marrow', 'epic'), game('Ironwake Rally Deluxe Edition', 'steam')];
    expect(ownedMatch(item('1', 'Moss & Marrow', 'epic', 2), lib)).toMatchObject({ sameStore: true });
    expect(ownedMatch(item('2', 'Moss & Marrow', 'gog', 2), lib)).toMatchObject({ sameStore: false });
    expect(ownedMatch(item('3', 'Ironwake Rally', 'steam', 2), lib)).toMatchObject({ sameStore: true });
    expect(ownedMatch(item('4', 'Something Else', 'steam', 2), lib)).toBeNull();
    expect(ownedMatch(item('5', 'Moss & Marrow', 'epic', 2, { kind: 'dlc' }), lib)).toBeNull();
    expect(ownedMatch(item('6', 'Moss & Marrow', 'epic', 2), [game('Moss & Marrow', 'epic', { notOwned: true })])).toBeNull();
  });
});

describe('order and wording', () => {
  it('drops ended giveaways, puts ones you own last and ones ending within two days first', () => {
    const lib = [game('Owned One', 'epic')];
    const items = [
      item('1', 'Later', 'gog', 6),
      item('2', 'Owned One', 'epic', 1),
      item('3', 'Soon', 'steam', 1),
      item('4', 'Ended', 'steam', -1),
      item('5', 'Open ended', 'itch', null),
      item('6', 'Liked', 'gog', 9),
    ];
    const rank = (id: string) => (id === '6' ? 1 : 0);
    expect(orderFreebies(items, lib, NOW, rank).map((i) => i.title)).toEqual(['Soon', 'Liked', 'Later', 'Open ended', 'Owned One']);
    expect(isRunning(items[3], NOW)).toBe(false);
    expect(isRunning(items[4], NOW)).toBe(true);
  });

  it('says when a giveaway ends in plain words', () => {
    const at = (days: number, hour = 15) => { const d = new Date(NOW + days * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
    expect(endsLabel(at(0, 23), NOW)).toEqual({ text: 'Ends today', soon: true });
    expect(endsLabel(at(1), NOW)!.text).toBe('Ends tomorrow');
    expect(endsLabel(at(3), NOW, 'en-GB')!.text).toMatch(/^Ends [A-Z][a-z]+day$/);
    expect(endsLabel(at(12), NOW, 'en-GB')!.text).toMatch(/^Ends \d{1,2} [A-Z][a-z]{2}/);
    expect(endsLabel(new Date(NOW - 1000).toISOString(), NOW)).toEqual({ text: 'Ended', soon: true });
    expect(endsLabel(null, NOW)).toBeNull();
  });
});
