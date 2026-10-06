# Known limitations (v0.3.0)

**Distribution**
- The installer and app are **not code-signed**, so Windows SmartScreen shows an "unknown publisher" warning. Signing needs a paid certificate, or Azure Trusted Signing, which isn't set up yet. VYSTRAL does not try to bypass SmartScreen.
- x64 only. ARM64 builds are possible but not produced yet.
- Install size is about 240 MB uncompressed, because .NET and the Windows App SDK are bundled so nothing else needs installing. Delta updates keep later downloads small.

**Integrations**
- Owned-but-not-installed games and achievements are available for **Steam only**, through the opt-in Steam Web API key (Settings → Library & stores). Other stores have no public, account-free way to list owned games.
- Steam install progress is read from Steam's own manifest files; its state flags are inconsistent, so phases are partly inferred from byte counters, and speed/ETA appear after the second update.
- Store playtime is available only from Steam's local records. Everywhere else, VYSTRAL tracks sessions started from VYSTRAL.
- EA: `origin2://` launch is used with the installer content ID; some titles may need launching from the EA app if it rejects the ID. Entries without a content ID are skipped.
- Battle.net: classic titles (Diablo II, Warcraft III) aren't detected. Launch arguments for Battle.net have not been verified on a live install.
- Xbox: the WinRT discovery path is unit-tested below the API boundary, but no Game Pass game was installed on the development machine for a live end-to-end test.
- Epic, GOG, Ubisoft and Battle.net were not installed on the development machine; their adapters are verified with fixture-based tests modelled on real files (and Playnite's long-standing parsers).

**Performance data**
- **FPS is opt-in and off by default.** It uses Intel PresentMon 2.6.0, downloaded on request from its GitHub release (not bundled) and SHA-256-verified before every run. Windows only allows ETW frame tracing for administrators and members of *Performance Log Users*; VYSTRAL can add the signed-in account with one UAC prompt (`net localgroup … /add`), which is the only elevated action in VYSTRAL, and Windows applies it only after signing out and back in. Until then FPS shows "not measured" with the reason, never an estimate.
- PresentMon follows one game process (the largest by working set) and its busiest swap chain. Games that present from a helper process, or that hand off processes more than six times in a session, may show "no frames seen". Frame time is *time between presents* (MsBetweenPresents), not display or latency timing. The PresentMon integration was verified against its real CLI output format and access-denied behaviour, but not yet against a live game with the permission granted.
- Microsoft (Azure AD / Entra) work accounts may not be accepted by `net localgroup`; add them in Computer Management instead.
- GPU temperature, clocks and thermal-throttle detection are NVIDIA-only (NVML, read-only). Other GPUs show "unavailable" and no throttle alert.
- Pre-flight checks show the controller battery only where Windows reports it (wireless Xbox controllers; most wired pads don't), and HDR state only on Windows 10 1709+ displays that expose advanced-colour info.
- CPU/GPU/RAM are system-wide values while your game runs, not per-game.

**Features**
- Controller haptics and the on-screen keyboard were tested with simulated controller input only; how the vibration patterns feel on a physical controller hasn't been tuned by hand yet.
- The background-app report and the driver comparison need several new sessions before they show anything; sessions from earlier versions have neither. A game's resolution isn't recorded, so driver comparisons can mix resolutions (the card says so).
- Achievement toasts depend on Steam reporting unlocks promptly; VYSTRAL checks about 5 s after a session and once more after a minute.
- Selecting a Windows notification opens the matching page through a per-user `vystral:` URI scheme (protocol activation), because `AppNotificationManager.Register()` fails in self-contained Windows App SDK 2.5.1 apps ([microsoft/WindowsAppSDK#6774](https://github.com/microsoft/WindowsAppSDK/issues/6774)); VYSTRAL tries the SDK first and switches back automatically once it works. Each click briefly starts a second VYSTRAL process that hands the page to the running window (well under a second). If the URI scheme can't be registered, notifications are still shown and Settings says they can't open pages. Notifications have no buttons (protocol toasts can't run in-app actions).
- The Mica backdrop (Living Canvas off) needs Windows 11 and Windows' transparency effects; with energy saver, a contrast theme, Immersive, safe mode or the OLED/High-contrast VYSTRAL themes the window stays solid. It follows VYSTRAL's light/dark theme, not Windows'.
- Trailers are available for Steam games only (Steam's public HLS streams).
- **Art packs** match a game on SteamGridDB by its Steam app ID, or else only by an exact, unambiguous title, so games with unusual titles and no Steam ID are left as they are (the art picker can still choose them by hand). A slot whose style has nothing on SteamGridDB keeps its art rather than mixing in another style. Hidden games are never included. A pack runs one game at a time and politely, so a large library takes a while (the dialog estimates how long); if VYSTRAL closes mid-run the pack stops there and is listed as interrupted — what it changed can still be restored. Restoring skips slots changed since (by hand or by a newer pack), and points slots whose previous file is gone back to the store's art on the next scan. Pack art is verified with fixture-based tests and the preview backend; it hasn't yet been run against the live SteamGridDB API on a large library.
- The **live-tile director** analyses each cached micro-trailer once in the page (an offscreen video, frames scored in a worker). Its heuristics can't read text, so a title card on a busy, colourful background may still be chosen; very short or very dull clips loop whole. At the loop point the last frame is held for the time a seek takes (usually a frame or two) under the crossfade. It has been tuned on synthetic frames and the preview loop, not yet on a broad set of real Steam micro-trailers.
- Storage Studio breaks down only the games VYSTRAL knows about; "everything else" on a drive is the remainder.
- The summon shortcut can't use most Win-key combinations (Windows reserves them). If another app already registered the same shortcut, Settings says so.
- The Pulse window is a normal always-on-top window, so it can't appear over exclusive-fullscreen games (borderless works). This is by design: no overlays are injected into games.
- Per-game profiles cover launch options and the preferred store. Display, audio-device and power-plan switching aren't implemented.
- Moments has no tagging yet, and videos can't be seeked (they're served as a stream).
- Local AI needs Ollama installed separately. Answers come from a small local model and can be wrong; they are labelled as such.
- Store sale and update news (Library Radar) isn't implemented; there was no reliable, lawful free source.
- **Data sources:** SteamGridDB, IGDB, RAWG and IsThereAnyDeal need your own free key (IGDB needs your own Twitch developer application with two-factor authentication on your Twitch account). Their parsing is tested against samples shaped after each provider's documentation, not against live keyed answers. CheapShark, Wikidata, the Steam Deck report and AreWeAntiCheatYet were checked live.
- **Deals and prices** are looked up by Steam app ID only, so games from other stores show no Deals card and aren't priced in the library value. CheapShark prices are always US dollars; IsThereAnyDeal and Steam prices follow the price country in Settings.
- **Library value dates** are the earliest evidence VYSTRAL has (first tracked session, first Steam achievement, a store last-played date, or when VYSTRAL first saw the game), not purchase dates: the Steam Web API has no acquisition time, and VYSTRAL won't decrypt Steam's licence cache. Values are today's store prices, never what you paid; free and delisted games count as unpriced.
- **Wikidata** coverage is good for well-known games and thin for small indies; its IDs are used only for links and duplicate *suggestions*. Lookups are by Steam app ID or GOG product ID (Epic, Xbox and other stores' own IDs aren't looked up yet). No pre-built ID map ships with releases.
- **Steam Deck compatibility** comes from the Steam store's public but undocumented report endpoint; Valve can change it at any time. Test-result wording is VYSTRAL's plain-English rendering of Valve's result codes.
- **Anti-cheat badges** cover games AreWeAntiCheatYet lists by Steam app ID; its status describes Linux/Steam Deck, not Windows. “Kernel anti-cheat” marks products widely documented to load a kernel driver; it isn't measured on your PC. There is no library filter chip for anti-cheat yet.
- **Enrichment** fills only empty fields; there's no per-field editor or “pin this match” yet, and a wrong IGDB/RAWG match can't be corrected from the interface yet (exact-title matches are kept unique and year-checked to make this rare).

**Updates and rollback**
- Silent rollback works from the first version that has it onward: the version you update *from* must have preserved its own package before downloading, so the first update onto a rollback-capable version (e.g. 0.3.1 → 0.4.0) can't roll back. The state machine is unit-tested; the full Velopack downgrade (local feed, `AllowVersionDowngrade`, `ApplyUpdatesAndRestart` with an older package) still needs a live test with two real installed versions.
- A version that crashes *before* VYSTRAL's own startup code runs (inside Velopack's startup hooks or the .NET runtime itself) can't be detected or rolled back. Neither can a version that starts but misbehaves later: only failed starts count.
- If the preserved package can't be hard-linked (data folder on another drive), it's a full copy (~100 MB) until the next update replaces it or the new version starts successfully.
- Closing VYSTRAL before its interface has appeared counts as a failed start; doing that twice right after an update could roll it back.
- "What's new" and "New" badges can't know which version you used before this feature existed, so on the first update that has them (0.4.0) existing users see 0.3 and 0.4 badges once.
- Network health checks reachability from this PC at that moment; it can't see a service's own status page, and a check through a proxy reports the proxy's behaviour.

**Games started outside VYSTRAL (background tracker, opt-in)**
- One game is tracked at a time. If two installed games run together, the second gets its own session (starting when it was first seen) only after the first closes, and without performance readings for the overlap.
- Only installed games in the library are recognised, by install folder (or, for games without one, a distinctive executable name). Always-running apps that a store lists as games (wallpaper engines, frame-rate tools, recording software) would be recorded as play time: hide them in the library or choose *Don't track this game* in Settings. Games installed in a folder too broad to identify (a drive root, Program Files, the user profile) are never noticed.
- A game that never takes the foreground (some console or server tools) is noticed by the once-a-minute full scan, so its session starts up to a minute late. Sessions shorter than a minute aren't kept.
- After a hand-over between the app and the background tracker, the FPS summary (1% lows, frame-time histogram) covers only the part after the hand-over, and the background-app report only the part before it; CPU/GPU averages cover the whole session.
- Starting with Windows needs the installed app: development builds and the portable copy notice games only while they're open. The tracker starts at sign-in, so games started before signing in (or while it's turned off in Task Manager › Startup apps) aren't seen until it runs.
- During a background session with performance recording on, the tracker costs what the app costs while recording (most of it reading Windows' GPU engine counters; see PERFORMANCE.md).
- The tracker never installs updates itself (the updater window would appear at sign-in); a downloaded update installs the next time VYSTRAL is opened or closed, as before. If the updater finds the tracker running, it stops it (gracefully when it can) and starts it again afterwards.
- Verified with the real tracker process against a scratch data folder (detection, saved sessions, hand-over to a simulated app and back, stopping). The sign-in entry, the Velopack update/uninstall hooks and the toast from the tracker still need checking on an installed build.

**Platform**
- UI tests run in Chromium against preview data. Tests against the real WebView2 are manual (`ui/scripts/cdp-shot.mjs`).
- Display-scaling changes, monitor hot-plug, sleep/resume and controller hot-plug have not been tested yet.
