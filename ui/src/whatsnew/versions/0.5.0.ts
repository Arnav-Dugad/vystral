import type { Tour } from '../tours';

/** The 0.5.0 tour (3–6 cards). Each card names a feature key and may deep-link to it. */
export const tour: Omit<Tour, 'source'> = {
  version: '0.5.0',
  title: 'What’s new in VYSTRAL 0.5',
  subtitle: 'Immersive Mode, rebuilt — and a lot of care everywhere else. Your library, settings and history carried over.',
  cards: [
    {
      key: 'immersive.switch',
      eyebrow: 'Immersive Mode',
      title: 'Step into the big screen',
      body: 'Press F11 or the Menu button: the interface folds away, your game fills the screen and Immersive Mode rises in around it. A radial quick menu, a game page with tabs, a live system bar and couch-friendly text sizes come with it.',
      icon: 'gamepad',
      hue: 285,
      action: { label: 'Immersive settings', to: { name: 'settings', section: 'controller' } },
    },
    {
      key: 'home.away',
      eyebrow: 'Home',
      title: 'While you were away',
      body: 'Games you played without opening VYSTRAL get a summary on Home, and any session can be replayed as a short card you can save or copy as an image.',
      icon: 'activity',
      hue: 160,
      action: { label: 'Go Home', to: { name: 'home' } },
    },
    {
      key: 'settings.library.art-packs',
      eyebrow: 'Library',
      title: 'Art packs',
      body: 'Give your whole library one look from SteamGridDB in a single step — previewed first, never touching art you picked yourself, and fully undoable.',
      icon: 'palette',
      hue: 220,
      action: { label: 'Open Art packs', to: { name: 'settings', section: 'library' } },
    },
    {
      key: 'journal.value',
      eyebrow: 'Journal',
      title: 'Sales and time to beat',
      body: 'Library value shows the next Steam sale Valve has announced and what your backlog could cost at past lows. With IGDB connected, cards show how far you are through a game.',
      icon: 'calendar',
      hue: 120,
      action: { label: 'Open Library value', to: { name: 'journal', tab: 'value' } },
    },
    {
      key: 'perf.lighter',
      eyebrow: 'Performance',
      title: 'Lighter than ever while you play',
      body: 'Recording a session now costs about 0.06% of one CPU core instead of several percent, and VYSTRAL no longer counts time your PC spent asleep.',
      icon: 'rocket',
      hue: 45,
    },
    {
      key: 'quality',
      eyebrow: 'Everywhere',
      title: 'Hundreds of fixes',
      body: 'A full audit fixed launch races, lost notes, merging duplicates, focus rings, light-theme contrast and much more. Thank you for every report.',
      icon: 'shield',
      hue: 330,
    },
  ],
};
