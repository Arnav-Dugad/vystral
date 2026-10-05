import type { Tour } from '../tours';

/**
 * The 0.4.0 tour. 3–6 cards; each card names a feature key (its "New" badge key when it has one)
 * and may deep-link to it. Other v0.4 tracks add their cards here at merge.
 */
export const tour: Omit<Tour, 'source'> = {
  version: '0.4.0',
  title: 'What’s new in VYSTRAL 0.4',
  subtitle: 'A few things worth a look. Your library, settings and history carried over.',
  cards: [
    {
      key: 'settings.privacy.network-health',
      eyebrow: 'Privacy',
      title: 'Network health',
      body: 'See whether GitHub and Steam’s store, image and video servers answer from your network — and the actual reason when one doesn’t. Only when you ask; never in the background.',
      icon: 'activity',
      hue: 160,
      action: { label: 'Open Network health', to: { name: 'settings', section: 'privacy' } },
    },
    {
      key: 'update.rollback',
      eyebrow: 'Updates',
      title: 'Updates that undo themselves',
      body: 'If a new version ever fails to start twice in a row, VYSTRAL quietly goes back to the version that worked, tells you why, and skips that update until a fixed one is out.',
      icon: 'undo',
      hue: 285,
    },
    {
      key: 'update.pill',
      eyebrow: 'Updates',
      title: 'Clearer update status',
      body: 'The title bar shows when VYSTRAL is checking and when it last checked. If something goes wrong, you see the actual reason, not just “couldn’t update”.',
      icon: 'rocket',
      hue: 220,
      action: { label: 'Open updates', to: 'updates' },
    },
    {
      key: 'badges',
      eyebrow: 'Everywhere',
      title: 'New things, marked',
      body: 'A small dot marks features you haven’t tried yet. It disappears once you’ve had a look, and by itself two releases later.',
      icon: 'badge',
      hue: 45,
    },
  ],
};
