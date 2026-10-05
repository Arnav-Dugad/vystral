# Changelog

All notable changes to VYSTRAL. Versions follow [SemVer](https://semver.org). The section for each version is shown in the app's update viewer.

## [0.2.0] — 2026-10-05

A big polish and features release. Your library, settings and history carry over.

### Feel
- **Startup animation** that plays once per launch (about three seconds; any key, click or controller button skips it). Turn it off in Settings → Appearance.
- **Card-to-page flight:** the cover you click flies into the game page, and back again when you return.
- **Launch portal:** launching opens a portal from the cover you pressed, and when your game closes VYSTRAL irises back into it.
- **Exact return:** Back puts you at the same scroll position, with the same game focused.
- **Smoother shapes:** squircle corners where Windows' web engine supports them.

### Immersive Mode, rebuilt
- One focus ring that glides between cards and never clips at the screen edge.
- Rows no longer jump while scrolling, game info crossfades instead of blinking, and tall store logos scale to fit.
- A–Z rows with letter ranges, a game panel with stats, a controller status chip and a clock.
- Enter always opens the game under the ring (the mouse only takes focus when it actually moves).
- **Attract mode:** after a few idle minutes (1–30, or off), a slow slideshow of your games and Moments. The input that wakes it is never passed through.

### Library & stores
- **Steam Web API (optional):** add your own key to see games you own but haven't installed, plus achievements with rarity. The key is kept in Windows Credential Manager, never in VYSTRAL's database or logs.
- **Live install progress** for Steam installs and updates: phase, speed and time left, on cards and game pages.
- **Game status:** mark games as Backlog, Playing, Beaten, Completed or Abandoned, with a history in the Journal.
- **Trailers** on game pages (Steam games), streamed through a filtered local proxy. They respect Offline mode and the new **Data saver**, which can also switch on automatically on metered connections.
- **Storage Studio:** a map of every drive showing which games take the space, with suggestions for big games you haven't played in six months. VYSTRAL never deletes anything: uninstalling always happens in the store.

### Playing
- **Pre-flight card** while a game starts: disk space, pending Steam updates, controllers and battery, display refresh rate and HDR, and other store apps using memory.
- **Launch timing that learns:** after three launches, the spinner becomes a real progress arc based on how long that game usually takes to open.
- **One-click fixes** when a launch fails: rescan the store, start or get the store app, open the game in its store, or open the install folder.
- **Real FPS (optional):** average FPS, 1% and 0.1% lows, frame-time percentiles and stutters, using Intel PresentMon. It's downloaded only when you ask and checked against a pinned fingerprint before every run. Windows requires a one-time permission for frame tracing; it's the only action in VYSTRAL that asks for administrator approval.
- **GPU heat alerts:** if your NVIDIA GPU slowed itself down from heat for more than 30 seconds, the session summary tells you (read-only).
- **Now playing** chip in the title bar with a live timer.

### Windows integration
- **Summon shortcut** (Ctrl+Alt+V by default, changeable) brings VYSTRAL forward from anywhere.
- **Windows notifications** for saved sessions, GPU heat, finished installs and ready updates, only while VYSTRAL is in the background. Each kind can be turned off.
- **Notification centre:** a bell in the title bar keeps the last 80 messages, grouped by day.

### Fixed
- The startup animation never played.
- Switching to Immersive Mode during startup could be undone when loading finished.
- Merging two games now carries over the game's status and its history.
- A session left open when VYSTRAL closed unexpectedly is now recovered with its real length.

### Known issue
- Selecting a Windows notification doesn't open the matching page yet. This is a Windows App SDK bug in self-contained apps ([microsoft/WindowsAppSDK#6774](https://github.com/microsoft/WindowsAppSDK/issues/6774)). The notifications themselves appear normally.

## [0.1.2] — 2026-10-04

### Improved
- The update viewer shows the real download size. Small "changes only" (delta) updates no longer show the full package size.
- Release notes in the update viewer are formatted instead of shown as raw text.

## [0.1.1] — 2026-10-04

### Changed
- The build and release pipeline now uses current GitHub Actions versions.

### Notes
- This is the first update delivered through VYSTRAL's built-in updater. It downloads only the difference from 0.1.0, and your library, settings and history carry over.

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
