# Changelog

All notable changes to VYSTRAL. Versions follow [SemVer](https://semver.org). The section for each version is shown in the app's update viewer.

## [0.1.1] — 2026-10-04

### Fixed
- Crash-recovered sessions now record a sensible end time (start + the last recorded activity), instead of ending at the moment they started.
- The release pipeline uses current GitHub Actions versions.

### Notes
- This is the first update delivered through VYSTRAL's built-in updater, which downloads only the difference from 0.1.0.

## [0.1.0] — 2026-10-04

The first public preview of VYSTRAL.

### Library
- Finds installed games from **Steam, Xbox / PC Game Pass, Epic Games, GOG, EA app, Ubisoft Connect and Battle.net**. It reads only what those apps keep on your PC: no passwords, no sign-in.
- Add any game or program yourself.
- One entry per game across stores, with a store chooser and a preferred store. Different editions are never merged automatically; possible duplicates wait for your decision, and merges can be undone.
- Optional game details and artwork from Steam's public store pages, using exact matches only. Plus original generated covers when no art exists.
- Library view built for thousands of games: grid and list views, quick filters (Installed, Favorites, Unplayed, New, Needs store app, Missing, Hidden), sorting and collections.

### Playing
- Launches each game through its store's official mechanism (or directly for DRM-free games). It reports "running" only once the game process actually starts, and never relaunches anything.
- Cinematic launch sequence, or an instant mode.
- **Performance Mode:** VYSTRAL minimizes and suspends its interface while you play (0% CPU while minimized in our tests).
- Session tracking with optional read-only CPU/GPU/memory/temperature history.
- **Pulse:** a tiny optional always-on-top session window.

### Experience
- **Living Canvas:** an ambient background that takes on each game's colours and mood, with readable contrast guaranteed.
- **Command bar (Ctrl+K):** understands "installed racing games under 20 GB", "launch …", "not played in 3 months", "on my second SSD", with no AI needed.
- **Immersive Mode (F11 / Menu):** a full-screen, controller-first layout.
- Full controller navigation (Xbox-compatible), keyboard shortcuts, and mouse back/forward buttons.
- Themes: Obsidian, OLED black, Light and High contrast. Artwork-driven or fixed accent colours. Reduced-motion mode.
- **Journal:** play-time charts, top games and genres, a timeline, Time Capsule milestones, year in review, export and delete.
- **Performance centre:** interactive per-session charts and session comparison. FPS is clearly marked as not measured.
- **Moments:** Steam screenshots and Xbox Game Bar captures in one gallery (opt-in, nothing uploaded).
- **Constellation:** an optional 3D map of your library, with an accessible list view.
- **Assistant:** optional local AI through Ollama: natural-language search and recommendations, entirely on your PC.

### Reliability & privacy
- Automatic updates from GitHub with a progress viewer; updates never install mid-game.
- No account, telemetry or ads. Offline mode turns off every optional network feature.
- Safe mode (hold Shift at start), crash recovery for open sessions, database backups before upgrades, and an audit log of changes VYSTRAL makes.
