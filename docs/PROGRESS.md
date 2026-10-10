# Progress

Status as of **v0.9.0 (2026-10-11)**. ✅ complete · 🟡 partial · ⛔ blocked · ⬜ not started.

## Phase 1 — Foundation ✅
- ✅ Repository, solution, CI and release workflows
- ✅ WinUI 3 shell (unpackaged, self-contained, built with the .NET CLI only), single instance, safe mode, crash marker
- ✅ Hardened WebView2 host with virtual hosts, CSP and navigation lockdown
- ✅ Typed JSON bridge with allow-listed, validated methods
- ✅ SQLite with WAL, transactional migrations, pre-migration backups, integrity check, recovery
- ✅ Structured local logging

## Phase 2 — Design system ✅
- ✅ Brand mark, icon, installer splash, wordmark
- ✅ OKLCH tokens; Obsidian, OLED, Light and High-contrast themes; fixed or artwork-driven accent
- ✅ Motion tokens (springs), reduced-motion mode, Performance Mode freeze
- ✅ Component library (buttons, toggles, segmented, tabs, slider, dialog, menu, toasts, progress, skeletons, empty states, badges)

## Phase 3 — Working library ✅
- ✅ Canonical game model with separate installations and user data; reconciliation that never deletes
- ✅ Library grid and list (virtualized), quick filters, sorting, collections, hidden games
- ✅ Deterministic natural-language search and command bar
- ✅ Validated launching with process detection and session tracking
- ✅ Manual games

## Phase 4 — Platform integrations 🟡
- ✅ Steam: installed games, playtime, last played, local artwork, live install progress, trailers. Verified on real data.
- 🟡 Steam Web API (owned games, achievements): implemented and tested against documented response shapes; not exercised with a real key on the dev PC.
- 🟡 Xbox / Game Pass, Epic, GOG, EA, Ubisoft, Battle.net: implemented and fixture-tested; not exercised end to end on a PC with those games installed (EA and Ubisoft clients present on the dev PC with no games).
- ✅ Capability and limitation reporting; per-adapter isolation and timeouts
- ✅ Duplicate detection, suggestions, merge and unmerge
- ✅ Optional Steam store metadata and artwork with exact-match safety
- ⬜ Owned-but-not-installed games (opt-in Steam Web API key)
- ⬜ Achievements

## Phase 5 — Premium experience ✅
- ✅ Living Canvas (WebGL2, mood overlays, palette crossfades, pause rules, fallbacks)
- ✅ Home (hero, shelves, deterministic picks, Library Radar), detail pages, cinematic launch, intro sequence
- ✅ Immersive Mode rebuilt (single travelling focus ring, fixed-height windowed rows, crossfading info, A–Z rows, game panel, attract mode) and controller navigation everywhere (native Windows.Gaming.Input)
- ✅ Startup intro, card-to-page flight, launch portal and return iris, exact return (scroll and focus), squircle corners
- 🟡 Physical controller: implemented natively; keyboard path automated-tested; hands-on controller pass pending

## Phase 6 — Intelligence ✅
- ✅ Performance history (read-only CPU/GPU/VRAM/RAM/temperature), interactive charts, session compare
- ✅ Journal: stats, charts, timeline, Time Capsule milestones, year in review, export, delete
- ✅ Recommendations with reasons (deterministic)
- ✅ Optional local AI via Ollama: status, consented model download with progress, streaming chat, structured query parsing
- 🟡 FPS / frame times: opt-in PresentMon 2.6.0 capture with pinned SHA-256 and a one-time Performance Log Users grant. Parser verified against real CLI output and access-denied behaviour; not yet run against a live game with the permission granted.
- ✅ Pre-flight checks, learned launch timing, one-click launch fixes, NVIDIA thermal-throttle alerts, game status with history

## Phase 7 — Signature features 🟡
- ✅ Constellation (3D, with list alternative)
- ✅ Pulse companion window
- ✅ Time Capsule
- ✅ Library Radar (installed / needs store app / missing / stores)
- ✅ Moments Vault (Steam screenshots, Game Bar captures, custom folders, lightbox)
- 🟡 Session Composer: per-game launch options and preferred store exist; display, audio and power profiles not implemented
- ✅ Storage Studio (drive treemap, unplayed suggestions, never deletes)
- ✅ Summon hotkey, Windows notifications (click-through blocked by microsoft/WindowsAppSDK#6774), notification centre, now-playing chip
- ⬜ Sale and update news (no reliable, lawful, free source chosen)

## Phase 8 — Hardening 🟡
- ✅ Unit, integration, e2e, accessibility (axe) and visual-regression suites
- ✅ Measured startup, idle and minimized CPU, and memory (see PERFORMANCE.md)
- ✅ Threat model and security controls
- ⬜ Sleep/resume, DPI, monitor and controller hot-plug test passes
- ⬜ Code signing

## Phase 9 — Release ✅
- ✅ Velopack per-user installer, portable zip, delta updates, in-app update viewer
- ✅ GitHub Releases with a stable "latest" download link
- See "Verification record" below for the release check.

## Verification record (v0.9.0)

| Check | Result |
|---|---|
| .NET tests | **2585 passed, 0 failed** |
| UI unit tests | **998 passed, 0 failed** |
| Playwright e2e + axe + visual regression | **342 tests: 338 passed, 2 flaky, 2 skipped**; two currency tests that met the new wishlist calendar were updated and pass |
| Real app (dev build, owner's library) | Wishlist calendar with real releases (Gears of War: E-Day, Phantom Blade Zero) in ₹ with lowest-ever markers; every wishlist poster now shows (ANANTA, Bancho the Chef, Bus Simulator 27, CLUTCH were blank); Forza Horizon 4 (Xbox) shows Steam's Deck rating and community tags through its matched Steam page, its IGDB series timeline and Similar in your library; the Assistant side panel opens on Ctrl+J with the owner's Gemini provider; no page errors |
| Not verified | Assistant answers against a real provider key; YouTube trailer frame in the real WebView2; cloud readiness timings; chime by ear |

## Verification record (v0.8.0)

| Check | Result |
|---|---|
| .NET tests | **2248 passed, 0 failed** (one timing test occasionally flaky under load) |
| UI unit tests | **829 passed, 0 failed** |
| Playwright e2e + axe + visual regression | **293 tests: 292 passed or passed on retry**; the one consistent failure (a Library selector that now matched a new button) was fixed |
| Real app (dev build, owner's library) | Title bar reserves 144 px for the caption buttons and the icons sit clear of them on the maximized 1920×1080 window; Forza Horizon 4 leads Continue playing and appears in Storage Studio at 79.4 GB; a Steam sync marked 17 games no longer owned (they were in the owned list imported on Oct 5 and are not in Steam's list now); Performance page with the real RTX 4060 Laptop, driver 617.42 and PresentMon numbers; Discover "Because you played Forza Horizon 4" from IGDB (Pacific Drive, NFS Heat, Halo Infinite, SnowRunner); game page tiles with real reviews (51% → 62%), ₹ prices, tags and size; no page errors |
| Fixed during the check | Docked header and tabs too transparent; duplicate Deck badge on game pages |
| Not verified | Cloud AI against a real provider key; IGDB franchise queries live; GeForce NOW queue titles; spoken voice-over by ear |

## Verification record (v0.7.0)

| Check | Result |
|---|---|
| .NET tests | **2011 passed, 0 failed** (one timing test, Preflight/background tracking, is occasionally flaky under heavy load) |
| UI unit tests | **711 passed, 0 failed** |
| Playwright e2e + axe + visual regression | **235 passed, 2 flaky** (passed on retry) |
| Real app (dev build, owner's library of 205 games) | First content in 840 ms and ready in 954 ms from process start (startup-timings log); Discover search for "elden ring" answered by Steam (6), IGDB (18) and Wikidata (2), merged, with a full page (trailer, ₹ price, 46 h time to beat, Metacritic, Deck and anti-cheat badges); Forza Horizon 4 listed; game page dock, News/Files/Controls/Achievements tabs; Journal; self-check 6 of 6; no page errors |
| Fixed during the check | Game page tabs slid under the docked header (now sticky below it); Discover's "Turn on" could search before the setting was saved and show nothing |
| Not verified | Subscription catalogues, wishlist, friends' history and news against the owner's live account (left off: opt-in); GeForce NOW queue position in the window title; real controllers for battery history; energy estimate against a wall meter |

## Verification record (v0.6.0)

| Check | Result |
|---|---|
| .NET tests | **1610 passed, 0 failed** |
| UI unit tests | **580 passed, 0 failed** |
| Playwright e2e + axe + visual regression | **173 passed, 1 flaky** (a cold-start page load that passed on retry) |
| Real app (dev build, owner's library of 204 games) | Library health ran in 3.9 s with a score of 96 and four real "no details" findings; Controls tab on a Steam game (no Steam Input layout saved, shown correctly) in desktop and Immersive; Immersive hints with the drawn glyphs aligned; WebView2 lists 9 local Windows voices for voice-over; real Xbox mark; no page errors |
| Not verified | Cloud play against the live catalogues and real streams (left off on the owner's PC: it's opt-in); friends' activity with a real key; a real pending Steam update; PlayStation/Nintendo pads; spoken voice-over by ear |

## Verification record (v0.5.0)

| Check | Result |
|---|---|
| Audits | Three read-only audits (native backend, UI, data integrity) found ~100 issues; the confirmed ones were fixed with regression tests (launch races, stale launch states, malformed store JSON, sleep counted as play, merge/unmerge data loss, art cache, playtime wipes, focus, contrast, races) |
| .NET tests | **1414 passed, 0 failed** |
| UI unit tests | **482 passed, 0 failed** |
| Playwright e2e + axe + visual regression | **116 passed** (one heavy test occasionally needs its retry on a loaded machine) |
| Real app (dev build, owner's library) | Cinematic Immersive enter/exit filmed at ~60 fps on the real window; system bar with real battery (80%) and Wi-Fi; radial quick menu; Immersive game page tabs; session replay drawn from a real FC 27 session; FC 26 Deck badge; time-to-beat bars; no page errors |
| GPU sampling | ~1.1 ms per sample (was 131–161 ms), handles and memory flat over 50,000 samples |
| Not verified | Art packs and time-to-beat against real provider keys at scale; spatial sound and haptics on real speakers/controller; PresentMon during a live game |

## Verification record (v0.4.0)

| Check | Result |
|---|---|
| .NET tests | **1254 passed, 0 failed** |
| UI unit tests | **390 passed, 0 failed** |
| Playwright e2e + axe + visual regression (now comparing the real screen) | **80 passed, 0 failed**, three consecutive full runs |
| Real app (dev build, owner's library) | What's new tour; store logos on cards; a Home live tile playing FC 26's micro-trailer through the media proxy; RDR2 page with Steam Deck "Playable" and live CheapShark deals; data-source and background-tracking settings; Network health correctly flagged GitHub's unreachable 185.199.109.133 |
| Background helper (track build, scratch data) | idle 0.04–0.075% of one core, 19–25 MB private; a 150 s fake game recorded as a background session; hand-over to the app and back kept one session |
| Not verified | A real game detected outside VYSTRAL on the owner's PC (no game was launched without the owner); silent rollback on a real failed update; keyed providers (SteamGridDB, IGDB, RAWG, ITAD) with real keys |

## Verification record (v0.3.0)

Recorded 2026-10-05 on the same PC, against the owner's real library (204 Steam games, 2 installed, Steam Web API key connected).

| Check | Result |
|---|---|
| .NET tests | **1049 passed, 0 failed** (stable across repeated runs) |
| UI unit tests | **303 passed, 0 failed** |
| Playwright e2e + axe + visual regression | **53 passed, 0 failed** |
| Library art | 204 of 204 covers present (was 10). Uniform 181×321 tiles at 1920 px |
| Real app over CDP | Notification link `vystral://open?route=journal` moved the running window from Home to Journal (single process); a malformed link was rejected and logged. Mica on with Living Canvas off, nothing see-through. On-screen keyboard with real covers and completions. Game pages: morphing Play/Install, last-session line, trailer tint. Journal: calendar, 271 real achievements with icons. Process snapshot parser checked against the live process list (360/360) and GPU driver read as 617.14 |
| Not verified | Physical controller feel; a live Steam achievement unlock toast; PresentMon with a live game; GPU-driver change across sessions (no driver update happened) |

## Verification record (v0.2.0)

Recorded 2026-10-05 on the same PC.

| Check | Result |
|---|---|
| .NET tests | **873 passed, 0 failed** |
| UI unit tests | **188 passed, 0 failed** |
| Playwright e2e + axe (9 pages) + visual regression | **30 passed, 0 failed** |
| TypeScript strict type-check + production build | Passed |
| Real app over CDP | Intro plays at startup; Immersive ring, panel and logo layout with real Steam art; detail page streams the Steam trailer via the proxy; status picker; Storage Studio with real drive sizes (119 GB of games on C:); Settings for Steam Web API, frame-rate capture, summon shortcut (registered, "Active"); a test Windows notification appeared on the desktop; no page errors |
| Found and fixed during the real-app pass | Notification registration failing (Windows App SDK bug, now falls back to show-only); stale Steam limitation text; Storage tiles without art; tall logos overlapping Immersive tabs |
| Not verified | Steam Web API with a real key; PresentMon against a live game; launching a real game (not done without the owner present); physical controller pass |

## Verification record (v0.1.0)

Recorded 2026-10-04 on the primary development PC (Windows 11, i7-13650HX, RTX 4060 Laptop).

| Check | Result |
|---|---|
| .NET tests (`dotnet test tests/Vystral.Tests`) | **599 passed, 0 failed** (stable across 12 consecutive runs) |
| UI unit tests (`npx vitest run`) | **99 passed, 0 failed** |
| Playwright e2e + axe (8 pages) + visual regression (`npx playwright test`) | **24 passed, 0 failed** |
| TypeScript strict type-check + production build | Passed |
| Real-app run against this PC's stores | Steam: 2 games found, local artwork, Steam playtime/last played, store descriptions enriched; EA/Ubisoft clients detected with no games; clean shutdown logged |
| Performance | See PERFORMANCE.md: FCP 264 ms after navigation; 0.51% CPU in the foreground; **0 ms CPU over 15 s when minimized** |
| Release build (`build/pack.ps1 -Version 0.1.0`) | Produced Setup.exe (103.7 MB), Portable.zip (96.3 MB), full nupkg (96.5 MB), releases.win.json |
| Installer | `Vystral-win-Setup.exe --silent` → exit 0; installed per-user to `%LOCALAPPDATA%\Vystral` with no admin prompt; Desktop and Start-menu shortcuts; "VYSTRAL 0.1.0" uninstall entry |
| Installed app | Launches; updater reports an installed version (0.1.0) with update checks enabled |
| Published release (CI) | `v0.1.0` and `v0.1.1` built and published by GitHub Actions; CI (type-check, unit, e2e, axe, visual, .NET) green on GitHub's Windows runner |
| **Auto-update end to end** | Installed v0.1.0 from the GitHub download link, then in-app: *Check* found 0.1.1 → *Download* showed live %, bytes, speed (2.4 MB/s) and ETA → *Restart and install* relaunched VYSTRAL as **0.1.1** (0.3 MB delta package; registry, packages and binaries all report 0.1.1) |
| Not verified | Physical controller hands-on; sleep/resume, DPI and monitor hot-plug; live installs of Epic/GOG/Battle.net/Xbox games; — |
