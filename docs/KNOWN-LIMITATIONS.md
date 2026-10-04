# Known limitations (v0.1.0)

**Distribution**
- The installer and app are **not code-signed**, so Windows SmartScreen shows an "unknown publisher" warning. Signing needs a paid certificate, or Azure Trusted Signing, which isn't set up yet. VYSTRAL does not try to bypass SmartScreen.
- x64 only. ARM64 builds are possible but not produced yet.
- Install size is about 240 MB uncompressed, because .NET and the Windows App SDK are bundled so nothing else needs installing. Delta updates keep later downloads small.

**Integrations**
- Only installed games are imported. Owned-but-not-installed games would need store accounts or keys (Steam Web API key support is planned as an opt-in).
- No achievements yet for any store.
- Store playtime is available only from Steam's local records. Everywhere else, VYSTRAL tracks sessions started from VYSTRAL.
- EA: `origin2://` launch is used with the installer content ID; some titles may need launching from the EA app if it rejects the ID. Entries without a content ID are skipped.
- Battle.net: classic titles (Diablo II, Warcraft III) aren't detected. Launch arguments for Battle.net have not been verified on a live install.
- Xbox: the WinRT discovery path is unit-tested below the API boundary, but no Game Pass game was installed on the development machine for a live end-to-end test.
- Epic, GOG, Ubisoft and Battle.net were not installed on the development machine; their adapters are verified with fixture-based tests modelled on real files (and Playnite's long-standing parsers).

**Performance data**
- **FPS and frame times are not measured.** That needs Intel PresentMon with ETW access (admin rights or the Performance Log Users group). VYSTRAL says so instead of estimating.
- GPU temperature is NVIDIA-only (NVML). Other GPUs show "unavailable".
- CPU/GPU/RAM are system-wide values while your game runs, not per-game.

**Features**
- The Pulse window is a normal always-on-top window, so it can't appear over exclusive-fullscreen games (borderless works). This is by design: no overlays are injected into games.
- Per-game profiles cover launch options and the preferred store. Display, audio-device and power-plan switching aren't implemented.
- Moments has no tagging yet, and videos can't be seeked (they're served as a stream).
- Local AI needs Ollama installed separately. Answers come from a small local model and can be wrong; they are labelled as such.
- Store sale and update news (Library Radar) isn't implemented; there was no reliable, lawful free source.

**Platform**
- UI tests run in Chromium against preview data. Tests against the real WebView2 are manual (`ui/scripts/cdp-shot.mjs`).
- Display-scaling changes, monitor hot-plug, sleep/resume and controller hot-plug have not been tested yet.
