# Third-party notices

VYSTRAL is built on these open-source components. A full machine-readable list of every dependency (including transitive ones) is generated into `docs/sbom/` by `build/sbom.ps1`.

| Component | License | Use |
|---|---|---|
| .NET 10 runtime | MIT | Runtime (bundled) |
| Windows App SDK / WinUI 3 | MIT | Window, controls, app lifecycle (bundled) |
| Microsoft.Web.WebView2 SDK | BSD-style (Microsoft) | Hosting the interface; the WebView2 Runtime is part of Windows |
| Velopack | MIT | Installer and auto-update |
| Microsoft.Data.Sqlite / SQLitePCLRaw / SQLite | MIT / Apache-2.0 / Public domain | Local database |
| Dapper | Apache-2.0 | Data access |
| React, React DOM | MIT | Interface |
| Motion | MIT | Animation |
| Zustand | MIT | State |
| TanStack Virtual | MIT | List virtualization |
| three.js | MIT | Constellation view |
| Lucide icons | ISC | Icons |
| Geist, Geist Mono | SIL Open Font License 1.1 | Typography (bundled) |
| Unbounded | SIL Open Font License 1.1 | Display typography (bundled) |
| Vite, TypeScript, Vitest, Playwright, axe-core | MIT / Apache-2.0 / MPL-2.0 | Build and test only (not shipped) |
| xunit v3 | Apache-2.0 | Tests only |

NVIDIA NVML (`nvml.dll`) is used read-only when it is already installed with NVIDIA drivers; it is not redistributed.

Intel PresentMon (MIT, © Intel Corporation, https://github.com/GameTechDev/PresentMon) is **not** bundled. Only if the user turns on frame-rate capture does VYSTRAL download the official `PresentMon-2.6.0-x64.exe` release asset into its data folder, verifying SHA-256 `b2a706bc6ad475749e3b7e3409263aa1e6906d45bdcf993f6dbc0f660188f1af` before each use. Ollama and AI models are not bundled. Users install them separately under their own licenses (the recommended `qwen3:4b` is Apache-2.0).

**Store logos.** The Steam, Epic Games, GOG.com, EA, Ubisoft and Battle.net marks are drawn from [Simple Icons](https://simpleicons.org) 16.34.0 (the drawings are CC0-1.0; slugs `steam`, `epicgames`, `gogdotcom`, `ea`, `ubisoft`, `battledotnet`), copied into `ui/src/lib/storeMarks.ts` rather than bundling the package. Simple Icons no longer carries Microsoft's marks, so the Xbox sphere is the `xbox` icon from [Bootstrap Icons](https://icons.getbootstrap.com) 1.13.1 (MIT licence, Copyright (c) 2019-2024 The Bootstrap Authors), moved from its 16-unit grid to a 24-unit one (every coordinate × 1.5, the shape unchanged). Games you added yourself get a plain folder glyph, which is not a store's logo.

**Service logos.** Marks for services that aren't stores (`ui/src/lib/serviceMarks.ts`) are also Simple Icons 16.34.0 drawings (CC0-1.0): `steamdeck` (Steam Deck compatibility), `igdb`, `twitch` (IGDB's developer sign-up), `wikidata`, `ollama` (local AI), and `nvidia`, `amd`, `intel` (shown beside a graphics card's name when Windows reports its maker; NVIDIA's mark also stands for GeForce NOW, which has no mark of its own in Simple Icons). Xbox Cloud Gaming reuses the Bootstrap Icons Xbox sphere above. SteamGridDB, RAWG, IsThereAnyDeal, CheapShark, AreWeAntiCheatYet, PresentMon and anti-cheat systems have no openly licensed mark, so they get plain descriptive Lucide icons (artwork, database, price tag, percent badge, shield, pulse) rather than imitations.

Store, service and hardware names and logos are trademarks of their owners, used only to identify the store a game comes from, where data comes from or what it runs on; VYSTRAL is not affiliated with or endorsed by Valve, Microsoft, Epic Games, CD PROJEKT (GOG), Electronic Arts, Ubisoft, Blizzard Entertainment, Twitch/Amazon (IGDB), the Wikimedia Foundation, Ollama, NVIDIA, AMD or Intel. The marks are shown in one colour (or the owner's hue on hover) and never altered, combined or used as VYSTRAL's own branding.

**Steam micro-trailers.** Live tiles play the short silent loops Valve publishes beside each Steam store trailer. They are fetched on demand from Steam's public CDN and cached privately on the user's PC, like artwork; they belong to the games' publishers.

Game names, artwork and descriptions shown in VYSTRAL belong to their respective owners. Artwork comes from the user's store apps' local caches or Steam's public CDN and is cached privately on the user's PC.

## Game data sources (fetched at runtime, never bundled)

No third-party game data ships with VYSTRAL. These sources are contacted only when enabled (Settings → Library & stores → Data sources), never in Offline mode, and their data is cached privately on the user's PC. The interface credits each source wherever its data appears.

| Source | Licence / terms | How VYSTRAL respects them |
|---|---|---|
| Wikidata (query.wikidata.org) | CC0 1.0 (public domain) | Credited as “Store IDs from Wikidata” with a link to the item; descriptive User-Agent with the project URL, one query at a time |
| AreWeAntiCheatYet `games.json` | MIT, © 2021 Starz0r, Curve (github.com/AreWeAntiCheatYet/AreWeAntiCheatYet) | Downloaded at most weekly with ETag; credited “per AreWeAntiCheatYet” with a link. Its status describes Linux/Steam Deck support, and VYSTRAL says so |
| Steam store (Deck compatibility report, prices) | Valve's data; public store endpoints | Shown as “as reported by Valve”; on demand, cached (7 days for Deck, 24 h for prices) |
| SteamGridDB | Community artwork, copyrighted by its artists; SteamGridDB terms (personal, non-commercial use) | User's own key; each picked image is credited to its author; nothing is redistributed |
| IGDB (Twitch) | Twitch Developer Services Agreement | User's own Twitch application; “Data from IGDB.com” with a link on every page showing it |
| RAWG | RAWG API terms (attribution and an active link back required; no redistribution) | User's own key; “Data from RAWG.io” with a link on every page showing it. RAWG's Metacritic number is not used |
| CheapShark | CheapShark API terms (no catalog building) | Called only when a game page is opened; deal links go through CheapShark's own redirect unchanged |
| IsThereAnyDeal | ITAD API terms (data and links unchanged, link to ITAD) | User's own key; prices and shop links shown exactly as sent, with a link to ITAD |
