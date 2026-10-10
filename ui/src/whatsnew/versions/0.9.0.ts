import type { Tour } from '../tours';

/** The 0.9.0 tour (3–6 cards). Each card names a feature key and may deep-link to it. */
export const tour: Omit<Tour, 'source'> = {
  version: '0.9.0',
  title: 'What’s new in VYSTRAL 0.9',
  subtitle: 'One Assistant everywhere, every game fully filled in, your wishlist as a calendar, and much more. Your library, settings and history carried over.',
  cards: [
    {
      key: 'assistant.everywhere',
      eyebrow: 'Assistant',
      title: 'One Assistant, on every page',
      body: 'Press Ctrl+J anywhere to ask about your games with Claude, ChatGPT, Gemini or local AI. It can look across the whole app, asks before sharing, and never changes anything until you confirm.',
      icon: 'sparkles',
      hue: 285,
      action: { label: 'Open the Assistant', to: { name: 'assistant' } },
    },
    {
      key: 'games.everySource',
      eyebrow: 'Every game',
      title: 'Every game, fully filled in',
      body: 'Xbox, Epic, GOG and other games now get Steam reviews, tags, trailers, prices and news through their matched Steam page — always labelled, and you can fix a match.',
      icon: 'rocket',
      hue: 200,
    },
    {
      key: 'wishlist.calendar',
      eyebrow: 'Wishlist',
      title: 'Your wishlist, as a calendar',
      body: 'Release days with their covers, sales and lowest-ever prices on the day, and honest lanes for “2027” or “To be announced”. Every poster now shows.',
      icon: 'calendar',
      hue: 45,
      action: { label: 'Open the Wishlist', to: { name: 'wishlist' } },
    },
    {
      key: 'picks.v2',
      eyebrow: 'For you',
      title: 'Picks that explain themselves',
      body: 'One recommendation engine for Home, Discover and Immersive says why for every pick and learns from “Not interested”. Plus Free this week, Play in the cloud and Similar in your library.',
      icon: 'activity',
      hue: 150,
      action: { label: 'Go Home', to: { name: 'home' } },
    },
    {
      key: 'library.bulk',
      eyebrow: 'Library',
      title: 'Change many games at once',
      body: 'Select games to set their status, collection or visibility together, with one Undo. Game pages gain an updates, mods and sessions timeline, and Records gains eleven badges.',
      icon: 'badge',
      hue: 330,
      action: { label: 'Open the Library', to: { name: 'library' } },
    },
    {
      key: 'settings.polish',
      eyebrow: 'Settings',
      title: 'Your currency, and every setting at hand',
      body: 'Every price in your currency, search that jumps straight to a setting, a Data sources health page, a cache viewer and your crash-free streak.',
      icon: 'shield',
      hue: 220,
      action: { label: 'Open Settings', to: { name: 'settings', section: 'appearance' } },
    },
  ],
};
