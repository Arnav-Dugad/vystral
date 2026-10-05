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
| System.Diagnostics.PerformanceCounter | MIT | Read-only performance counters |
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

**Store logos.** The Steam, Epic Games, GOG.com, EA, Ubisoft and Battle.net marks are drawn from [Simple Icons](https://simpleicons.org) 16.34.0 (the drawings are CC0-1.0; slugs `steam`, `epicgames`, `gogdotcom`, `ea`, `ubisoft`, `battledotnet`), copied into `ui/src/lib/storeMarks.ts` rather than bundling the package. Simple Icons has no Xbox or Microsoft Store mark, so VYSTRAL shows a neutral "X" monogram for Xbox and a plain folder glyph for games you added yourself — neither is a store's logo. Store names and logos are trademarks of their owners, used only to identify the store a game comes from; VYSTRAL is not affiliated with or endorsed by Valve, Microsoft, Epic Games, CD PROJEKT (GOG), Electronic Arts, Ubisoft or Blizzard Entertainment. The marks are shown in one colour (or the store's hue on hover) and never altered, combined or used as VYSTRAL's own branding.

**Steam micro-trailers.** Live tiles play the short silent loops Valve publishes beside each Steam store trailer. They are fetched on demand from Steam's public CDN and cached privately on the user's PC, like artwork; they belong to the games' publishers.

Game names, artwork and descriptions shown in VYSTRAL belong to their respective owners. Artwork comes from the user's store apps' local caches or Steam's public CDN and is cached privately on the user's PC.
