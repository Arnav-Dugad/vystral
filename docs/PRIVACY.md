# Privacy statement

VYSTRAL is local-first software. There is no VYSTRAL account, no server, no telemetry, no analytics, no crash reporting to anyone, and no advertising.

## What VYSTRAL stores (only on your PC)

`%LOCALAPPDATA%\VYSTRAL.Data\`:

- `vystral.db`: your library (titles, install paths, sizes, store IDs), notes, ratings, collections, settings, sessions you start from VYSTRAL, optional performance readings, and an audit log of changes VYSTRAL made.
- `cache\`: artwork copied from your stores' local caches or downloaded from Steam's public CDN, and thumbnails.
- `logs\`: diagnostic logs, 7 days. They include file paths, never passwords or tokens.
- `webview\`: the interface's browser profile.
- `backups\`: database backups.

Export your journal from Settings → Data. Delete tracked history there too, or delete the whole folder to remove everything.

## What VYSTRAL reads

- Store manifests and registry entries describing installed games (read-only).
- Steam's local "last played" and playtime records for the most recently signed-in account.
- With Moments on: images and videos in Steam's screenshot folders, Xbox Game Bar captures and folders you add.
- While a game you launched runs, if enabled: system CPU/GPU/memory load and GPU temperature (read-only counters).
- Names and paths of running processes, to detect when your game starts and stops.

- With frame-rate capture on: frame timing events for the game you launched, via PresentMon (ETW). No game memory or content.

If you add a Steam Web API key, it's stored in Windows Credential Manager (`VYSTRAL/SteamWebApiKey`), never in the database or logs. Removing it in Settings deletes it.

VYSTRAL never reads store credentials, cookies, tokens, saves or game memory.

## When VYSTRAL uses the network

| Feature | Destination | What is sent | Default |
|---|---|---|---|
| Game details & artwork | `store.steampowered.com`, `api.steampowered.com`, `shared.akamai.steamstatic.com` | Steam app IDs or game titles (to find exact matches) | On; can be turned off in Settings |
| Update checks & downloads | `github.com`, `api.github.com`, `objects.githubusercontent.com` | Standard HTTPS requests for the release feed | On; can be turned off |
| Steam Web API (owned games, achievements) | `api.steampowered.com` | Your own key and your SteamID64 | Off until you add a key |
| Trailers | Steam's video CDN (`video.*.steamstatic.com`, `cdn.*.steamstatic.com`) | Requests for a Steam game's public trailer stream; nothing is saved | On; off with Offline mode or Data saver, and never while a game runs |
| Frame-rate capture | `github.com` (PresentMon release) | A one-time download you start yourself | Off |
| Local AI | `127.0.0.1:11434` (Ollama on your PC) | Your question plus a summary of your library, all on this PC | Off |

**Offline mode** (Settings → Privacy) turns off every optional network feature. Your games and store apps keep using their own services as usual; VYSTRAL doesn't see or change that traffic.
