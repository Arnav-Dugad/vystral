import { describe, expect, it } from 'vitest';
import type { Game, ResolvedId, ResolvedIdentity } from '../bridge/types';
import { confidencePercent, identitySummary, matchedVia, steamDataLabel, steamLinkOf } from './identity';

const steamId = (over: Partial<ResolvedId> = {}): ResolvedId => ({
  kind: 'steam', label: 'Steam', value: '1145360', confidence: 0.9775, level: 'high', status: 'matched', used: true, name: 'Hades', link: true,
  evidence: [{ source: 'steam', method: 'exactTitleYear', confidence: 0.85 }, { source: 'wikidata', method: 'exactTitleYear', confidence: 0.85 }],
  ...over,
});

const identity = (over: Partial<ResolvedIdentity> = {}): ResolvedIdentity => ({
  gameId: 'g', status: 'matched', steam: steamId(), ids: [steamId()], steamCandidates: [], asked: ['wikidata', 'steam'], checkedAt: null, canCheck: true, reason: null,
  ...over,
});

const xbox = { installations: [{ platform: 'xbox', platformGameId: 'Studio.Game' }] } as unknown as Game;
const steam = { installations: [{ platform: 'steam', platformGameId: '620' }] } as unknown as Game;

describe('identity words', () => {
  it('says how a match was made, one mention per source', () => {
    expect(matchedVia(steamId())).toBe('Matched via Steam store search (same title and year) and Wikidata (same title and year)');
    expect(matchedVia(steamId({ evidence: [{ source: 'wikidata', method: 'storeId', confidence: 0.95 }, { source: 'wikidata', method: 'exactTitle', confidence: 0.7 }] })))
      .toBe('Matched via Wikidata (a store ID link)');
    expect(matchedVia(steamId({ status: 'native' }))).toBe('From the store itself');
    expect(matchedVia(steamId({ status: 'pinned' }))).toBe('You chose this');
  });

  it('never claims 100% for a match', () => {
    expect(confidencePercent(steamId({ confidence: 0.999 }))).toBe('99%');
    expect(confidencePercent(steamId({ confidence: 0.85 }))).toBe('85%');
    expect(confidencePercent(steamId({ status: 'pinned', confidence: 1 }))).toBe('100%');
  });
});

describe('steamLinkOf', () => {
  it('uses a Steam game’s own app without asking', () => {
    expect(steamLinkOf(steam, null)).toEqual({ appId: '620', native: true, via: null, name: null });
    expect(steamDataLabel(steamLinkOf(steam, null))).toBeNull();
  });

  it('uses a matched or chosen app for other stores, labelled', () => {
    const matched = steamLinkOf(xbox, identity());
    expect(matched).toEqual({ appId: '1145360', native: false, via: 'matched', name: 'Hades' });
    expect(steamDataLabel(matched)).toBe('Steam data for “Hades” on Steam, matched automatically');
    const pinned = steamLinkOf(xbox, identity({ status: 'pinned', steam: steamId({ status: 'pinned', name: null }) }));
    expect(steamDataLabel(pinned)).toBe('Steam data for the Steam version, the version you chose');
  });

  it('shows no Steam data for suggestions, conflicts, “not on Steam” or nothing found', () => {
    for (const status of ['suggested', 'conflict', 'none', 'notOnSteam', 'notChecked'] as const)
      expect(steamLinkOf(xbox, identity({ status, steam: steamId({ used: false, status: status === 'conflict' ? 'conflict' : 'suggested' }) }))).toBeNull();
    expect(steamLinkOf(xbox, null)).toBeNull();
    expect(steamLinkOf(xbox, identity({ steam: steamId({ used: false }) }))).toBeNull();
  });

  it('has a plain sentence for every state', () => {
    for (const status of ['native', 'matched', 'pinned', 'notOnSteam', 'suggested', 'conflict', 'none', 'notChecked'] as const)
      expect(identitySummary(identity({ status })).length).toBeGreaterThan(10);
    expect(identitySummary(identity({ status: 'notChecked', reason: 'off' }))).toMatch(/turned off/);
  });
});
