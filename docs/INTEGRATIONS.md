# Integration capability matrix

Every integration reads only what the store app already keeps on this PC. VYSTRAL never asks for store passwords, never reads tokens or cookies, never calls private endpoints, and never writes store files. The in-app list (Settings → Library & stores) shows the same capabilities and limitations, taken directly from each adapter.

| | Finds installed | Owned (not installed) | Launch method | Needs store app | Store playtime | Last played | Local artwork | Session tracking |
|---|---|---|---|---|---|---|---|---|
| **Steam** | ✅ `libraryfolders.vdf` + `appmanifest_*.acf` | ✅ opt-in, with your own Steam Web API key (`IPlayerService/GetOwnedGames`); achievements via `ISteamUserStats` | `steam://rungameid/<appid>` (launch options via `steam.exe -applaunch`) | Yes | ✅ `userdata/<id>/config/localconfig.vdf` | ✅ | ✅ `appcache/librarycache` | ✅ install-dir processes |
| **Xbox / PC Game Pass** | ✅ `PackageManager.FindPackagesForUser` + `MicrosoftGame.config` / `.GamingRoot` | ❌ | Packaged-app activation by AUMID | Gaming Services | ❌ | ❌ | ✅ package logos | ✅ PID from activation + package dir |
| **Epic Games** | ✅ `Manifests/*.item` + `LauncherInstalled.dat` | ❌ (no public library API) | `com.epicgames.launcher://apps/…?action=launch&silent=true` | Yes | ❌ | ❌ | ❌ (Steam store art when exact title match) | ✅ |
| **GOG** | ✅ uninstall keys `<id>_is1` + `goggame-<id>.info` (registry fallback) | ❌ | Direct exe from the primary play task (DRM-free) | No | ❌ | ❌ | Icon | ✅ |
| **EA app** | ✅ EA uninstall entries + `__Installer/installerdata.xml` | ❌ | `origin2://game/launch?offerIds=<contentId>` | Yes | ❌ | ❌ | ❌ | ✅ |
| **Ubisoft Connect** | ✅ `HKLM\…\Ubisoft\Launcher\Installs\<id>` | ❌ | `uplay://launch/<id>/0` | Yes | ❌ | ❌ | ❌ | ✅ |
| **Battle.net** | ✅ uninstall entries with `--uid=` → product code | ❌ | `Battle.net.exe --exec="launch <CODE>"` | Yes | ❌ | ❌ | ❌ | ✅ |
| **Added by you** | — | — | Direct exe (+ your arguments) | No | — | — | Icon / your images | ✅ |

## Notes and caveats

- **Steam:** install and update progress comes from the byte counters in `appmanifest_*.acf`, read by a debounced file watcher; nothing is written. With a Web API key, owned games appear as "not installed" entries and achievements are cached per game. Trailers use Steam's public HLS streams through a filtered local proxy.
- **Steam (Track P):** the update-space forecast reads `StateFlags`, `buildid`/`TargetBuildID`, `BytesToDownload`/`BytesDownloaded`, `BytesToStage`/`BytesStaged`, `SizeOnDisk`, `UpdateResult`, `AutoUpdateBehavior` and `ScheduledAutoUpdate` from every library's app manifests (a FileSystemWatcher on `steamapps` plus a 10-minute check) and the library drive's free space (`GetDiskFreeSpaceEx`). Room still needed = remaining download + remaining staging (Steam keeps downloaded chunks and staged files side by side until it commits). With a Web API key and the opt-in setting, *Friends playing now* uses `ISteamUser/GetFriendList/v1` (relationship=friend) and `ISteamUser/GetPlayerSummaries/v2` (100 IDs per request); avatars are copied into the art cache from Steam's avatar CDN only.
- **Steam:** redistributables (appid 228980) and tools are skipped. Playtime comes from the most recently signed-in account (`loginusers.vdf`). Games installed through Steam but sold by EA (for example *EA SPORTS FC*) appear as Steam games, and the EA adapter deliberately ignores installs inside Steam libraries.
- **Xbox:** a package counts as a game only if it ships `MicrosoftGame.config` or lives under a folder marked by `.GamingRoot`, which avoids listing ordinary Store apps. Launching needs no admin rights. Some games protect their install folders; tracking then falls back to the process ID returned by activation.
- **Epic:** DLC, Unreal Engine plugins and incomplete installs are filtered out. Epic offers no local playtime; VYSTRAL tracks sessions you start from VYSTRAL.
- **EA:** entries without a content ID are skipped rather than guessing an executable. Whether every content ID is accepted as an `offerIds` value is unverified (see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)).
- **Ubisoft:** stale registry keys with no values, or that point at the launcher itself, are ignored.
- **Battle.net:** classic titles (Diablo II, Warcraft III) aren't detected yet.
- **Metadata & artwork (optional):** Steam's public store pages (`store.steampowered.com/api/appdetails`, `storesearch`) and CDN (`shared.akamai.steamstatic.com`). Non-Steam games are matched only on an exact normalized title with a single result. All requests are rate-limited and can be disabled.

## Data sources (optional, Settings → Library & stores → Data sources)

These add art, details, prices and compatibility on top of the store integrations. All are off in Offline mode, each has its own switch, and keyed ones use **your own** key stored only in Windows Credential Manager (`VYSTRAL/SteamGridDB`, `VYSTRAL/IGDB`, `VYSTRAL/RAWG`, `VYSTRAL/IsThereAnyDeal`). A key is saved only after the provider accepts it in a test request. Code: `src/Vystral.Windows/DataSources/`.

| Source | Access | Used for | Matching | Cache |
|---|---|---|---|---|
| **SteamGridDB** | Your API key (Bearer) | Artwork picker on the game page (cover 600×900, background, logo, icon); safe-for-work, static by default, filters by style | Steam appid (`/games/steam/<appid>`), else a unique exact title, else you pick from candidates | Previews under the art cache `_thumbs/sgdb/`; chosen art is user art (`is_user = 1`) |
| **IGDB** | Your own Twitch app (client ID + secret → client-credentials token kept in memory) | Fills missing description, genres, release date, developer, publisher; shows themes, modes, perspective, series/franchise, similar games, critic/overall rating and time to beat (`game_time_to_beats`) | `external_games` by Steam appid → Wikidata IGDB slug → exact title (unique, year ±1 when known) | 30 days; no-match retried after 7 days |
| **RAWG** | Your API key | Same missing fields; shows user rating, average playtime, ESRB. Metacritic numbers from RAWG are not used | Wikidata RAWG slug → exact title confirmed by RAWG's Steam store link for the same appid → exact title | 30 days |
| **CheapShark** | Keyless | “Deals” card: best price now (USD), shops, lowest price ever | Steam appid only | 6 hours, fetched only when the game page opens |
| **IsThereAnyDeal** | Your API key (`ITAD-API-Key` header) | Prices across shops in your price country and the historical low | Steam appid (`/games/lookup/v1`) | 6 hours, on page open |
| **Wikidata** | Keyless (CC0) | “Same game elsewhere” on the Versions tab (Steam, GOG, Epic, Microsoft Store, IGDB, PCGamingWiki, HowLongToBeat, SteamGridDB, ITAD, RAWG, MobyGames) and duplicate *suggestions* (never merges) | Steam appid (P1733) or GOG product ID (P12727); batches of 100 | 30 days; “no item” 7 days |
| **Steam Deck compatibility** | Keyless (Steam store's public report, grey area) | Verified / Playable / Unsupported badge with Valve's test results | Steam appid; only while “Fetch game details” is on | 7 days |
| **AreWeAntiCheatYet** | Keyless (MIT dataset on GitHub) | Anti-cheat badge (names; “kernel anti-cheat” for products widely documented to load a kernel driver) and Linux/Deck status per AWACY | Steam appid | Whole list, refreshed at most weekly (ETag) |
| **Steam store prices** | Keyless (`appdetails?filters=price_overview`, 100 apps per request) | Journal → Library value (today's price, never what you paid) | Steam appid | 24 hours, fetched when the tab opens |

Enrichment never overwrites a field that already has a value or that you set; every filled field records its source (`game_field_sources`), and the game page shows “From IGDB/RAWG” with how the match was made. Enrichment runs in the background (40 games per round, every six hours), pauses while a game runs, honours each provider's rate limits (IGDB 4/s, `Retry-After` on 429), and stops for the round on errors.

### What VYSTRAL builds on these (v0.5, Track M; no extra requests)

- **Time-to-beat bars** on library cards, list rows and game pages, and the *Closest to finishing* sort, read IGDB's cached `game_time_to_beats` (labelled “IGDB estimate”). Only with your IGDB credentials; off with *Settings → Library & stores → Time to beat*.
- **Anti-cheat notes** in pre-flight and on game pages use the cached AreWeAntiCheatYet list and `AntiCheatClient.KernelLevel`; informative only (`status: info`), off with *Settings → Launching & sessions → Anti-cheat notes*.
- **Estimated savings on your backlog** (Journal → Library value) uses cached CheapShark/IsThereAnyDeal quotes: best current offer minus the historical low, per currency.
- **Next big sale** uses `src/Vystral.Windows/Recap/steam-sales.json`: Steam seasonal sale dates from Valve's Steamworks page *Upcoming Steam Events* (https://partner.steamgames.com/doc/marketing/upcoming_events), versioned with its retrieval date and validated by unit tests (https on a Valve domain, ordered, non-overlapping, ≤ 60 days each). Update it by hand when Valve publishes new dates.

## Steam Input layouts (v0.6, Track Q; read-only, local)

The game page's **Controls** tab shows the Steam Input layout Steam would use for a Steam game, from files Steam keeps on this PC. VYSTRAL never downloads layouts (Valve's official and community configs are read only once Steam itself has put them on disk) and never writes one.

- **Which layout:** `steamapps/common/Steam Controller Configs/<account>/config/configset_<controller>.vdf` maps an app id to `"template"` (a file in `controller_base/templates/`), `"workshop"` (a folder under `steamapps/workshop/content/241100/`) or `"autosave"` (your own edits in `…/config/<appid>/controller_<type>.vdf`). Xbox sets are preferred, then other pads, then device-specific sets (newest first). With no entry, a saved layout in `…/config/<appid>/` or the older `userdata/<account>/241100/remote/controller_config/<appid>/` is used. With nothing at all, the tab says the game uses its own controller support.
- **Parsing** (`Vystral.Core/Controller/SteamInputLayout.cs`): text KeyValues `controller_mappings` version 2 or 3, ≤ 2 MB, nesting ≤ 24, at most 512 groups, 64 presets, 64 inputs per group and 8 bindings per activator; strings cleaned and clipped. Files must be inside Steam's folder and not links out of it; template and workshop names are validated by pattern.
- **Mapping:** presets are action sets (`actions`) or layers (`action_layers`, shown merged over their parent set: a source the layer defines replaces the parent's). `group_source_bindings` picks the active group per source (`button_diamond`, `dpad`, `joystick`, `right_joystick`, `left_trigger`, `right_trigger`, `switch`, trackpads, gyro); in `switch`, `button_escape` is Menu (≡) and `button_menu` is View (⧉). Bindings become words: `key_press SPACE, Jump` → "Jump" (Space), `mouse_button LEFT` → "Left click", `xinput_button shoulder_left` → "LB", `game_action <set> <action>` → the action's localized title, `controller_action CHANGE_PRESET n` → "Switch to <set>" (preset ids in bindings are 1-based), `hold_layer` / `add_layer` / `remove_layer`, `mode_shift`.

## Adding a store

Implement `IPlatformAdapter` (see `SteamAdapter` for the reference pattern), keep it read-only and tolerant of malformed data, add fixture tests using `TempDir` and `FakeRegistry`, register it in `AdapterCatalog`, and add its launch scheme to `LaunchValidator`.
