import { describe, expect, it } from 'vitest';
import type { ProviderHealthEntry, StreakSummary } from '../bridge/types';
import { cacheAgeLine, cacheCopy, cacheSizeLine, CACHE_COPY, totalBytes } from './caches';
import { healthSummary, providerStatusLabel, untilText } from './providerHealth';
import { streakHeadline, streakSentence, streakSub } from './streak';

const NOW = Date.parse('2026-10-10T12:00:00Z');

describe('cache viewer words', () => {
  it('describes every cache the backend lists', () => {
    for (const id of ['art', 'thumbs', 'trailers', 'news', 'prices', 'ai', 'discover', 'tags', 'friends', 'wishlist', 'catalogs', 'gamePages', 'lookups', 'fx', 'firstPaint']) {
      expect(CACHE_COPY[id], id).toBeDefined();
      expect(CACHE_COPY[id].after.length).toBeGreaterThan(10);
    }
    expect(cacheCopy('unknown').name).toBe('unknown');
  });

  it('says size, count and age plainly', () => {
    expect(cacheSizeLine({ bytes: 0, items: 0 })).toBe('Empty');
    expect(cacheSizeLine({ bytes: 1536, items: 1 })).toBe('1.5 KB · 1 file');
    expect(cacheSizeLine({ bytes: 5 * 1024 * 1024, items: 412 }, true)).toBe('5.0 MB · 412 entries');
    expect(cacheAgeLine({ newest: null, oldest: null }, NOW)).toBeNull();
    expect(cacheAgeLine({ newest: '2026-10-10T10:00:00Z', oldest: '2026-10-10T09:00:00Z' }, NOW)).toBe('Updated 2 hours ago');
    expect(cacheAgeLine({ newest: '2026-10-10T10:00:00Z', oldest: '2026-09-10T09:00:00Z' }, NOW)).toMatch(/^Updated 2 hours ago · oldest from /);
    expect(totalBytes([{ bytes: 5 }, { bytes: -1 }, { bytes: 10 }])).toBe(15);
  });
});

const p = (over: Partial<ProviderHealthEntry>): ProviderHealthEntry => ({
  id: 'x', name: 'X', group: 'G', logo: null, purpose: '', enabled: true, optIn: false, disabledReason: null, state: 'ok', lastSuccess: null, lastError: null,
  lastErrorText: null, backoffUntil: null, backoffReason: null, requestsToday: 0, cacheUpdated: null, ...over,
});

describe('data sources health', () => {
  it('sums up what’s on, off, paused and in trouble', () => {
    const s = healthSummary([p({ requestsToday: 3 }), p({ state: 'error', requestsToday: 2 }), p({ state: 'backoff' }), p({ enabled: false, state: 'off' })]);
    expect(s).toEqual({ on: 3, off: 1, attention: 1, paused: 1, requests: 5 });
  });

  it('labels each state in plain words', () => {
    expect(providerStatusLabel({ state: 'ok', enabled: true })).toBe('Working');
    expect(providerStatusLabel({ state: 'error', enabled: true })).toBe('Problem');
    expect(providerStatusLabel({ state: 'backoff', enabled: true })).toBe('Paused');
    expect(providerStatusLabel({ state: 'idle', enabled: true })).toBe('Not used yet');
    expect(providerStatusLabel({ state: 'ok', enabled: false })).toBe('Off');
  });

  it('counts down a pause', () => {
    expect(untilText(new Date(NOW + 9 * 60_000).toISOString(), NOW)).toBe('for 9 more minutes');
    expect(untilText(new Date(NOW + 20_000).toISOString(), NOW)).toBe('ending now');
    expect(untilText(new Date(NOW + 3 * 3_600_000).toISOString(), NOW)).toBe('for about 3 more hours');
    expect(untilText('nope', NOW)).toBe('');
  });
});

const streak = (over: Partial<StreakSummary>): StreakSummary => ({
  days: 42, since: '2026-08-29', sinceHistoryBegan: false, startsCounted: 118, failedStarts: 1, unexpectedCloses: 1, lastIncident: null, incidents: [], recent: [], ...over,
});

describe('crash-free streak words', () => {
  it('says how long, and where the number comes from', () => {
    expect(streakSentence(streak({}))).toBe('42 days without a failed start');
    expect(streakSentence(streak({ days: 1 }))).toBe('1 day without a failed start');
    expect(streakSub(streak({}))).toMatch(/^The last failed start was on .+\. 118 starts recorded, 1 unexpected close\.$/);
    expect(streakSub(streak({ sinceHistoryBegan: true, unexpectedCloses: 0, failedStarts: 0 }))).toMatch(/^Every start since VYSTRAL began keeping count on .+ reached a working window\. 118 starts recorded\.$/);
  });

  it('is honest on day one', () => {
    expect(streakHeadline(streak({ startsCounted: 0, days: 0 }))).toBe('Counting starts from today');
    expect(streakHeadline(streak({ days: 0, failedStarts: 1 }))).toBe('A start failed today');
    expect(streakHeadline(streak({ days: 0, failedStarts: 0, sinceHistoryBegan: true }))).toBe('No failed starts so far');
  });
});
