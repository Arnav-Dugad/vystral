# Privacy statement

VYSTRAL is local-first software. There is no VYSTRAL account, no server, no telemetry, no analytics, no crash reporting to anyone, and no advertising.

## What VYSTRAL stores (only on your PC)

`%LOCALAPPDATA%\VYSTRAL.Data\`:

- `vystral.db`: your library (titles, install paths, sizes, store IDs), notes, ratings, collections, settings, sessions you start from VYSTRAL, optional performance readings, and an audit log of changes VYSTRAL made. With performance recording on, each session also stores:
  - the **graphics card name and driver version** it ran on (for the "FPS before/after a driver change" card);
  - the **program file names of the heaviest other apps** running alongside the game (for example `Discord.exe`), with their average/peak memory and average CPU share, and the system's memory load. No paths, window titles, command lines or contents. Your game, VYSTRAL itself and core Windows processes are left out, as are processes of other users and services. Turn this off with *Settings → Launching & sessions → Note which other apps are running*, and hide any app from the report;
  - cached Steam achievements (when you connected a Steam Web API key) power the Journal's achievement timeline; nothing extra is downloaded for it except achievement icons from Steam's CDN, and never with Offline mode or Data saver on.
- With *Settings → Launching & sessions → Games started outside VYSTRAL* on (off by default), sessions of installed games you start from anywhere else are stored the same way, marked "Detected" (noticed while VYSTRAL was open) or "Background" (noticed by the background tracker while it was closed). Sessions shorter than a minute aren't kept; hidden games and games you tell VYSTRAL to ignore are never noticed. Two small files support it: `tracker-session.json` (the id, game, start and last-seen time of the session being tracked right now, deleted when it ends) and `tracker-ignored.json` (ids of games you chose not to track this way).
- `cache\`: artwork copied from your stores' local caches or downloaded from Steam's public CDN, and thumbnails.
- `artpacks\`: the undo record of your last ten art packs — for each slot a pack changed, the game ID, the cache file it put there and the file it replaced. Files a record can put back are kept when you clear the artwork cache. Which stretch of each cached live-tile clip to loop is stored in `vystral.db`, keyed by a hash of the clip.
- `logs\`: diagnostic logs, 7 days (`vystral-tracker-*.log` for the background tracker). They include file paths, never passwords or tokens.
- `webview\`: the interface's browser profile.
- `cloud-edge\`: only if you use cloud play with the default *Separate Edge window*: the Microsoft Edge profile those cloud windows use (your xbox.com / play.geforcenow.com sign-in lives there, kept by Edge). VYSTRAL creates the folder and passes it to Edge, but never reads it, never backs it up and never includes it in diagnostics. Delete it to sign out of those windows.
- `backups\`: database backups.

Export your journal from Settings → Data. Delete tracked history there too (this also deletes the recorded background-app names, the list of apps you hid, and the driver versions stored with sessions), or delete the whole folder to remove everything.

## What VYSTRAL reads

- Store manifests and registry entries describing installed games (read-only).
- Steam's local "last played" and playtime records for the most recently signed-in account.
- With Moments on: images and videos in Steam's screenshot folders, Xbox Game Bar captures and folders you add.
- While a game you launched runs, if enabled: system CPU/GPU/memory load and GPU temperature (read-only counters).
- Names and paths of running processes, to detect when your game starts and stops.
- With *Games started outside VYSTRAL* on: which program owns the foreground window and the executable paths of running programs, compared in memory with your installed games' folders (every few seconds while VYSTRAL is open, and by the background tracker while it's closed). Nothing about programs that aren't your games is stored. The background tracker starts with Windows (`VYSTRAL Background Tracker` in Task Manager › Startup apps); turning the setting off stops it and removes that entry, and so does uninstalling.
- While a game you launched runs, if enabled: names, memory and CPU time of other running processes (one handle-free system snapshot about every 30 seconds), and your graphics driver version (once per session).

- With frame-rate capture on: frame timing events for the game you launched, via PresentMon (ETW). No game memory or content.

If you add a Steam Web API key, it's stored in Windows Credential Manager (`VYSTRAL/SteamWebApiKey`), never in the database or logs. Removing it in Settings deletes it.

The same applies to keys for optional data sources: `VYSTRAL/SteamGridDB`, `VYSTRAL/IGDB` (your Twitch application's client ID and secret), `VYSTRAL/RAWG` and `VYSTRAL/IsThereAnyDeal`. The IGDB access token they produce is kept in memory only. The interface only ever learns whether a key exists and its last four characters. These keys are yours: VYSTRAL ships no shared keys.

What data sources return is cached in `vystral.db`: Wikidata store IDs per Steam/GOG ID, IGDB/RAWG details and which source filled which field, prices (6–24 hours), Steam Deck reports (7 days) and the AreWeAntiCheatYet list. Every lookup tells that provider that this IP address asked about that game; prefer leaving keyed sources off if that matters to you, and use Offline mode to stop all of them.

Version 0.5 features that use only data already on your PC (no new hosts, nothing sent anywhere):

- **While you were away** (Home) summarises sessions VYSTRAL noticed without launching them (background tracker or detected while open) since you last opened Home. It stores one timestamp, `home.awayLastSeen`, in `vystral.db`.
- **Time-to-beat bars** read the IGDB estimates already saved by enrichment (only with your own IGDB credentials); turning them off (Settings → Library & stores → Time to beat) hides them.
- **Anti-cheat notes** read the cached AreWeAntiCheatYet list; nothing is sent to anyone. Hide them in Settings → Launching & sessions.
- **Next big sale** uses Steam seasonal sale dates shipped inside VYSTRAL (`src/Vystral.Windows/Recap/steam-sales.json`, as announced by Valve on Steamworks); nothing is downloaded. “Source” opens that Steamworks page in your browser only when you click it.
- **Estimated savings on your backlog** uses prices already cached when you opened game pages (CheapShark/IsThereAnyDeal); it never looks up prices on its own.
- **Session replay cards** are drawn in the interface. *Save as image* writes a 1920×1080 PNG only where you choose in the Windows save dialog; *Copy image* puts it on the Windows clipboard. The image never leaves your PC unless you share it.

**Cloud play** (Settings → Cloud play; off by default, Track O):

- `vystral.db` keeps the last downloaded copy of each cloud catalogue for your region (`cloud_catalog`: a game's GeForce NOW ID or Microsoft Store product ID, title, store IDs, Ready/Install-to-Play and whether a paid membership is the minimum) and a Microsoft Store product → package family name map (`cloud_products`). They're replaced on each refresh, never shared, and never shipped with VYSTRAL.
- Cloud sessions you start from VYSTRAL are saved like other sessions, with the source `cloud-gfn` or `cloud-xbox` and no installation or performance data. Their length is an estimate: from the GeForce NOW stream process, the Edge window VYSTRAL opened, or the Xbox app being in the foreground; sessions in your normal browser end when you press *I'm done*. Sessions under a minute aren't kept. *Delete tracked history* deletes them too.
- To notice those sessions VYSTRAL reads the same handle-free process list as game detection (process names only) and which program owns the foreground window, only while a cloud session it started is open. It never reads the Xbox or GeForce NOW apps' files, caches, cookies or windows, and never sees your account, membership or balance: the hours meter uses the membership and reset day you pick and is labelled as an estimate.
- Your region comes from Windows (Settings → Time & language → Region) unless you choose one.

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
| Art packs (SteamGridDB) | The same two SteamGridDB hosts — nothing new | Your own SteamGridDB key, and for each game in the selection you chose: its Steam app ID (or, without one, its title, to find an exact match), then one image list per slot and one image download per slot; eight preview images when you ask for a preview. One game at a time, at most one API request every 400 ms and two image downloads a second; a "slow down" answer pauses the pack for as long as SteamGridDB asks | Off until you add a key; only when you start a pack. Waits (never runs) with Offline mode or Data saver on, in safe mode, or while a game runs |
| Live-tile director | Nothing: the analysis runs on the micro-trailer already cached on your PC | — | Runs with live tiles |
| Game details (IGDB) | `id.twitch.tv`, `api.igdb.com` | Your own Twitch application's client ID and secret (in the body of the token request), then Steam app IDs, IGDB slugs from Wikidata or exact titles of games in your library | Off until you add credentials |
| Game details (RAWG) | `api.rawg.io` | Your own RAWG key, and titles or Wikidata-linked RAWG IDs of games in your library | Off until you add a key |
| Prices (CheapShark) | `www.cheapshark.com` | The Steam app ID of the game whose page you opened | On; only on page open, switch in Settings |
| Prices (IsThereAnyDeal) | `api.isthereanydeal.com` | Your own ITAD key, the Steam app ID of the game whose page you opened, and your price country | Off until you add a key |
| Cross-store IDs (Wikidata) | `query.wikidata.org` | Steam app IDs (and GOG product IDs) of games in your library, up to 100 per query | On; switch in Settings |
| Steam Deck compatibility | `store.steampowered.com` | The Steam app ID of the game whose page you opened | On while “Fetch game details” is on; switch in Settings |
| Anti-cheat list (AreWeAntiCheatYet) | `raw.githubusercontent.com` | Nothing about you or your games: the public list is downloaded whole, at most weekly | On; switch in Settings |
| Library value prices | `store.steampowered.com` | Steam app IDs of games in your library (100 per request) and your price country | On; only when you open Journal → Library value; switch in Settings |
| Cloud play: GeForce NOW games list | `api-prod.nvidia.com` (the public list behind nvidia.com's games page) | Your two-letter region; nothing about you or your library. About 10 requests of ~250 KB, 3 s apart | Off; with cloud play on, at most once a day per region (back-off of 1–24 h after errors, a pause when asked to slow down); never with Offline mode, in safe mode or while you play; Data saver stops the background refresh |
| Cloud play: Xbox Cloud Gaming list | `catalog.gamepass.com` (the public “all cloud games” list behind xbox.com) and `displaycatalog.mp.microsoft.com` (Microsoft Store product details) | Your region; then Microsoft Store product IDs from those lists (never your library), up to 20 per request. The first time about 30 product requests (~1.3 MB each, ~35 MB total); after that only new products, each re-checked every 60 days | Same as above |
| Cloud play: GeForce NOW status | `status.geforcenow.com` (Atlassian Statuspage public API) | Nothing (one request, cached 5 minutes) | Only with cloud play on, when you open a game's cloud options or Settings → Cloud play |
| Cloud play: starting a game | The GeForce NOW or Xbox app, or `play.geforcenow.com` / `www.xbox.com` in a separate Edge window or your browser | What the vendor's app or site does when you play; VYSTRAL only opens it with the game's ID (`utm_source=vystral` on NVIDIA's documented link) | Only when you press *Play in the cloud* |
| Opening a deal or “Open on …” link | Your default browser | The browser opens the shop or site page; affiliate links from CheapShark/IsThereAnyDeal are left as those services send them | Only when you click |

**Offline mode** (Settings → Privacy) turns off every optional network feature. Your games and store apps keep using their own services as usual; VYSTRAL doesn't see or change that traffic.
