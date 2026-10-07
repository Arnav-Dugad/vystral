# Changelog

All notable changes to VYSTRAL. Versions follow [SemVer](https://semver.org). The section for each version is shown in the app's update viewer.

## [0.6.1] — 2026-10-07

### Fixed
- Older Xbox app and Microsoft Store games such as Forza Horizon 4 now appear in your library. They don't carry the newer game configuration file, so VYSTRAL now also recognises games by their Xbox Live configuration, while still leaving out Microsoft's own Xbox apps.

## [0.6.0] — 2026-10-06

Your library, settings and history carry over.

### Cloud play
- **Play in the cloud (opt-in).** GeForce NOW and Xbox Cloud Gaming for games you own. VYSTRAL checks the services' public game lists (at most once a day; only your region is sent) and opens the official app or website. It never signs in for you and never shows the stream itself.
- **Honest badges.** Library cards get a cloud badge, the Library a "Playable in the cloud" filter, and game pages a Play in the cloud button that says what each service needs ("may be included with Game Pass", "Install-to-Play (Performance/Ultimate)", "Likely match").
- **Hours meter.** Pick your GeForce NOW membership and reset day to see the hours left this month and the time left in a session, estimated from sessions VYSTRAL saw. Xbox Cloud Gaming time is shown too, and cloud sessions appear in your Journal.

### Home, Library and game pages
- **Friends playing now (opt-in).** With your Steam Web API key, Home shows which friends are online and what they're playing, grouped by game, with a shortcut to games you own. It reads only their public status and pauses offline, in Data saver and while you play.
- **Library health.** One page lists everything wrong with your library (games that can't start, unplugged drives, duplicates, missing or blurry art, missing details, sessions that never ended), each with a safe fix, a health score and "Fix all safe issues". It runs on your PC and never deletes anything.
- **Controls tab.** See a game's Steam Input layout before you play, drawn on a controller with every binding labelled, with action sets and layers. Read-only from Steam's files on this PC.
- **Update-space forecast.** VYSTRAL reads Steam's own update sizes and warns on Home, on the game page and in Storage Studio (new *Pending Steam updates*) when an update won't fit or would leave the drive nearly full, with an optional Windows notification.

### Immersive Mode
- **A guide on the Menu button.** Return to your game, desktop mode, display, voice-over, settings and Close VYSTRAL (never shuts down or sleeps the PC).
- **Voice-over and captions (off by default).** Immersive reads out the game, row or menu you're on, with captions, using Windows' own voices on your PC. Nothing goes online.
- **New rows.** Now playing (with a live session clock and Return to game) and Downloads. All games gains sort and store filters, and LT/RT jump through it by letter.
- **More to love.** An achievement showcase on game pages, a Controls tab, Immersive remembers where you were, leaving lands the desktop on the same game, palette colours crossfade between games, and couch text at 130% now fits 1080p TVs.

### Controller
- **Button icons, redrawn.** Controller buttons are crisp, perfectly centred icons everywhere, with PlayStation and Nintendo layouts and automatic detection.
- **Type with your controller.** In desktop mode, press A on any text box and a Big Picture-style keyboard slides up: number pads for numbers, email and web keys, hidden passwords, and suggestions from your library or your own words. X deletes, Y adds a space, LB/RB move the cursor, LT is Shift and RT is Done.

### Logos
- **The real Xbox logo.** Xbox games now wear the Xbox sphere everywhere in place of the placeholder "X".
- **Logos where they help.** Data sources, Steam Deck, local AI, GPU makers, cloud services and store buttons ("Install in EA app") show their logos, monochrome until you hover. Services without an openly licensed logo get a plain icon.

### Fixed
- Controller button hints in Immersive Mode were off-centre and unevenly spaced.
- Couch text at 130% pushed Immersive's game info into the header and cut off the hints on 1080p screens.
- Immersive overlays swallowed button presses while they animated out.

## [0.5.0] — 2026-10-06

Your library, settings and history carry over.

### Immersive Mode, rebuilt
- **A new way in.** Press F11 or the Menu button: the interface folds away, the game you're looking at fills the screen with a flare of light, and Immersive Mode rises in around it. The way back out is the reverse. Any button skips it; with reduced motion it's a quick fade.
- **Hero stage:** the focused game's short trailer loop plays behind everything, with gentle depth as you move.
- **Smarter rows** that change with the time of day, a wider "Jump back in" slot, Never played, your collections, your stores and genres.
- **Quick menu:** hold X (or press View) for Play, Favorite, Status, Store page, Achievements and Display settings on a radial menu.
- **Game page** with Overview, Achievements, Sessions and Media tabs, all controller-friendly.
- **System bar:** what's playing, notifications, controller and PC battery, Wi-Fi and the time.
- **Couch mode:** bigger text and a TV safe area for sofa distance.
- **Spatial sounds** (with interface sounds on): focus sounds follow the ring across the screen and take on the game's mood. Plus haptic ticks between rows, a focus ring in the game's colours, a burst of light on Play and a richer screensaver.
- **A short first-time tour** that never gets in the way.

### Home, Journal and game pages
- **While you were away:** games you played without opening VYSTRAL get a summary card on Home.
- **Session replay:** a short animated card of any session (time, CPU/GPU or FPS line, achievements) that you can save or copy as a 1920×1080 image.
- **Time to beat:** with your IGDB key, cards and game pages show how far you are through a game, and the Library can sort by "Closest to finishing".
- **Anti-cheat notes:** before launching a game with kernel-level anti-cheat, the pre-flight card says so, plainly and without alarm. You can turn these notes off.
- **Sales forecast:** Library value shows the next Steam sale Valve has announced and an estimate of what your backlog would cost at past lows.

### Look and feel
- **Art packs:** give the whole library one SteamGridDB style in one step, previewed first, never replacing art you picked by hand, and fully undoable.
- **Store logos draw themselves** in their brand colour when you hover or select them.
- **Live tiles pick their best moment:** each clip loops its most lively couple of seconds, with a seamless crossfade.

### Faster and lighter
- **Recording performance during a game now costs about 0.06% of one CPU core** (it was several percent). GPU load is now the game's GPU rather than all GPUs added together.

### Fixed (from a full audit of the app)
- Launching twice quickly could start a game twice; a replaced launch could confuse the next one.
- Time your PC spent asleep counted as playtime.
- Restoring VYSTRAL during a game showed a blank window.
- "Clear art cache" lost covers for good; merging duplicates lost the Steam link, per-game data and art you'd picked; separating them suggested them again straight away.
- Startup scans could wipe Steam playtime for games played on another PC.
- A crash with performance recording off recorded the session as 0 seconds.
- Notes typed just before leaving a game page were lost; typing a new collection name lost characters; Library filters were lost on Back.
- Keyboard focus was invisible on many controls; light-theme text on the accent colour was hard to read.
- Playtime could be counted twice in sorting and suggestions; "Never played" meant different things in different places.
- One unusual answer from the Steam store could stop details being filled in for good.
- The Local AI chat could reject every message or hang.
- Updates no longer download on metered connections with Data saver, and Offline mode now really stops update checks.
- Many smaller fixes to the Constellation view, toasts, trailers, the command bar and Immersive Mode controls.

## [0.4.0] — 2026-10-05

Your library, settings and history carry over.

### Playing
- **Games you start anywhere are tracked.** Launch a game from Steam, a desktop shortcut or anywhere else and VYSTRAL notices and records the session, with the same performance readings as a launch from VYSTRAL. Sessions show where they came from.
- **Even while VYSTRAL is closed** (optional, off by default): turn on Settings → Launching & sessions → "Track games even when VYSTRAL is closed" and a tiny helper starts with Windows. It uses almost nothing while idle (about 0.05% of one CPU core and 20 MB), hands the session over seamlessly when you open VYSTRAL, and is removed when you turn it off or uninstall.

### Library & game pages
- **Real store logos** for Steam, Epic Games, GOG, EA app, Ubisoft Connect and Battle.net, everywhere a store is shown. (Xbox has no freely licensed mark, so it shows a neutral "X".)
- **Art picker:** choose alternate covers, heroes, logos and icons from SteamGridDB, with live previews (your own free key).
- **More details, your way:** fill in missing descriptions, genres, time to beat, series and similar games from IGDB or RAWG (your own free keys, kept in Windows Credential Manager).
- **Deals:** the best current price, the lowest ever and other shops for a game, from CheapShark (no key) or IsThereAnyDeal (your key). Opens in your browser.
- **Steam Deck and anti-cheat badges:** Valve's Deck rating with its test notes, and which anti-cheat a game uses (from AreWeAntiCheatYet).
- **The same game on other stores:** a game's IDs on Steam, GOG, Epic, Microsoft Store and more, from Wikidata, with links. Possible duplicates across stores are suggested, never merged on their own.
- **Never played:** a shelf and a Library filter for games you own but haven't played, with how long they've been waiting.
- **Library value** (Journal): when games joined your library and what it's worth at today's prices. Dates use the earliest evidence available and say which one; prices are current prices, not what you paid.

### Feel
- **Live tiles:** covers on Home quietly play Steam's short silent clips while they're on screen. Never on a metered connection, with Data saver, or while you play.
- **Library sort animations:** cards glide to their new places when you change the sort or filter.
- **Achievement shimmer:** a sweep of light across new achievements, tinted by rarity (silver, gold, prismatic for the rarest).
- **Ambient sound** (off by default): soft sounds that follow the game's mood. Settings → Controller & sound.
- **Illustrated empty states** drawn from the game's own colours.

### Updates
- **What's new, once.** After an update, a short tour shows what changed, with buttons that take you straight to each feature. Never on a fresh install, and never in Immersive Mode. Also under Settings → About.
- **Updates that undo themselves.** If a new version fails to start twice in a row, VYSTRAL returns to the version that worked, tells you why, and skips that update until a fixed one is out.
- **Clearer update status** in the title bar, with the actual reason when a check fails.
- **"New" dots** mark features you haven't tried yet, and disappear once you've had a look.

### Privacy
- **Network health** (Settings → Privacy): whether GitHub and Steam's servers answer from your network, address by address, with the actual reason when one doesn't. Only when you press Check now.

### Fixed
- The visual regression tests compared a solid-colour image and could never catch a change; they now compare the real screen.

## [0.3.1] — 2026-10-05

### Fixed
- **Updates could look stuck.** On some networks one of GitHub's download servers can't be reached, and VYSTRAL waited about 21 seconds on it for every release file, so a check took minutes. VYSTRAL now tries GitHub's servers side by side, like a browser does: checks take a few seconds. The same fix speeds up artwork, trailers and Steam requests on those networks.
- Update checks give up after 2 minutes instead of spinning forever, and VYSTRAL checks again every 6 hours while it's open.

### Changed
- **Updates now download automatically in the background** (never while a game runs) and install the next time you start VYSTRAL. You can turn this off in Settings → Updates.

### Note for 0.3.0 and earlier
- Older versions still check the slow way (it can take a couple of minutes after VYSTRAL starts) and don't download on their own. When an "Update 0.3.1" button appears in the title bar, select it, then Download, then Restart. From 0.3.1 on, updates are automatic.

## [0.3.0] — 2026-10-05

Your library, settings and history carry over.

### Library
- **Every game shows its cover.** Games you own but haven't installed now get their artwork straight away: first from Steam's own cache on your PC, then from Steam's image servers several at a time. A library of 200 owned games fills in within seconds instead of trickling in over many minutes.
- Newer Steam games whose artwork uses Steam's newer file naming now get covers, heroes and headers too. A grey placeholder Steam sometimes serves is recognised and replaced with the real cover.
- **Tiles are always the same size.** A long title could stretch its column; it can't any more.
- "Not installed" is now a small icon on the cover that names itself when you hover or select the game, so it no longer sits on top of the logo.
- Black store logos (like EA SPORTS FC) switch to their light version on dark artwork, everywhere they appear.

### Game pages
- **One Play button that morphs:** Play → Launching (with a progress ring that has learned how long the game takes) → Playing (live timer) → Installing (percentage ring) → Update needed. Games you don't have installed show a single Install button instead of a greyed-out Play.
- **Last-session ghost:** a faint line behind the hero replays your last session's frame rate, CPU or GPU, with a short caption.
- **Living Canvas follows the trailer:** the background gently takes on the trailer's colours while it plays, then eases back. Never strobes; text always stays readable. You can turn it off in Settings → Appearance.

### Controller
- **Haptics:** a soft bump at the end of a row, a tick when switching sections, a firmer pulse when you press Play. Only when vibration is on (Settings → Controller), never while a game runs, and always short.
- **On-screen keyboard:** press Y in Immersive Mode to search with the controller, with live suggestions from your library (covers and word completions).
- **Hold to confirm:** things you can't undo (deleting history, removing a game, disconnecting your Steam key, resetting settings) need a short hold with a filling ring.

### Journal and performance
- **Play calendar:** a year of play, day by day, with your current and longest streak. Select a day to see what you played.
- **Achievements tab:** every Steam achievement you've unlocked on one timeline, rare ones highlighted, plus the games you're closest to completing. Needs your own Steam Web API key.
- **Achievement toasts:** after a Steam session, "You unlocked 3 achievements — 1 is rarer than 2%".
- **Before and after a driver update:** VYSTRAL notes your graphics driver version with each session and compares frame rates across a driver change.
- **Background apps:** see which other apps tend to be running when a game plays badly (correlation, not blame). Only program names, memory and CPU share are stored, on this PC.

### Windows
- **Clicking a notification now opens the right page**, even if VYSTRAL was closed.
- **Mica:** with the Living Canvas off, the title bar and sidebar use the Windows 11 Mica material.
- **Windows accent colour** is now one of the accent choices.

### Fixed
- Pre-flight checks could be skipped when the PC was busy at launch.
- The Constellation view now frames every cluster instead of cutting off the biggest one.
- Rows on Home only show scroll arrows when there's more to see.
- Sessions recorded before frame-rate capture existed no longer claim VYSTRAL "doesn't use PresentMon yet".

### Research (no code yet)
- Free game-data sources, and adding Xbox Cloud Gaming and GeForce NOW: see `docs/research/`.

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
