import { describe, expect, it } from 'vitest';
import { clip, highlightsOf, parseChangelog, plain } from './changelog';
import { BADGE_LIFETIME, NEW_FEATURES, featuresSeenOn, isBadgeVisible, visibleWithPrefix, type NewFeature } from './badges';
import { CURATED, MAX_CARDS, selectTour, tourFromChangelog, type Tour } from './tours';
import { RELEASES } from './releases';
import { compareVersions, featureReleasesBetween } from './version';

const SAMPLE = `# Changelog

All notable changes.

## [0.4.1] — 2026-10-20

### Fixed
- **Crash on start.** Fixed.

## [0.4.0] — 2026-10-12

Your library carries over.

### Library
- **Network health:** see what's reachable, with the
  actual reason.
- A plain item without a lead.
- **Badges** mark [new things](https://example.com) and \`code\`.

### Fixed
- **Something broke.** Not tour material.

## 0.3.0 — 2026-10-05

### Windows
- **Windows accent colour** is now one of the accent choices.
`;

describe('changelog parsing', () => {
  const releases = parseChangelog(SAMPLE);

  it('reads every release with its date, intro and sections', () => {
    expect(releases.map((r) => r.version)).toEqual(['0.4.1', '0.4.0', '0.3.0']);
    expect(releases[1].date).toBe('2026-10-12');
    expect(releases[1].intro).toBe('Your library carries over.');
    expect(releases[1].sections.map((s) => s.title)).toEqual(['Library', 'Fixed']);
  });

  it('splits bold leads from text and joins continuation lines', () => {
    const items = releases[1].sections[0].items;
    expect(items[0]).toEqual({ lead: 'Network health', text: "see what's reachable, with the actual reason." });
    expect(items[1]).toEqual({ lead: null, text: 'A plain item without a lead.' });
    expect(items[2]).toEqual({ lead: 'Badges', text: 'mark new things and code.' });
  });

  it('turns tour-worthy items into highlights, skipping fixes', () => {
    expect(highlightsOf(releases[1]).map((h) => h.title)).toEqual(['Network health', 'Badges']);
    expect(highlightsOf(releases[0])).toEqual([]);
  });

  it('strips markdown and clips at sentence boundaries', () => {
    expect(plain('**a** [b](c) `d` *e*')).toBe('a b d e');
    expect(clip('One. Two is longer. Three.', 12)).toBe('One.');
    expect(clip('a'.repeat(5) + ' ' + 'b'.repeat(300), 20)).toBe('aaaaa…');
  });

  it('parses the real CHANGELOG.md at build time', () => {
    expect(RELEASES.length).toBeGreaterThan(3);
    const v030 = RELEASES.find((r) => r.version === '0.3.0')!;
    expect(v030.sections.some((s) => s.title === 'Library')).toBe(true);
    expect(highlightsOf(v030).length).toBeGreaterThanOrEqual(3);
    for (const r of RELEASES) expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('versions', () => {
  it('compares semantically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0);
    expect(featureReleasesBetween('0.3.0', '0.4.7')).toBe(1);
    expect(featureReleasesBetween('0.9.0', '1.0.0')).toBe(1000 - 9);
  });
});

describe('"New" badges', () => {
  const f: NewFeature = { key: 'settings.privacy.network-health', since: '0.4.0' };
  const ctx = (current: string, firstVersion: string | null = null, seen: string[] = []) => ({ current, firstVersion, seen: new Set(seen) });

  it('shows for people who started before the feature, until seen', () => {
    expect(isBadgeVisible(f, ctx('0.4.0'))).toBe(true);
    expect(isBadgeVisible(f, ctx('0.4.2', '0.3.1'))).toBe(true);
    expect(isBadgeVisible(f, ctx('0.4.0', null, [f.key]))).toBe(false);
  });

  it('never shows on an install that started with (or after) the feature', () => {
    expect(isBadgeVisible(f, ctx('0.4.0', '0.4.0'))).toBe(false);
    expect(isBadgeVisible(f, ctx('0.5.0', '0.4.1'))).toBe(false);
  });

  it(`expires by itself ${BADGE_LIFETIME} feature releases later`, () => {
    expect(isBadgeVisible(f, ctx('0.5.3'))).toBe(true);
    expect(isBadgeVisible(f, ctx('0.6.0'))).toBe(false);
    expect(isBadgeVisible(f, ctx('0.3.9'))).toBe(false); // not in this version yet
  });

  it('ignores unknown keys and a missing version', () => {
    expect(isBadgeVisible(undefined, ctx('0.4.0'))).toBe(false);
    expect(isBadgeVisible(f, { current: null, firstVersion: null, seen: new Set() })).toBe(false);
  });

  it('marks route-based badges seen on visit', () => {
    expect(featuresSeenOn({ name: 'journal' })).toContain('nav.journal');
    expect(featuresSeenOn({ name: 'journal' })).not.toContain('journal.achievements');
    expect(featuresSeenOn({ name: 'journal', tab: 'achievements' })).toEqual(expect.arrayContaining(['nav.journal', 'journal.achievements']));
    expect(featuresSeenOn({ name: 'home' })).toEqual([]);
  });

  it('lights a settings section while any of its rows is new', () => {
    expect(visibleWithPrefix('settings.appearance.', ctx('0.4.0'))).toEqual(['settings.appearance.windows-accent', 'settings.appearance.follow-trailer']);
    expect(visibleWithPrefix('settings.appearance.', ctx('0.4.0', null, ['settings.appearance.windows-accent', 'settings.appearance.follow-trailer']))).toEqual([]);
  });

  it('has a valid, unique manifest the native side accepts', () => {
    const keys = NEW_FEATURES.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const x of NEW_FEATURES) {
      expect(x.key).toMatch(/^[a-z0-9][a-z0-9.-]{0,63}$/);
      expect(x.since).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('"What\'s new" selection', () => {
  const releases = parseChangelog(SAMPLE);
  const curated: Tour[] = [{ version: '0.4.0', title: 'Curated', source: 'curated', cards: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, eyebrow: 'e', title: `t${i}`, body: 'b' })) }];
  const base = { onboardingCompleted: true, curated, releases };

  it('shows once after an update: the newest tour since the last seen version, curated first', () => {
    const t = selectTour({ ...base, current: '0.4.0', lastSeen: '0.3.1' })!;
    expect(t.title).toBe('Curated');
    expect(t.cards).toHaveLength(MAX_CARDS);
    expect(selectTour({ ...base, current: '0.4.0', lastSeen: '0.4.0' })).toBeNull();
  });

  it('never on a fresh install (onboarding covers it)', () => {
    expect(selectTour({ ...base, current: '0.4.0', lastSeen: null, onboardingCompleted: false })).toBeNull();
  });

  it('falls back to the changelog, and to the newest version with highlights', () => {
    const t = selectTour({ ...base, curated: [], current: '0.4.1', lastSeen: '0.3.1' })!;
    expect(t.source).toBe('changelog');
    expect(t.version).toBe('0.4.0'); // 0.4.1 is fixes only
    expect(t.cards.map((c) => c.title)).toEqual(['Network health', 'Badges']);
    expect(selectTour({ ...base, curated: [], current: '0.4.1', lastSeen: '0.4.0' })).toBeNull();
  });

  it('an existing user without a recorded version gets the current tour', () => {
    expect(selectTour({ ...base, current: '0.4.0', lastSeen: null })!.version).toBe('0.4.0');
  });

  it('manual opening shows the newest tour even when seen, never a future one', () => {
    expect(selectTour({ ...base, current: '0.4.1', lastSeen: '0.4.1', manual: true })!.version).toBe('0.4.0');
    expect(selectTour({ ...base, current: '0.3.0', lastSeen: '0.3.0', manual: true })!.version).toBe('0.3.0');
  });

  it('builds changelog cards with an icon and hue', () => {
    const t = tourFromChangelog(releases[2])!;
    expect(t.cards[0]).toMatchObject({ eyebrow: 'Windows', title: 'Windows accent colour', icon: 'sparkles' });
  });

  it('ships a curated 0.4.0 tour of 3–6 cards with valid deep links', () => {
    const t = CURATED.find((x) => x.version === '0.4.0')!;
    expect(t.cards.length).toBeGreaterThanOrEqual(3);
    expect(t.cards.length).toBeLessThanOrEqual(MAX_CARDS);
    for (const c of t.cards) if (c.action && c.action.to !== 'updates') expect(typeof c.action.to.name).toBe('string');
  });
});
