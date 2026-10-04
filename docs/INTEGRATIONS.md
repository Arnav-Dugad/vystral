# Integration capability matrix

Every integration reads only what the store app already keeps on this PC. VYSTRAL never asks for store passwords, never reads tokens or cookies, never calls private endpoints, and never writes store files. The in-app list (Settings → Library & stores) shows the same capabilities and limitations, taken directly from each adapter.

| | Finds installed | Owned (not installed) | Launch method | Needs store app | Store playtime | Last played | Local artwork | Session tracking |
|---|---|---|---|---|---|---|---|---|
| **Steam** | ✅ `libraryfolders.vdf` + `appmanifest_*.acf` | ❌ (needs a user Web API key — not implemented) | `steam://rungameid/<appid>` (launch options via `steam.exe -applaunch`) | Yes | ✅ `userdata/<id>/config/localconfig.vdf` | ✅ | ✅ `appcache/librarycache` | ✅ install-dir processes |
| **Xbox / PC Game Pass** | ✅ `PackageManager.FindPackagesForUser` + `MicrosoftGame.config` / `.GamingRoot` | ❌ | Packaged-app activation by AUMID | Gaming Services | ❌ | ❌ | ✅ package logos | ✅ PID from activation + package dir |
| **Epic Games** | ✅ `Manifests/*.item` + `LauncherInstalled.dat` | ❌ (no public library API) | `com.epicgames.launcher://apps/…?action=launch&silent=true` | Yes | ❌ | ❌ | ❌ (Steam store art when exact title match) | ✅ |
| **GOG** | ✅ uninstall keys `<id>_is1` + `goggame-<id>.info` (registry fallback) | ❌ | Direct exe from the primary play task (DRM-free) | No | ❌ | ❌ | Icon | ✅ |
| **EA app** | ✅ EA uninstall entries + `__Installer/installerdata.xml` | ❌ | `origin2://game/launch?offerIds=<contentId>` | Yes | ❌ | ❌ | ❌ | ✅ |
| **Ubisoft Connect** | ✅ `HKLM\…\Ubisoft\Launcher\Installs\<id>` | ❌ | `uplay://launch/<id>/0` | Yes | ❌ | ❌ | ❌ | ✅ |
| **Battle.net** | ✅ uninstall entries with `--uid=` → product code | ❌ | `Battle.net.exe --exec="launch <CODE>"` | Yes | ❌ | ❌ | ❌ | ✅ |
| **Added by you** | — | — | Direct exe (+ your arguments) | No | — | — | Icon / your images | ✅ |

## Notes and caveats

- **Steam:** redistributables (appid 228980) and tools are skipped. Playtime comes from the most recently signed-in account (`loginusers.vdf`). Games installed through Steam but sold by EA (for example *EA SPORTS FC*) appear as Steam games, and the EA adapter deliberately ignores installs inside Steam libraries.
- **Xbox:** a package counts as a game only if it ships `MicrosoftGame.config` or lives under a folder marked by `.GamingRoot`, which avoids listing ordinary Store apps. Launching needs no admin rights. Some games protect their install folders; tracking then falls back to the process ID returned by activation.
- **Epic:** DLC, Unreal Engine plugins and incomplete installs are filtered out. Epic offers no local playtime; VYSTRAL tracks sessions you start from VYSTRAL.
- **EA:** entries without a content ID are skipped rather than guessing an executable. Whether every content ID is accepted as an `offerIds` value is unverified (see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)).
- **Ubisoft:** stale registry keys with no values, or that point at the launcher itself, are ignored.
- **Battle.net:** classic titles (Diablo II, Warcraft III) aren't detected yet.
- **Metadata & artwork (optional):** Steam's public store pages (`store.steampowered.com/api/appdetails`, `storesearch`) and CDN (`shared.akamai.steamstatic.com`). Non-Steam games are matched only on an exact normalized title with a single result. All requests are rate-limited and can be disabled.

## Adding a store

Implement `IPlatformAdapter` (see `SteamAdapter` for the reference pattern), keep it read-only and tolerant of malformed data, add fixture tests using `TempDir` and `FakeRegistry`, register it in `AdapterCatalog`, and add its launch scheme to `LaunchValidator`.
