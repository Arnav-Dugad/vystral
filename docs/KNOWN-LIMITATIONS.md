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
- Storage Studio breaks down only the games VYSTRAL knows about; "everything else" on a drive is the remainder.
- The summon shortcut can't use most Win-key combinations (Windows reserves them). If another app already registered the same shortcut, Settings says so.
- The Pulse window is a normal always-on-top window, so it can't appear over exclusive-fullscreen games (borderless works). This is by design: no overlays are injected into games.
- Per-game profiles cover launch options and the preferred store. Display, audio-device and power-plan switching aren't implemented.
- Moments has no tagging yet, and videos can't be seeked (they're served as a stream).
- Local AI needs Ollama installed separately. Answers come from a small local model and can be wrong; they are labelled as such.
- Store sale and update news (Library Radar) isn't implemented; there was no reliable, lawful free source.

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
