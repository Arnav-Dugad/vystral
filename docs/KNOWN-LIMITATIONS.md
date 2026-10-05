# Known limitations (v0.2.0)

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
- Selecting a Windows notification doesn't open the matching page yet: `AppNotificationManager.Register()` fails in self-contained Windows App SDK 2.5.1 apps ([microsoft/WindowsAppSDK#6774](https://github.com/microsoft/WindowsAppSDK/issues/6774)). Notifications are still shown, and Settings explains this.
- Trailers are available for Steam games only (Steam's public HLS streams).
- Storage Studio breaks down only the games VYSTRAL knows about; "everything else" on a drive is the remainder.
- The summon shortcut can't use most Win-key combinations (Windows reserves them). If another app already registered the same shortcut, Settings says so.
- The Pulse window is a normal always-on-top window, so it can't appear over exclusive-fullscreen games (borderless works). This is by design: no overlays are injected into games.
- Per-game profiles cover launch options and the preferred store. Display, audio-device and power-plan switching aren't implemented.
- Moments has no tagging yet, and videos can't be seeked (they're served as a stream).
- Local AI needs Ollama installed separately. Answers come from a small local model and can be wrong; they are labelled as such.
- Store sale and update news (Library Radar) isn't implemented; there was no reliable, lawful free source.

**Platform**
- UI tests run in Chromium against preview data. Tests against the real WebView2 are manual (`ui/scripts/cdp-shot.mjs`).
- Display-scaling changes, monitor hot-plug, sleep/resume and controller hot-plug have not been tested yet.
