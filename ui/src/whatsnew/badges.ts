import type { Route } from '../state/store';
import { compareVersions, featureReleasesBetween } from './version';

/**
 * "New" badge manifest. Each entry is a feature key, the version that introduced it, and
 * optionally the page whose visit counts as "seen". Components render <NewBadge k="…" />;
 * a badge shows only while:
 *   - the feature exists in this version,
 *   - this PC started on an older version than the feature (new installs see no badges),
 *   - fewer than BADGE_LIFETIME feature releases have passed since (0.3.x badges end with 0.5.0),
 *   - and the user hasn't seen it yet (persisted in the data folder, see WhatsNewStore).
 *
 * Key naming: lowercase, dot-separated, kebab-case words: `nav.<route>`, `settings.<section>.<row>`,
 * `<view>.<thing>`. `nav.<route>` keys light up the sidebar item automatically, and any
 * `settings.<section>.*` key lights up that section in the Settings navigation.
 */
export interface NewFeature {
  key: string;
  since: string;
  /** Visiting a route that matches every given field marks the badge seen. */
  seenOn?: Partial<Route> & { name: Route['name'] };
}

export const BADGE_LIFETIME = 2;

export const NEW_FEATURES: NewFeature[] = [
  // 0.3.0
  { key: 'nav.journal', since: '0.3.0', seenOn: { name: 'journal' } }, // play calendar, achievements tab
  { key: 'journal.achievements', since: '0.3.0', seenOn: { name: 'journal', tab: 'achievements' } },
  { key: 'settings.appearance.windows-accent', since: '0.3.0' },
  { key: 'settings.appearance.follow-trailer', since: '0.3.0' },
  { key: 'settings.launching.background-apps', since: '0.3.0' },
  // 0.4.0
  { key: 'settings.privacy.network-health', since: '0.4.0' },
  { key: 'settings.about.whats-new', since: '0.4.0' },
  { key: 'settings.launching.background-tracking', since: '0.4.0' },
  { key: 'settings.library.data-sources', since: '0.4.0' },
  { key: 'settings.appearance.live-tiles', since: '0.4.0' },
  { key: 'settings.controller.ambient-sound', since: '0.4.0' },
  { key: 'journal.value', since: '0.4.0', seenOn: { name: 'journal', tab: 'value' } },
  // 0.5.0
  { key: 'settings.controller.immersive', since: '0.5.0' },
  { key: 'settings.library.art-packs', since: '0.5.0' },
  { key: 'settings.library.time-to-beat', since: '0.5.0' },
  { key: 'settings.launching.anti-cheat-notes', since: '0.5.0' },
  // 0.6.0
  { key: 'settings.cloud.play', since: '0.6.0' },
  { key: 'settings.library.friends', since: '0.6.0' },
  { key: 'settings.library.health', since: '0.6.0' },
  { key: 'settings.controller.voiceover', since: '0.6.0' },
  { key: 'settings.controller.keyboard', since: '0.6.0' },
  { key: 'library.health', since: '0.6.0', seenOn: { name: 'health' } },
  // 0.7.0
  { key: 'nav.discover', since: '0.7.0', seenOn: { name: 'discover' } },
  { key: 'settings.library.subscriptions', since: '0.7.0' },
  { key: 'settings.library.steam-extras', since: '0.7.0' },
  { key: 'journal.insights', since: '0.7.0', seenOn: { name: 'journal' } },
];

const BY_KEY = new Map(NEW_FEATURES.map((f) => [f.key, f]));

export function featureFor(key: string): NewFeature | undefined {
  return BY_KEY.get(key);
}

export interface BadgeContext {
  current: string | null;
  /** The version this PC started with; null = installed before VYSTRAL tracked it (an existing user). */
  firstVersion: string | null;
  seen: ReadonlySet<string>;
}

export function isBadgeVisible(f: NewFeature | undefined, c: BadgeContext): boolean {
  if (!f || !c.current) return false;
  if (c.seen.has(f.key)) return false;
  if (compareVersions(c.current, f.since) < 0) return false;
  if (c.firstVersion && compareVersions(c.firstVersion, f.since) >= 0) return false;
  return featureReleasesBetween(f.since, c.current) < BADGE_LIFETIME;
}

/** Features whose `seenOn` matches this route. */
export function featuresSeenOn(route: Route, features: NewFeature[] = NEW_FEATURES): string[] {
  return features
    .filter((f) => f.seenOn && Object.entries(f.seenOn).every(([k, v]) => (route as unknown as Record<string, unknown>)[k] === v))
    .map((f) => f.key);
}

export function visibleWithPrefix(prefix: string, c: BadgeContext, features: NewFeature[] = NEW_FEATURES): string[] {
  return features.filter((f) => f.key.startsWith(prefix) && isBadgeVisible(f, c)).map((f) => f.key);
}
