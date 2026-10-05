import type { Tour } from '../tours';

/**
 * The 0.4.0 tour. 3–6 cards; each card names a feature key (its "New" badge key when it has one)
 * and may deep-link to it.
 */
export const tour: Omit<Tour, 'source'> = {
  version: '0.4.0',
  title: 'What’s new in VYSTRAL 0.4',
  subtitle: 'A few things worth a look. Your library, settings and history carried over.',
  cards: [
    {
      key: 'settings.launching.background-tracking',
      eyebrow: 'Playing',
      title: 'Tracked wherever you launch',
      body: 'Start a game from Steam, a desktop shortcut or anywhere else and VYSTRAL still records the session. Turn on background tracking and it keeps counting even while VYSTRAL is closed — a tiny helper, off until you choose.',
      icon: 'activity',
      hue: 160,
      action: { label: 'Set it up', to: { name: 'settings', section: 'launching' } },
    },
    {
      key: 'settings.library.data-sources',
      eyebrow: 'Library',
      title: 'Art and details, your way',
      body: 'Pick alternate covers, heroes and logos from SteamGridDB, fill in details from IGDB or RAWG, and see deals from CheapShark and IsThereAnyDeal. Keys are your own and stay in Windows Credential Manager.',
      icon: 'palette',
      hue: 285,
      action: { label: 'Open data sources', to: { name: 'settings', section: 'library' } },
    },
    {
      key: 'settings.appearance.live-tiles',
      eyebrow: 'Home',
      title: 'Real store logos and live tiles',
      body: 'Every store is shown with its own logo, and covers on Home quietly play Steam’s short silent clips while they’re on screen — never on a metered connection or while you play.',
      icon: 'sparkles',
      hue: 220,
      action: { label: 'Go Home', to: { name: 'home' } },
    },
    {
      key: 'detail.compat',
      eyebrow: 'Game pages',
      title: 'Deck, anti-cheat and deals at a glance',
      body: 'Game pages now show Steam Deck compatibility, which anti-cheat a game uses, the best current price, and the same game’s IDs on other stores.',
      icon: 'shield',
      hue: 45,
    },
    {
      key: 'journal.value',
      eyebrow: 'Journal',
      title: 'Your library over time',
      body: 'See when games joined your library and what it’s worth at today’s prices, plus a shelf of games you own but have never played.',
      icon: 'calendar',
      hue: 120,
      action: { label: 'Open Library value', to: { name: 'journal', tab: 'value' } },
    },
    {
      key: 'update.rollback',
      eyebrow: 'Updates',
      title: 'Updates that undo themselves',
      body: 'If a new version ever fails to start twice in a row, VYSTRAL goes back to the one that worked and tells you why. Settings › Privacy › Network health shows exactly which servers answer from your network.',
      icon: 'undo',
      hue: 330,
      action: { label: 'Open Network health', to: { name: 'settings', section: 'privacy' } },
    },
  ],
};
