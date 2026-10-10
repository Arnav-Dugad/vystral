import { describe, expect, it } from 'vitest';
import type { Freebie, Freebies, Game, Installation } from '../bridge/types';
import { allFailed, cleanFreebies, endsLabel, isClaimable, isShown, orderFreebies, ownedMatch, startsLabel } from './freebies';

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

const at = (days: number) => new Date(NOW + days * DAY).toISOString();
const item = (id: string, title: string, store: Freebie['store'], endDays: number | null, extra: Partial<Freebie> = {}): Freebie => ({
  id, source: id.startsWith('epic-') ? 'epic' : 'gamerpower', title, store, platforms: ['PC'], kind: 'game', status: 'now', worth: null,
  startsAt: at(-1), endsAt: endDays == null ? null : at(endDays), description: null, image: null, hasImage: false, ...extra,
});
const src = (id: 'gamerpower' | 'epicfree', extra: Partial<Freebies['sources'][number]> = {}): Freebies['sources'][number] =>
  ({ id, name: id, enabled: true, fetchedAt: at(0), stale: false, error: null, attribution: 'x', ...extra });

describe('cleaning what freebies.get returned', () => {
  it('keeps well-formed items only, folds unknown stores into "other", drops unsafe images and N/A prices', () => {
    const raw = {
      reason: null, sources: [src('gamerpower')],
      items: [
        { ...item('gp-1', ' Good ', 'epic', 3), worth: '$9.99', image: 'https://art.vystral.example/x.png' },
        item('gp-1', 'Duplicate id', 'steam', 3),
        item('abc', 'Bad id', 'steam', 3),
        item('gp-2', '', 'steam', 3),
        { ...item('gp-3', 'Remote image', 'mystery' as Freebie['store'], null), image: 'https://evil.example/tracker.png', worth: 'N/A', endsAt: 'soon' },
        null,
      ],
    };
    const c = cleanFreebies(raw)!;
    expect(c.items.map((i) => i.id)).toEqual(['gp-1', 'gp-3']);
    expect(c.items[0]).toMatchObject({ title: 'Good', worth: '$9.99', image: 'https://art.vystral.example/x.png', hasImage: true });
    expect(c.items[1]).toMatchObject({ store: 'other', image: null, worth: null, endsAt: null });
    expect(cleanFreebies(null)).toBeNull();
    expect(cleanFreebies(true)).toBeNull(); // an old build's no-op answer
  });

  it('shows a giveaway GamerPower and Epic both list once, keeping Epic’s own entry', () => {
    const c = cleanFreebies({ reason: null, sources: [], items: [
      item('gp-9', 'Lanternfall', 'epic', 3),
      item('epic-0f3a9c1d2b4e6f70', 'Lanternfall', 'epic', 4),
      item('gp-10', 'Lanternfall', 'steam', 3), // another store: a different giveaway
    ] })!;
    expect(c.items.map((i) => i.id)).toEqual(['epic-0f3a9c1d2b4e6f70', 'gp-10']);
  });

  it('knows when every source that is on failed', () => {
    expect(allFailed({ items: [], reason: null, sources: [src('gamerpower', { error: 'unavailable' }), src('epicfree', { enabled: false })] })).toBe(true);
    expect(allFailed({ items: [], reason: null, sources: [src('gamerpower', { error: 'unavailable' }), src('epicfree')] })).toBe(false);
    expect(allFailed({ items: [], reason: 'off', sources: [] })).toBe(false);
  });
});

describe('ownership', () => {
  it('matches titles with editions folded, and knows whether it is the same store', () => {
    const lib = [game('Moss & Marrow', 'epic'), game('Ironwake Rally Deluxe Edition', 'steam')];
    expect(ownedMatch(item('gp-1', 'Moss & Marrow', 'epic', 2), lib)).toMatchObject({ sameStore: true });
    expect(ownedMatch(item('gp-2', 'Moss & Marrow', 'gog', 2), lib)).toMatchObject({ sameStore: false });
    expect(ownedMatch(item('gp-3', 'Ironwake Rally', 'steam', 2), lib)).toMatchObject({ sameStore: true });
    expect(ownedMatch(item('gp-4', 'Something Else', 'steam', 2), lib)).toBeNull();
    expect(ownedMatch(item('gp-5', 'Moss & Marrow', 'epic', 2, { kind: 'loot' }), lib)).toBeNull();
    expect(ownedMatch(item('gp-6', 'Moss & Marrow', 'epic', 2), [game('Moss & Marrow', 'epic', { notOwned: true })])).toBeNull();
  });
});

describe('order and wording', () => {
  it('claimable first, ending within two days first, ones you own last, next week’s after; ended ones gone', () => {
    const lib = [game('Owned One', 'epic')];
    const items = [
      item('gp-1', 'Later', 'gog', 6),
      item('gp-2', 'Owned One', 'epic', 1),
      item('gp-3', 'Soon', 'steam', 1),
      item('gp-4', 'Ended', 'steam', -1),
      item('gp-5', 'Open ended', 'itch', null),
      item('gp-6', 'Liked', 'gog', 9),
      item('epic-0f3a9c1d2b4e6f71', 'Next Week', 'epic', 12, { status: 'upcoming', startsAt: at(5) }),
      item('epic-0f3a9c1d2b4e6f72', 'Far Future', 'epic', 40, { status: 'upcoming', startsAt: at(30) }),
    ];
    const rank = (id: string) => (id === 'gp-6' ? 1 : 0);
    expect(orderFreebies(items, lib, NOW, rank).map((i) => i.title)).toEqual(['Soon', 'Liked', 'Later', 'Open ended', 'Owned One', 'Next Week']);
    expect(isClaimable(items[6], NOW)).toBe(false);
    expect(isClaimable(items[6], NOW + 6 * DAY)).toBe(true);
    expect(isShown(items[3], NOW)).toBe(false);
    expect(isShown(items[7], NOW)).toBe(false);
  });

  it('says when a giveaway starts or ends in plain words', () => {
    const local = (days: number, hour = 15) => { const d = new Date(NOW + days * DAY); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
    expect(endsLabel(local(0, 23), NOW)).toEqual({ text: 'Ends today', soon: true });
    expect(endsLabel(local(1), NOW)!.text).toBe('Ends tomorrow');
    expect(endsLabel(local(3), NOW, 'en-GB')!.text).toMatch(/^Ends [A-Z][a-z]+day$/);
    expect(endsLabel(local(12), NOW, 'en-GB')!.text).toMatch(/^Ends \d{1,2} [A-Z][a-z]{2}/);
    expect(endsLabel(new Date(NOW - 1000).toISOString(), NOW)).toEqual({ text: 'Ended', soon: true });
    expect(endsLabel(null, NOW)).toBeNull();
    expect(startsLabel(local(1), NOW)).toBe('Free from tomorrow');
    expect(startsLabel(local(-1), NOW)).toBeNull();
  });
});
