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

NVIDIA NVML (`nvml.dll`) is used read-only when it is already installed with NVIDIA drivers; it is not redistributed. Ollama and AI models are not bundled. Users install them separately under their own licenses (the recommended `qwen3:4b` is Apache-2.0).

Game names, artwork and descriptions shown in VYSTRAL belong to their respective owners. Artwork comes from the user's store apps' local caches or Steam's public CDN and is cached privately on the user's PC.
