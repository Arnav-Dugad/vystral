import type { Tour } from '../tours';

/** The 0.7.0 tour (3–6 cards). Each card names a feature key and may deep-link to it. */
export const tour: Omit<Tour, 'source'> = {
  version: '0.7.0',
  title: 'What’s new in VYSTRAL 0.7',
  subtitle: 'Find any game, a library tailored to your subscriptions, and a much deeper look at how you play. Your library, settings and history carried over.',
  cards: [
    {
      key: 'nav.discover',
      eyebrow: 'Discover',
      title: 'Find any game',
      body: 'Search Steam, Wikidata and, with your keys, IGDB and RAWG from Ctrl+K or the new Discover page. Games you don’t own get their own page with trailer, prices, time to beat and where to get them.',
      icon: 'sparkles',
      hue: 250,
      action: { label: 'Open Discover', to: { name: 'discover' } },
    },
    {
      key: 'settings.library.subscriptions',
      eyebrow: 'Subscriptions',
      title: 'Made for your subscriptions',
      body: 'Tell VYSTRAL which plans you have and it tailors itself: badges on included games, a Home row of games your plans include, “leaving soon” warnings and cloud play that only shows your services.',
      icon: 'badge',
      hue: 150,
      action: { label: 'Choose subscriptions', to: { name: 'settings', section: 'library' } },
    },
    {
      key: 'settings.library.steam-extras',
      eyebrow: 'Steam',
      title: 'Wishlist, news and your next achievement',
      body: 'Your Steam wishlist with lowest-ever prices, a News tab with patch notes since you last played, friends who played a game recently, and an achievement guide with a goal you can pin.',
      icon: 'trophy',
      hue: 200,
      action: { label: 'Steam extras', to: { name: 'settings', section: 'library' } },
    },
    {
      key: 'journal.insights',
      eyebrow: 'Journal',
      title: 'When and how you play',
      body: 'A heatmap of your week, how your genres drifted this year, an honest forecast of when you’ll finish, hardware changes next to your frame rates, and an optional energy estimate.',
      icon: 'activity',
      hue: 45,
      action: { label: 'Open the Journal', to: { name: 'journal' } },
    },
    {
      key: 'library.tools',
      eyebrow: 'Library',
      title: 'A library that looks after itself',
      body: 'Home tells you once when something breaks, game pages gain a Files tab for mods and saves, and the uninstall advisor shows what you’d lose before you remove a game.',
      icon: 'shield',
      hue: 165,
      action: { label: 'Library health', to: { name: 'health' } },
    },
    {
      key: 'speed',
      eyebrow: 'Everywhere',
      title: 'Faster, and a lot more alive',
      body: 'VYSTRAL now opens straight to your Home in under a second. Game pages dock their header as you scroll, Immersive’s screensaver plays trailers of games you’ve missed, and you can move its rows with the controller.',
      icon: 'rocket',
      hue: 300,
    },
  ],
};
