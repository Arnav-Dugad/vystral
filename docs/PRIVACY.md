# Privacy statement

VYSTRAL is local-first software. There is no VYSTRAL account, no server, no telemetry, no analytics, no crash reporting to anyone, and no advertising.

## What VYSTRAL stores (only on your PC)

`%LOCALAPPDATA%\VYSTRAL.Data\`:

- `vystral.db`: your library (titles, install paths, sizes, store IDs), notes, ratings, collections, settings, sessions you start from VYSTRAL, optional performance readings, and an audit log of changes VYSTRAL made. With performance recording on, each session also stores:
  - the **graphics card name and driver version** it ran on (for the "FPS before/after a driver change" card);
  - the **program file names of the heaviest other apps** running alongside the game (for example `Discord.exe`), with their average/peak memory and average CPU share, and the system's memory load. No paths, window titles, command lines or contents. Your game, VYSTRAL itself and core Windows processes are left out, as are processes of other users and services. Turn this off with *Settings → Launching & sessions → Note which other apps are running*, and hide any app from the report;
  - cached Steam achievements (when you connected a Steam Web API key) power the Journal's achievement timeline; nothing extra is downloaded for it except achievement icons from Steam's CDN, and never with Offline mode or Data saver on.
- `cache\`: artwork copied from your stores' local caches or downloaded from Steam's public CDN, and thumbnails.
- `logs\`: diagnostic logs, 7 days. They include file paths, never passwords or tokens.
- `webview\`: the interface's browser profile.
- `backups\`: database backups.

Export your journal from Settings → Data. Delete tracked history there too (this also deletes the recorded background-app names, the list of apps you hid, and the driver versions stored with sessions), or delete the whole folder to remove everything.

## What VYSTRAL reads

- Store manifests and registry entries describing installed games (read-only).
- Steam's local "last played" and playtime records for the most recently signed-in account.
- With Moments on: images and videos in Steam's screenshot folders, Xbox Game Bar captures and folders you add.
- While a game you launched runs, if enabled: system CPU/GPU/memory load and GPU temperature (read-only counters).
- Names and paths of running processes, to detect when your game starts and stops.
- While a game you launched runs, if enabled: names, memory and CPU time of other running processes (one handle-free system snapshot about every 30 seconds), and your graphics driver version (once per session).

- With frame-rate capture on: frame timing events for the game you launched, via PresentMon (ETW). No game memory or content.

If you add a Steam Web API key, it's stored in Windows Credential Manager (`VYSTRAL/SteamWebApiKey`), never in the database or logs. Removing it in Settings deletes it.

The same applies to keys for optional data sources: `VYSTRAL/SteamGridDB`, `VYSTRAL/IGDB` (your Twitch application's client ID and secret), `VYSTRAL/RAWG` and `VYSTRAL/IsThereAnyDeal`. The IGDB access token they produce is kept in memory only. The interface only ever learns whether a key exists and its last four characters. These keys are yours: VYSTRAL ships no shared keys.

What data sources return is cached in `vystral.db`: Wikidata store IDs per Steam/GOG ID, IGDB/RAWG details and which source filled which field, prices (6–24 hours), Steam Deck reports (7 days) and the AreWeAntiCheatYet list. Every lookup tells that provider that this IP address asked about that game; prefer leaving keyed sources off if that matters to you, and use Offline mode to stop all of them.

VYSTRAL never reads store credentials, cookies, tokens, saves or game memory.

## When VYSTRAL uses the network

| Feature | Destination | What is sent | Default |
|---|---|---|---|
| Game details & artwork | `store.steampowered.com`, `api.steampowered.com`, `shared.akamai.steamstatic.com` | Steam app IDs or game titles (to find exact matches) | On; can be turned off in Settings |
| Update checks & downloads | `github.com`, `api.github.com`, `objects.githubusercontent.com` | Standard HTTPS requests for the release feed | On; can be turned off |
| Steam Web API (owned games, achievements) | `api.steampowered.com` | Your own key and your SteamID64 | Off until you add a key |
| Achievements after a session | `api.steampowered.com` (and Steam's CDN for the new achievements' icons) | The same requests as above, for the one game you just played: once ~5 s after it closes and once more ~60 s later if Steam hasn't caught up | Only with a key; never with Offline mode or Data saver, never while a game runs |
| Trailers | Steam's video CDN (`video.*.steamstatic.com`, `cdn.*.steamstatic.com`) | Requests for a Steam game's public trailer stream; nothing is saved | On; off with Offline mode or Data saver, and never while a game runs |
| Live tiles (Home) | Steam's video CDN (`video.*.steamstatic.com`) | One request per Steam game for its public ~8 s silent "micro-trailer" (`microtrailer.mp4`, 1.5–3 MB), only when its Home tile is on screen; the file is kept in `cache\live` (at most 160 MB, oldest dropped first; *Clear artwork cache* empties it) | On; off with Offline mode or Data saver (including automatic Data saver on metered connections), never while a game runs; turn off in Settings → Appearance → Live tiles |
| Frame-rate capture | `github.com` (PresentMon release) | A one-time download you start yourself | Off |
| Local AI | `127.0.0.1:11434` (Ollama on your PC) | Your question plus a summary of your library, all on this PC | Off |
| Artwork picker (SteamGridDB) | `www.steamgriddb.com`, `cdn2.steamgriddb.com` | Your own SteamGridDB key, and the Steam app ID or exact title of the game whose picker you opened; then the previews and the image you choose | Off until you add a key; only when you open the picker |
| Game details (IGDB) | `id.twitch.tv`, `api.igdb.com` | Your own Twitch application's client ID and secret (in the body of the token request), then Steam app IDs, IGDB slugs from Wikidata or exact titles of games in your library | Off until you add credentials |
| Game details (RAWG) | `api.rawg.io` | Your own RAWG key, and titles or Wikidata-linked RAWG IDs of games in your library | Off until you add a key |
| Prices (CheapShark) | `www.cheapshark.com` | The Steam app ID of the game whose page you opened | On; only on page open, switch in Settings |
| Prices (IsThereAnyDeal) | `api.isthereanydeal.com` | Your own ITAD key, the Steam app ID of the game whose page you opened, and your price country | Off until you add a key |
| Cross-store IDs (Wikidata) | `query.wikidata.org` | Steam app IDs (and GOG product IDs) of games in your library, up to 100 per query | On; switch in Settings |
| Steam Deck compatibility | `store.steampowered.com` | The Steam app ID of the game whose page you opened | On while “Fetch game details” is on; switch in Settings |
| Anti-cheat list (AreWeAntiCheatYet) | `raw.githubusercontent.com` | Nothing about you or your games: the public list is downloaded whole, at most weekly | On; switch in Settings |
| Library value prices | `store.steampowered.com` | Steam app IDs of games in your library (100 per request) and your price country | On; only when you open Journal → Library value; switch in Settings |
| Opening a deal or “Open on …” link | Your default browser | The browser opens the shop or site page; affiliate links from CheapShark/IsThereAnyDeal are left as those services send them | Only when you click |

**Offline mode** (Settings → Privacy) turns off every optional network feature. Your games and store apps keep using their own services as usual; VYSTRAL doesn't see or change that traffic.
