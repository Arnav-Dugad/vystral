import type { Tour } from '../tours';

/** The 0.6.0 tour (3–6 cards). Each card names a feature key and may deep-link to it. */
export const tour: Omit<Tour, 'source'> = {
  version: '0.6.0',
  title: 'What’s new in VYSTRAL 0.6',
  subtitle: 'Cloud play, friends, a library check-up and a much smarter couch. Your library, settings and history carried over.',
  cards: [
    {
      key: 'settings.cloud.play',
      eyebrow: 'Cloud play',
      title: 'Play in the cloud',
      body: 'Turn it on and games you own that GeForce NOW or Xbox Cloud Gaming can stream get a cloud button that opens the official app or site, plus an hours-left meter for your GeForce NOW plan.',
      icon: 'rocket',
      hue: 140,
      action: { label: 'Set up cloud play', to: { name: 'settings', section: 'cloud' } },
    },
    {
      key: 'settings.library.friends',
      eyebrow: 'Home',
      title: 'See who’s playing',
      body: 'With your Steam Web API key, Home shows which friends are in a game right now, grouped by game. It’s off until you turn it on and reads only their public status.',
      icon: 'activity',
      hue: 200,
      action: { label: 'Turn it on', to: { name: 'settings', section: 'library' } },
    },
    {
      key: 'library.health',
      eyebrow: 'Library',
      title: 'Give your library a check-up',
      body: 'Library health finds games that can’t start, unplugged drives, duplicates and blurry covers, and fixes the safe ones in one go. Game pages also gain a Controls tab with the Steam Input layout, and VYSTRAL warns you before a Steam update won’t fit.',
      icon: 'shield',
      hue: 165,
      action: { label: 'Check my library', to: { name: 'health' } },
    },
    {
      key: 'settings.controller.voiceover',
      eyebrow: 'Immersive Mode',
      title: 'A smarter couch',
      body: 'A guide on the Menu button, Now playing and Downloads rows, letter jumps in All games, crisp button icons for Xbox, PlayStation and Nintendo pads, and optional voice-over with captions using Windows’ own voices.',
      icon: 'gamepad',
      hue: 285,
      action: { label: 'Voice-over and buttons', to: { name: 'settings', section: 'controller' } },
    },
    {
      key: 'settings.controller.keyboard',
      eyebrow: 'Controller',
      title: 'Type with your controller',
      body: 'Press A on any text box in desktop mode and a full keyboard slides up: number pads for numbers, hidden passwords, and suggestions from your library.',
      icon: 'badge',
      hue: 45,
      action: { label: 'Keyboard settings', to: { name: 'settings', section: 'controller' } },
    },
    {
      key: 'logos',
      eyebrow: 'Everywhere',
      title: 'The real Xbox logo, and more',
      body: 'Xbox games now wear the Xbox sphere, and data sources, Steam Deck, GPU makers and store buttons show their logos too.',
      icon: 'palette',
      hue: 330,
    },
  ],
};
