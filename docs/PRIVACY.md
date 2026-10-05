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

VYSTRAL never reads store credentials, cookies, tokens, saves or game memory.

## When VYSTRAL uses the network

| Feature | Destination | What is sent | Default |
|---|---|---|---|
| Game details & artwork | `store.steampowered.com`, `api.steampowered.com`, `shared.akamai.steamstatic.com` | Steam app IDs or game titles (to find exact matches) | On; can be turned off in Settings |
| Update checks & downloads | `github.com`, `api.github.com`, `objects.githubusercontent.com` | Standard HTTPS requests for the release feed | On; can be turned off |
| Steam Web API (owned games, achievements) | `api.steampowered.com` | Your own key and your SteamID64 | Off until you add a key |
| Achievements after a session | `api.steampowered.com` (and Steam's CDN for the new achievements' icons) | The same requests as above, for the one game you just played: once ~5 s after it closes and once more ~60 s later if Steam hasn't caught up | Only with a key; never with Offline mode or Data saver, never while a game runs |
| Trailers | Steam's video CDN (`video.*.steamstatic.com`, `cdn.*.steamstatic.com`) | Requests for a Steam game's public trailer stream; nothing is saved | On; off with Offline mode or Data saver, and never while a game runs |
| Frame-rate capture | `github.com` (PresentMon release) | A one-time download you start yourself | Off |
| Local AI | `127.0.0.1:11434` (Ollama on your PC) | Your question plus a summary of your library, all on this PC | Off |

**Offline mode** (Settings → Privacy) turns off every optional network feature. Your games and store apps keep using their own services as usual; VYSTRAL doesn't see or change that traffic.
