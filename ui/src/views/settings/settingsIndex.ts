/**
 * Track D6: the search index for Settings. One entry per row people look for: its section, the group it sits in, the
 * label exactly as shown (that's how the row is found on the page), a short hint and extra words people might type.
 * `row` is a stable id for deep links (`{ name: 'settings', section, row }`); rows that carry `data-row="…"` are found
 * by it, the rest by their visible label. `lib/settingsSearch.test.ts` checks every label still exists in the source,
 * so a renamed row fails a test instead of silently dropping out of search.
 *
 * Adding a row (other tracks): append `{ section, group, label, hint, keywords }` here; that's all.
 */
export interface SettingsEntry {
  section: string;
  /** The group heading the row sits under (shown in the path, and the fallback target when the row isn't on screen). */
  group: string;
  label: string;
  hint?: string;
  keywords?: string;
  /** Deep-link id; defaults to a slug of the label. */
  row?: string;
}

export const SETTINGS_INDEX: SettingsEntry[] = [
  // ---- Appearance ----
  { section: 'appearance', group: 'Theme', label: 'Theme', row: 'theme', hint: 'Obsidian, OLED black, Light or High contrast.', keywords: 'dark light oled black high contrast mode colours' },
  { section: 'appearance', group: 'Theme', label: 'Accent colour', hint: 'Follow the artwork, your Windows colour, or pick one.', keywords: 'accent color colour windows highlight' },
  { section: 'appearance', group: 'Currency', label: 'Show prices in', row: 'currency', hint: 'The currency every price in VYSTRAL is shown in.', keywords: 'currency money price prices rupee inr dollar usd euro eur pound gbp yen convert region' },
  { section: 'appearance', group: 'Currency', label: 'Exchange rates', row: 'exchange-rates', hint: 'Daily rates used to convert prices from other currencies.', keywords: 'currency conversion frankfurter ecb central bank rates update' },
  { section: 'appearance', group: 'Living Canvas', label: 'Living Canvas', hint: 'The animated background that takes on each game’s colours.', keywords: 'background animated canvas wallpaper mood' },
  { section: 'appearance', group: 'Living Canvas', label: 'Intensity', row: 'canvas-intensity', hint: 'How strong the Living Canvas is.', keywords: 'background strength brightness' },
  { section: 'appearance', group: 'Living Canvas', label: 'Follow trailer colours', hint: 'The background takes on a playing trailer’s colours.', keywords: 'trailer video colour background' },
  { section: 'appearance', group: 'Living Canvas', label: 'Visual quality', hint: 'Low turns off blur and animated backgrounds.', keywords: 'performance quality blur battery low high balanced' },
  { section: 'appearance', group: 'Motion', label: 'Reduce motion', hint: 'Swap movement for quick fades.', keywords: 'animation motion accessibility reduced fades' },
  { section: 'appearance', group: 'Motion', label: 'Play the startup animation', hint: 'The short intro when VYSTRAL starts.', keywords: 'intro splash startup animation' },
  { section: 'appearance', group: 'Home', label: 'Live tiles', hint: 'Silent trailer loops on Home.', keywords: 'home tiles video loops trailers' },

  // ---- Library & stores ----
  { section: 'library', group: 'Store integrations', label: 'Store integrations', row: 'stores', hint: 'Steam, Xbox, Epic, GOG, EA, Ubisoft and Battle.net on this PC.', keywords: 'steam xbox epic gog ea ubisoft battle.net stores scan rescan platforms launchers' },
  { section: 'library', group: 'Details and artwork', label: 'Look up game details online', hint: 'Genres, descriptions and artwork from Steam’s store pages.', keywords: 'metadata details descriptions genres online' },
  { section: 'library', group: 'Details and artwork', label: 'Download missing artwork', hint: 'Covers and backgrounds for games without art.', keywords: 'artwork covers images art download' },
  { section: 'library', group: 'Your subscriptions', label: 'Your subscriptions', row: 'subscriptions', hint: 'Game Pass, EA Play, Ubisoft+, Humble Choice, Prime Gaming, GeForce NOW.', keywords: 'subscriptions game pass ultimate premium essential ea play ubisoft+ humble prime gaming geforce now plans' },
  { section: 'library', group: 'Your subscriptions', label: 'Show what my plans include', hint: 'Badges and a filter for games your plans include.', keywords: 'game pass catalogue included lists' },
  { section: 'library', group: 'Your subscriptions', label: 'Tell me before a game leaves Game Pass', hint: 'A notification a few days before a game leaves.', keywords: 'leaving soon notification game pass' },
  { section: 'library', group: 'Your subscriptions', label: 'Cloud play: show every service', hint: 'Offer cloud services you don’t have too.', keywords: 'cloud streaming services' },
  { section: 'library', group: 'Your subscriptions', label: 'What you pay a month (optional)', row: 'subs-price', hint: 'For cost per hour on Home.', keywords: 'price cost per hour monthly subscription money currency value' },
  { section: 'library', group: 'Library health', label: 'Health check', hint: 'Broken shortcuts, missing drives, duplicates and more.', keywords: 'health broken missing duplicates fix problems' },
  { section: 'library', group: 'Library health', label: 'Tell me on Home when something new needs a look', hint: 'A card on Home when the health check finds something new.', keywords: 'health home notice' },
  { section: 'library', group: 'Steam Web API', label: 'Paste the key and connect', row: 'steam-web-api', hint: 'Owned games, achievements and more with your own free key.', keywords: 'steam web api key account owned games achievements connect' },
  { section: 'library', group: 'Steam Web API', label: 'Refresh achievements in the background', hint: 'Keeps achievements up to date.', keywords: 'achievements steam background' },
  { section: 'library', group: 'Steam Web API', label: 'Friends playing now on Home', hint: 'Which Steam friends are playing, on Home.', keywords: 'friends steam online playing' },
  { section: 'library', group: 'Steam extras', label: 'Wishlist', hint: 'Your Steam wishlist with prices and release dates.', keywords: 'wishlist steam sale price drop release' },
  { section: 'library', group: 'Steam extras', label: 'News and patch notes', hint: 'Steam news for your games.', keywords: 'news patch notes updates' },
  { section: 'library', group: 'Steam extras', label: 'Friends who played a game', hint: 'Friends’ recent games on game pages.', keywords: 'friends played recent' },
  { section: 'library', group: 'Steam reviews and tags', label: 'Review snapshot', hint: 'Steam’s review summary on game pages.', keywords: 'reviews rating steam' },
  { section: 'library', group: 'Steam reviews and tags', label: 'Community tags', hint: 'Steam’s community tags on game pages and as filters.', keywords: 'tags genres community' },
  { section: 'library', group: 'Data sources', label: 'Data sources', row: 'data-sources', hint: 'Keys and switches for IGDB, RAWG, SteamGridDB, IsThereAnyDeal and more.', keywords: 'data sources keys igdb twitch rawg steamgriddb isthereanydeal itad cheapshark wikidata pcgamingwiki api' },
  { section: 'library', group: 'Data sources', label: 'Fill in missing game details', hint: 'From IGDB or RAWG with your own key.', keywords: 'igdb rawg enrichment details' },
  { section: 'library', group: 'Data sources', label: 'Search stores and game databases', hint: 'Discover searches beyond your library.', keywords: 'discover search online stores' },
  { section: 'library', group: 'Data sources', label: 'Steam store shelves in Discover', hint: 'Trending, deals and new releases in Discover.', keywords: 'discover shelves trending deals new releases coming soon' },
  { section: 'library', group: 'Data sources', label: 'Current store prices for library value', hint: 'Steam prices for the Journal’s library value.', keywords: 'prices value library worth price country region' },
  { section: 'library', group: 'Time to beat', label: 'Show time-to-beat bars', hint: 'How long games take, on cards and pages.', keywords: 'time to beat howlongtobeat length hours' },
  { section: 'library', group: 'Art packs', label: 'Apply a style to many games', hint: 'One SteamGridDB style across your library.', keywords: 'art packs style covers logos steamgriddb' },

  // ---- Data sources (health) ----
  { section: 'sources', group: 'Data sources at a glance', label: 'Data sources at a glance', row: 'sources-health', hint: 'Last answer, problems, pauses, requests today and cache age for every source.', keywords: 'health status api rate limit back-off errors requests steam igdb rawg steamgriddb wikidata itad cheapshark pcgamingwiki geforce now game pass exchange rates cloud ai' },

  // ---- Cloud play ----
  { section: 'cloud', group: 'Cloud play', label: 'Cloud play', hint: 'Play through Xbox Cloud Gaming and GeForce NOW.', keywords: 'cloud streaming geforce now xcloud xbox cloud gaming' },
  { section: 'cloud', group: 'Cloud play', label: 'GeForce NOW membership', hint: 'Free, Performance, Ultimate or Day pass.', keywords: 'geforce now gfn nvidia membership tier' },
  { section: 'cloud', group: 'Cloud play', label: 'Region', row: 'cloud-region', hint: 'Which catalogue to use.', keywords: 'market region country cloud' },
  { section: 'cloud', group: 'Cloud play', label: 'Open web games in', hint: 'Your browser or a separate Edge window.', keywords: 'browser edge web' },
  { section: 'cloud', group: 'Cloud play', label: 'Hours reset on', hint: 'When GeForce NOW hours start again.', keywords: 'hours meter reset month' },
  { section: 'cloud', group: 'GeForce NOW queue alerts', label: 'Tell me when my turn is close', hint: 'A notification near the front of the queue.', keywords: 'queue alerts position wait' },

  // ---- Launching & sessions ----
  { section: 'launching', group: 'Launching', label: 'Cinematic launch', hint: 'A short full-screen transition while your game starts.', keywords: 'launch animation transition' },
  { section: 'launching', group: 'Launching', label: 'Get out of the way while playing', hint: 'Minimize and suspend VYSTRAL during games.', keywords: 'minimize performance mode suspend' },
  { section: 'launching', group: 'Launching', label: 'Come back when the game closes', hint: 'Restore VYSTRAL with a session summary.', keywords: 'restore summary return' },
  { section: 'launching', group: 'Sessions & performance', label: 'Record CPU, GPU and memory while playing', hint: 'One light reading every two seconds.', keywords: 'metrics cpu gpu memory performance recording' },
  { section: 'launching', group: 'Sessions & performance', label: 'Note which other apps are running', hint: 'Which heavy apps run during rough sessions.', keywords: 'background apps processes' },
  { section: 'launching', group: 'Sessions & performance', label: 'Show the Pulse window during games', hint: 'A tiny always-on-top session timer.', keywords: 'pulse overlay timer window' },
  { section: 'launching', group: 'Background tracking', label: 'Track games even when VYSTRAL is closed', hint: 'Record games you start elsewhere.', keywords: 'tracker background detect outside closed startup' },
  { section: 'launching', group: 'Background tracking', label: 'Start with Windows', hint: 'Run the tracker when you sign in.', keywords: 'startup sign in windows' },
  { section: 'launching', group: 'Frame-rate capture', label: 'Measure frame rate during games', hint: 'FPS with PresentMon (optional download).', keywords: 'fps frame rate presentmon' },
  { section: 'launching', group: 'Energy estimate', label: 'Estimate energy use', hint: 'Electricity used per session, game and month.', keywords: 'energy power watts electricity kwh' },
  { section: 'launching', group: 'Energy estimate', label: 'Electricity price', hint: 'From your bill, to show what play costs.', keywords: 'electricity cost price kwh bill' },
  { section: 'launching', group: 'Anti-cheat notes', label: 'Show anti-cheat notes', hint: 'Anti-cheat details on game pages.', keywords: 'anti-cheat linux deck' },

  // ---- Controller & sound ----
  { section: 'controller', group: 'Controller', label: 'Navigate with a controller', hint: 'Use a gamepad anywhere in VYSTRAL.', keywords: 'gamepad xbox controller' },
  { section: 'controller', group: 'Controller', label: 'Gentle vibration feedback', hint: 'Small rumbles as you move.', keywords: 'vibration rumble haptics' },
  { section: 'controller', group: 'Controller', label: 'On-screen keyboard when using a controller', hint: 'Type with the controller.', keywords: 'keyboard typing osk text' },
  { section: 'controller', group: 'Controller', label: 'Start in Immersive Mode', hint: 'The full-screen, controller-first layout.', keywords: 'immersive fullscreen tv big picture couch' },
  { section: 'controller', group: 'Controller', label: 'Screensaver in Immersive Mode', hint: 'Cycles artwork after a few idle minutes.', keywords: 'screensaver attract idle' },
  { section: 'controller', group: 'Controller', label: 'Start the screensaver after', hint: 'Minutes without input.', keywords: 'screensaver delay minutes' },
  { section: 'controller', group: 'Controller', label: 'Big clock in the screensaver', hint: 'A large, quiet clock for TVs.', keywords: 'clock time screensaver tv' },
  { section: 'controller', group: 'Controller', label: 'Immersive Home row order', hint: 'Reset your own row order.', keywords: 'rows order immersive home' },
  { section: 'controller', group: 'Controller battery', label: 'Keep battery history', hint: 'Controller battery levels over time.', keywords: 'battery charge controller' },
  { section: 'controller', group: 'Immersive Mode', label: 'Couch text size', hint: 'Bigger text for the couch.', keywords: 'text size tv scale couch' },
  { section: 'controller', group: 'Immersive Mode', label: 'TV safe area', hint: 'Keep content inside the TV’s visible area.', keywords: 'overscan safe area tv' },
  { section: 'controller', group: 'Immersive Mode', label: 'Cinematic mode switch', hint: 'The animated switch into Immersive Mode.', keywords: 'transition immersive animation' },
  { section: 'controller', group: 'Voice-over & captions', label: 'Voice-over in Immersive Mode', hint: 'Says what’s focused, with captions.', keywords: 'voice narration screen reader speech captions accessibility' },
  { section: 'controller', group: 'Sound', label: 'Interface sounds', hint: 'Short clicks for focus, select and back.', keywords: 'sound audio clicks' },
  { section: 'controller', group: 'Sound', label: 'Ambient sound', hint: 'A soft layer that follows the game’s mood.', keywords: 'ambient music mood audio' },

  // ---- Windows integration ----
  { section: 'windows', group: 'Windows integration', label: 'Use a summon shortcut', hint: 'A hotkey that brings VYSTRAL forward.', keywords: 'hotkey shortcut summon keyboard' },
  { section: 'windows', group: 'Windows integration', label: 'Show Windows notifications', hint: 'Session summaries, achievements and alerts.', keywords: 'notifications toast alerts' },

  // ---- AI ----
  { section: 'ai', group: 'Local AI (optional)', label: 'Enable local AI', hint: 'Natural-language search with Ollama on this PC.', keywords: 'ollama local ai assistant' },
  { section: 'ai', group: 'Local AI (optional)', label: 'Model', row: 'ai-model', hint: 'Which local model the Assistant uses.', keywords: 'model ollama qwen llama' },
  { section: 'ai', group: 'AI providers', label: 'AI providers', hint: 'Claude, ChatGPT, Gemini or your own endpoint, with your key.', keywords: 'cloud ai claude anthropic chatgpt openai gemini google openrouter key provider' },

  // ---- Updates ----
  { section: 'updates', group: 'Automatic updates', label: 'Check for updates automatically', hint: 'Once shortly after starting.', keywords: 'updates version github' },
  { section: 'updates', group: 'Automatic updates', label: 'Download updates in the background', hint: 'Never while a game is running.', keywords: 'download background update' },
  { section: 'updates', group: 'After-update check', label: 'After-update check', hint: 'Checks a new version works on this PC.', keywords: 'self-check health rollback' },

  // ---- Privacy ----
  { section: 'privacy', group: 'Your data stays on this PC', label: 'Offline mode', hint: 'Stops all optional network access.', keywords: 'offline network internet privacy local' },
  { section: 'privacy', group: 'Data saver', label: 'Data saver', hint: 'Fewer downloads on limited connections.', keywords: 'data saver metered bandwidth mobile hotspot' },
  { section: 'privacy', group: 'Trailers', label: 'Autoplay trailers', hint: 'Play trailers on game pages by themselves.', keywords: 'trailers video autoplay' },
  { section: 'privacy', group: 'Network health', label: 'Network health', hint: 'Check the services VYSTRAL talks to.', keywords: 'network connection dns tls diagnose test' },

  // ---- Data & recovery ----
  { section: 'data', group: 'Your data', label: 'Data folder', hint: 'Where VYSTRAL keeps your library and settings.', keywords: 'folder location path appdata' },
  { section: 'data', group: 'Your data', label: 'Library database', hint: 'Check it or back it up.', keywords: 'database backup check sqlite' },
  { section: 'data', group: 'Your data', label: 'Export your journal', hint: 'Sessions, playtime, notes and ratings as JSON.', keywords: 'export journal json backup' },
  { section: 'data', group: 'Caches', label: 'Caches', row: 'caches', hint: 'See and clear downloaded data: art, trailers, prices and more.', keywords: 'cache clear space disk storage free size downloads' },
  { section: 'data', group: 'Caches', label: 'Artwork', row: 'cache-art', hint: 'Clear downloaded covers and backgrounds.', keywords: 'art cache clear covers images' },
  { section: 'data', group: 'Caches', label: 'Trailer loops', row: 'cache-trailers', hint: 'Clear cached live-tile clips.', keywords: 'video cache trailers live tiles' },
  { section: 'data', group: 'Caches', label: 'Start-up snapshot', row: 'cache-firstPaint', hint: 'The copy of Home used for an instant start.', keywords: 'first paint startup snapshot' },
  { section: 'data', group: 'Database upkeep', label: 'Compact automatically', hint: 'A monthly tidy-up when the PC is idle.', keywords: 'compact vacuum database size' },
  { section: 'data', group: 'Reset & delete', label: 'Delete tracked play history', hint: 'Remove recorded sessions.', keywords: 'delete history sessions erase' },
  { section: 'data', group: 'Reset & delete', label: 'Reset all settings', hint: 'Back to defaults; your library is kept.', keywords: 'reset defaults' },
  { section: 'data', group: 'Troubleshooting', label: 'Logs', hint: 'Diagnostic logs from the last 7 days.', keywords: 'logs diagnostics troubleshooting safe mode' },

  // ---- About ----
  { section: 'about', group: 'About', label: 'Version', row: 'version', hint: 'Release notes, What’s new and credits.', keywords: 'version about licence license credits github release notes' },
  { section: 'about', group: 'Stability', label: 'Stability', row: 'stability', hint: 'Days without a failed start, and recent incidents.', keywords: 'crash free streak stability crashes failed start reliability' },
  { section: 'about', group: 'Startup timings', label: 'Startup timings', row: 'startup-timings', hint: 'How long recent starts took.', keywords: 'startup speed timing fast slow' },
];
