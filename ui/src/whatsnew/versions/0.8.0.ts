import type { Tour } from '../tours';

/** The 0.8.0 tour (3–6 cards). Each card names a feature key and may deep-link to it. */
export const tour: Omit<Tour, 'source'> = {
  version: '0.8.0',
  title: 'What’s new in VYSTRAL 0.8',
  subtitle: 'Game pages that tell the whole story, a Discover storefront, your own AI, and a rebuilt Performance page. Your library, settings and history carried over.',
  cards: [
    {
      key: 'game.glance',
      eyebrow: 'Game pages',
      title: 'Every game at a glance',
      body: 'Playtime against time to beat, your weekly sessions, achievements, Steam reviews with their trend, ratings, price history in your currency, the whole series on a timeline, and the tags players use — each with its source.',
      icon: 'sparkles',
      hue: 250,
    },
    {
      key: 'nav.discover.storefront',
      eyebrow: 'Discover',
      title: 'Find your next game',
      body: 'Discover now opens with picks for you, games like the ones you play, wishlist games on sale and genre browsing. Wishlist games open their own pages. In Immersive Mode, Discover works with your controller too.',
      icon: 'rocket',
      hue: 200,
      action: { label: 'Open Discover', to: { name: 'discover' } },
    },
    {
      key: 'settings.ai.cloud',
      eyebrow: 'AI',
      title: 'Bring your own AI',
      body: 'Use Claude, ChatGPT, Gemini or local AI to ask your Journal anything, pick a game for tonight, build smart collections from a sentence and summarise patch notes. Off until you turn it on; keys stay in Windows Credential Manager.',
      icon: 'badge',
      hue: 285,
      action: { label: 'Set up AI', to: { name: 'settings', section: 'ai' } },
    },
    {
      key: 'perf.redesign',
      eyebrow: 'Performance',
      title: 'Performance, at a glance',
      body: 'Your rig, how your last sessions played and your frame-rate trend up top, then Overview, Sessions, Compare and System — with every sharp frame drop marked.',
      icon: 'activity',
      hue: 45,
      action: { label: 'Open Performance', to: { name: 'performance' } },
    },
    {
      key: 'journal.records',
      eyebrow: 'Journal',
      title: 'Your personal records',
      body: 'Nine collectible badges for your longest sessions, biggest days and weeks, streaks, late nights and comebacks — and a quiet toast when you beat one.',
      icon: 'trophy',
      hue: 120,
      action: { label: 'See your records', to: { name: 'journal', tab: 'records' } },
    },
    {
      key: 'library.correct',
      eyebrow: 'Library',
      title: 'A more accurate library',
      body: 'Refunded Steam games leave your library (their history is kept), Xbox games show their size, publisher and an estimated last played, and the title bar never hides your buttons.',
      icon: 'shield',
      hue: 165,
      action: { label: 'Open Storage', to: { name: 'storage' } },
    },
  ],
};
