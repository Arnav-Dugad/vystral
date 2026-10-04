# Progress

Status as of **v0.1.0 (2026-10-04)**. ✅ complete · 🟡 partial · ⛔ blocked · ⬜ not started.

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
- ✅ Steam: installed games, playtime, last played, local artwork. Verified on real data.
- 🟡 Xbox / Game Pass, Epic, GOG, EA, Ubisoft, Battle.net: implemented and fixture-tested; not exercised end to end on a PC with those games installed (EA and Ubisoft clients present on the dev PC with no games).
- ✅ Capability and limitation reporting; per-adapter isolation and timeouts
- ✅ Duplicate detection, suggestions, merge and unmerge
- ✅ Optional Steam store metadata and artwork with exact-match safety
- ⬜ Owned-but-not-installed games (opt-in Steam Web API key)
- ⬜ Achievements

## Phase 5 — Premium experience ✅
- ✅ Living Canvas (WebGL2, mood overlays, palette crossfades, pause rules, fallbacks)
- ✅ Home (hero, shelves, deterministic picks, Library Radar), detail pages, cinematic launch, intro sequence
- ✅ Immersive Mode (anchored shelves, panel, LB/RB tabs) and controller navigation everywhere (native Windows.Gaming.Input)
- 🟡 Physical controller: implemented natively; keyboard path automated-tested; hands-on controller pass pending

## Phase 6 — Intelligence ✅
- ✅ Performance history (read-only CPU/GPU/VRAM/RAM/temperature), interactive charts, session compare
- ✅ Journal: stats, charts, timeline, Time Capsule milestones, year in review, export, delete
- ✅ Recommendations with reasons (deterministic)
- ✅ Optional local AI via Ollama: status, consented model download with progress, streaming chat, structured query parsing
- ⛔ FPS / frame times: needs PresentMon ETW access (admin or Performance Log Users group). Reported honestly as not measured.

## Phase 7 — Signature features 🟡
- ✅ Constellation (3D, with list alternative)
- ✅ Pulse companion window
- ✅ Time Capsule
- ✅ Library Radar (installed / needs store app / missing / stores)
- ✅ Moments Vault (Steam screenshots, Game Bar captures, custom folders, lightbox)
- 🟡 Session Composer: per-game launch options and preferred store exist; display, audio and power profiles not implemented
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
