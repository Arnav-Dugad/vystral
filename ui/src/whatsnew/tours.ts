import type { Route } from '../state/store';
import type { ChangelogRelease } from './changelog';
import { highlightsOf } from './changelog';
import { compareVersions } from './version';

/** Illustration for a card: a Lucide icon on an animated gradient of the given hue (0–360). */
export type TourIcon =
  | 'sparkles' | 'rocket' | 'undo' | 'activity' | 'badge' | 'calendar' | 'trophy' | 'hard-drive' | 'gamepad' | 'palette' | 'bell' | 'shield';

export interface TourCard {
  /** A feature key (often the same as its "New" badge key). */
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  icon?: TourIcon;
  hue?: number;
  /** Deep link to the feature: a page, or the update centre. */
  action?: { label: string; to: Route | 'updates' };
}

export interface Tour {
  version: string;
  title: string;
  subtitle?: string;
  cards: TourCard[];
  /** 'curated' from ui/src/whatsnew/versions/<version>.ts, or built from CHANGELOG.md. */
  source: 'curated' | 'changelog';
}

export const MAX_CARDS = 6;

/**
 * Curated tours, one file per version in ./versions (e.g. versions/0.4.0.ts exporting `tour`).
 * When a version has none, its CHANGELOG.md section is used instead (bold-lead items).
 */
const modules = import.meta.glob<{ tour: Omit<Tour, 'source'> }>('./versions/*.ts', { eager: true });
export const CURATED: Tour[] = Object.values(modules).map((m) => ({ ...m.tour, source: 'curated' as const }));

const FALLBACK_ICONS: TourIcon[] = ['sparkles', 'rocket', 'activity', 'gamepad', 'palette', 'bell'];

export function tourFromChangelog(release: ChangelogRelease): Tour | null {
  const highlights = highlightsOf(release, MAX_CARDS - 1);
  if (highlights.length === 0) return null;
  return {
    version: release.version,
    title: `What’s new in VYSTRAL ${release.version}`,
    subtitle: release.intro || undefined,
    source: 'changelog',
    cards: highlights.map((h, i) => ({
      key: `changelog.${release.version}.${i}`,
      eyebrow: h.eyebrow,
      title: h.title,
      body: h.body,
      icon: FALLBACK_ICONS[i % FALLBACK_ICONS.length],
      hue: (285 + i * 47) % 360,
    })),
  };
}

export interface TourSelection {
  current: string | null;
  lastSeen: string | null;
  onboardingCompleted: boolean;
  curated?: Tour[];
  releases: ChangelogRelease[];
  /** Opened from About/Updates: show the newest tour up to this version, even if seen. */
  manual?: boolean;
}

/**
 * Which tour to show at start-up, if any. Never on a fresh install (onboarding covers that),
 * never for a version already seen; otherwise the newest tour in (lastSeen, current], curated
 * first. Skipping several versions shows the newest one's tour.
 */
export function selectTour(s: TourSelection): Tour | null {
  const { current } = s;
  if (!current) return null;
  if (!s.manual) {
    if (!s.onboardingCompleted) return null;
    if (s.lastSeen && compareVersions(s.lastSeen, current) >= 0) return null;
  }
  const inRange = (v: string) => compareVersions(v, current) <= 0 && (s.manual || !s.lastSeen || compareVersions(v, s.lastSeen) > 0);
  const curated = (s.curated ?? CURATED).filter((t) => inRange(t.version) && t.cards.length > 0);
  const fromLog = s.releases.filter((r) => inRange(r.version)).map(tourFromChangelog).filter((t): t is Tour => t !== null);
  const all = [...curated, ...fromLog].sort((a, b) => compareVersions(b.version, a.version) || (a.source === 'curated' ? -1 : 1));
  const pick = all[0];
  return pick ? { ...pick, cards: pick.cards.slice(0, MAX_CARDS) } : null;
}
