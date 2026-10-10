# Game data sources for VYSTRAL

Research date: **2026-10-05**. Scope: free sources of game metadata and artwork for a local-first, open-source (MIT) Windows launcher covering Steam, Xbox/Game Pass, Epic, GOG, EA, Ubisoft, Battle.net and manual games. This is research only. No code was changed.

**How claims are marked**
- **[verified]**: checked on 2026-10-05 with a live request, by reading files on the development PC, or from the provider's own documentation.
- **[docs]**: taken from the provider's documentation or terms page, as fetched or quoted in search results on that date.
- **[unverified]**: from community sources or memory and not re-checked. Confirm it before building on it.

---

## 1. Executive summary

### Recommended stack

**Tier 0: local only (no network, always on, works offline)**

| Store | Local source | Gives |
|---|---|---|
| Steam | `appcache\librarycache\<appid>\…` | Cover, hero, logo, header and icon for **owned and installed** apps. On the dev PC: 642 app folders but only 3 installed manifests. |
| Steam | `appcache\appinfo.vdf` (binary v29) | Exact hashed art paths, including the **logo** and `logo_position`; Steam Deck/SteamOS compatibility (including an `hdr_support` flag); review score/percentage; developer/publisher; genres; store tag IDs; categories; release date |
| Steam | `appcache\stats\UserGameStatsSchema_<appid>.bin` | Achievement schema (names, descriptions, icon hashes) with no key |
| Epic | `Data\Catalog\catcache.bin` (base64 JSON) [unverified on dev PC] | Title, description, keyImages (`DieselGameBoxTall` portrait, `DieselGameBox`, logo), developer |
| GOG | `galaxy-2.0.db` (SQLite) [unverified on dev PC] | Title, images, meta (genres, themes, critic score), cross-store release keys (when Galaxy is installed) |
| Xbox | `MicrosoftGame.config` / `AppxManifest.xml` | StoreId (BigId), TitleId, PFN and tile logos |
| Ubisoft | `cache\configuration\configurations` [unverified on dev PC] | Name and thumb/logo/background image file names |
| EA, Battle.net | `installerdata.xml`, `product.db` | IDs and titles only. Art has to come from cross-store matching. |

**Tier 1: keyless network (on by default, respects Offline mode and Data saver)**

1. **Steam store and CDN**: `IStoreBrowseService/GetItems` (batched, **250 appids per GET verified**) for assets, reviews, Deck category, ratings, tags, screenshots and trailers. `appdetails` for long descriptions, requirements, DLC and the Metacritic score. Documented keyless Web API calls: `appreviews`, `GetNumberOfCurrentPlayers`, `GetNewsForApp`, `GetGlobalAchievementPercentagesForApp`. CDN: `shared.akamai.steamstatic.com/store_item_assets/…`.
2. **Wikidata** (CC0): the cross-store ID graph (Steam, GOG, Epic, Microsoft, IGDB, PCGamingWiki, HowLongToBeat, SteamGridDB, ITAD, Battle.net, Ubisoft and EA IDs), plus series, franchise, ESRB/PEGI ratings, platforms and genres. Better still, a **CI-generated CC0 mapping file shipped with each release** means most users never need to query it live.
3. **Microsoft display catalog**: `displaycatalog.mp.microsoft.com` gives Poster (1440×2160), BoxArt, SuperHeroArt (3840×2160), TitledHeroArt, screenshots, HLS/DASH trailers, ratings, HDR/4K attributes and the developer/publisher. Game Pass membership comes from `catalog.gamepass.com/sigls/v2`. Both are grey: public, but undocumented.
4. **GOG public API**: `api.gog.com/v2/games/<id>` gives boxArtImage (vertical cover), background, logo, icon, series, tags, features and ESRB/PEGI/USK ratings. Grey: public, but undocumented.
5. **AreWeAntiCheatYet** `games.json` (MIT, 1,167 entries, with Steam/Epic store IDs) for anti-cheat status. **GeForce NOW** public list for cloud availability (grey). **CheapShark** for prices, but only on demand when the user opens a game.

**Tier 2: opt-in, bring your own key/credentials (Windows Credential Manager, off by default)**

SteamGridDB (manual art picker), IGDB (Twitch client ID and secret; time-to-beat, similar games, franchises), RAWG, IsThereAnyDeal, GG.deals, OpenCritic (through RapidAPI). PCGamingWiki is now in this tier because it needs a **bot password**: anonymous Cargo queries were disabled in August 2026.

**Avoid:** HowLongToBeat (no API, anti-bot measures), Metacritic (no API), MobyGames (paid since 2024–25), the Epic store GraphQL and catalog service (Cloudflare/auth), SteamSpy (playtime data is now zero), the Xbox app's private caches, EA's encrypted local state, Wikipedia **images** (cover art there is non-free), the LaunchBox DB (licence unclear) and anything that needs another launcher's session tokens.

### The not-installed Steam art bug: root causes [verified]

These were found by reading the code and with live probes. Each is a separate defect.

| # | Cause | Where | Evidence |
|---|---|---|---|
| A | **The local librarycache is never read for owned-only games.** `ApplyOwnedSteamGames` creates `NotInstalled` installations with no `LocalArtwork`. Local import only runs for games an adapter discovered, i.e. installed ones. | `src/Vystral.Core/Data/LibraryRepository.Steam.cs:101-121`; `LibraryService.cs:116-131`; `AppBackend.SteamAccount.cs:196-206` | Dev PC: 642 `librarycache` folders against 3 `appmanifest_*.acf`. Steam had already cached art for most owned games. |
| B | **`FindLocalArtwork` doesn't recognise the new hashed file names.** Newer apps store the cover as `<sha1>/library_capsule.jpg` (and `_2x`), not `library_600x900.jpg`. | `src/Vystral.Windows/Integrations/SteamAdapter.cs:160-165` | 47 of the 642 folders have their cover **only** as `library_capsule.jpg`. |
| C | **The hashed-asset filter drops every hashed file.** `name.Contains('/') && !name.StartsWith(appId)` rejects values like `480bd879…/library_600x900.jpg`, which contain `/` but don't start with the appid. | `src/Vystral.Windows/Services/ArtworkService.cs:152` | PEAK (3527290): flat `library_600x900.jpg`, `header.jpg` and `logo.png` all **404**. The only working cover is the hashed one, and this filter discards it. Battlefield 6 uses `…/library_capsule.jpg`. |
| D | **The logo has no fallback.** `GetItems` assets contain no logo key, and the loop `continue`s for `Logo`. | `ArtworkService.cs:118` | `GetItems` asset keys checked for 9 apps: no `library_logo`. |
| E | **Art depends on `appdetails` succeeding and on a one-shot flag.** Art is only fetched after `appdetails` returns `success:true`, and `metadata_fetched` is set once. Delisted or region-locked apps never get CDN art. A transient CDN failure is never retried. Setting `library.fetchMetadata=false` also disables art. | `MetadataService.cs:40-52`; `LibraryRepository.cs:439-450`; `LibraryService.cs:136` | Code reading |
| F | **Owned-games sync doesn't start enrichment.** `steam.sync` adds games but never calls `Library.StartEnrichment()`, so new games wait for the next scan or game session. | `AppBackend.SteamAccount.cs:86-90`, `SteamAccountService.cs:241-248` | Code reading |

### Best keyless fix, in order

1. **Local first.** After every owned sync and every scan, run `FindLocalArtwork` for **every** Steam appid in the library, not only installed ones. Extend the wanted list with `library_capsule_2x.jpg` and `library_capsule.jpg` (as Cover) and `library_header.jpg` (as Header). Ignore `*_blur.jpg`. Treat `<40-hex>.jpg` in the app folder as the **icon**: it matches `common.icon` in appinfo.
2. **Optional exact local index.** Parse `appinfo.vdf` (magic `0x07564429`, version 29: a string table at the int64 offset in the header, and keys stored as int32 indices into it). Read `common.library_assets_full.{library_capsule,library_hero,library_logo,library_header}.{image,image2x}.<language>` and `common.header_image.<language>`. The values are exact CDN-relative paths such as `e596dc85…/logo.png`. Never read or use the per-app PICS access token stored in each record header.
3. **Network, batched.** Call `IStoreBrowseService/GetItems` once per 100–250 missing appids with `data_request.include_assets=true`. Build each URL as `https://shared.akamai.steamstatic.com/store_item_assets/` + `asset_url_format.Replace("${FILENAME}", value)` (the format already carries `steam/apps/<appid>/` and a `?t=` cache-buster). Validate each value with `^(?:[0-9a-f]{40}/)?[A-Za-z0-9_.-]+\.(?:jpg|png)$` in place of the current `/` rule. Preferred keys: cover `library_capsule_2x` → `library_capsule`; hero `library_hero_2x` → `library_hero`; header `header_2x` → `header`.
4. **Legacy flat fallback**, for when steps 1–3 found nothing: `…/steam/apps/<appid>/library_600x900_2x.jpg`, `library_600x900.jpg`, `library_hero.jpg`, `logo.png` and `header.jpg`. All return 200 for most older apps [verified]. For the logo on new apps, use the appinfo path from step 2. Steam's own client does the same.
5. **Decouple art from metadata.** Track an `art_checked` timestamp per kind and retry with backoff (1 day, 7 days, 30 days). Don't make art depend on `appdetails` success. Call `StartEnrichment()` at the end of `SyncAsync`. Let `library.fetchArtwork` work even when `library.fetchMetadata` is off.

Verified URL shapes (all returned 200 on 2026-10-05):
```
https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1084020/e596dc8576fb2ec7061173ab2499369d35777a7a/logo.png
https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1084020/2de9fd7bd3e54f6300246e63d6187db97e72b5e4/library_capsule_2x.jpg
https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3527290/480bd879ac737921bfa2529a6fea15961267ad21/library_600x900_2x.jpg
https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1084020/library_600x900.jpg          (legacy flat; may be older art)
https://shared.akamai.steamstatic.com/community_assets/images/apps/1084020/d5702cf0402efb94240f69a505e7c6ee8abb3460.jpg  (icon = common.icon)
Equivalent hosts: shared.fastly.steamstatic.com, cdn.akamai.steamstatic.com/steam/apps/…, steamcdn-a.akamaihd.net/steam/apps/…, cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/…
```
Gotcha: when both a flat file and a hashed file exist, the flat one can be **stale**. Prefer the hashed path whenever the asset index or appinfo provides one.

---

## 2. Comparison table

Access: **K** = keyless, **BYO** = user supplies their own key or credentials, **S** = needs an app secret (unsuitable for an open-source client). Verdict: **Use** = on by default; **Opt-in** = off by default, the user enables it; **Avoid** = don't integrate.

| Source | Data offered | Access | Cost | Rate limits | Licence / attribution | ToS stance on desktop use and caching | Reliability | Verdict |
|---|---|---|---|---|---|---|---|---|
| **Steam local files** (librarycache, appinfo.vdf, stats, localconfig) | Art (cover, hero, logo, header, icon), Deck compatibility, reviews %, developer/publisher, tags, categories, achievement schema, playtime | Local | Free | n/a | Valve/publisher copyright on art; personal display only | User's own files, read-only. Don't touch the PICS tokens in appinfo records, `config/*.vdf` login data or `ssfn*` files. | High. Binary format changes about yearly (v28→v29 added the string table). | **Use** |
| **Steam `IStoreBrowseService/GetItems`** | Hashed asset paths, short description, developer/publisher, tags, categories (controller/HDR/etc.), reviews summary, Deck/SteamOS/Steam Machine compatibility category, ESRB/PEGI rating, price, screenshots, trailers (DASH/HLS/microtrailer), full description (BBCode), links | K | Free | Not published. 250 IDs per GET worked. | Valve copyright | Grey: semi-documented, used by Steam's own store front end. Keyless, no ToS clause found that forbids it. | High; already in use | **Use (primary)** |
| **Steam `appdetails` / `storesearch` / `dlcforapp`** | Name, description, genres, categories, metacritic score and URL, pc_requirements, DLC list, release date, price (per `cc`), movies | K | Free | About 200 requests per 5 minutes (community-reported) | Valve copyright | Grey: undocumented store endpoints | Medium–high; HTTP 429 when exceeded | **Use (as today)** |
| **Steam documented keyless Web API** (`appreviews`, `GetNumberOfCurrentPlayers`, `GetNewsForApp`, `GetGlobalAchievementPercentagesForApp`, `IStoreService/GetTagList`) | Review totals, live players, news/patch notes, global achievement %, tag names | K | Free | 100,000 calls/day applies to keyed calls [docs] | Steam Web API Terms | Documented | High | **Use** |
| **Steam Web API (keyed)** | Owned games, user achievements, schema | BYO | Free | 100k/day/key [docs] | Terms say "keep your key confidential" [docs] | BYO only | High | **Opt-in (as today)** |
| Steam `saleaction/ajaxgetdeckappcompatibilityreport` | Deck test results | K | Free | ? | Valve | Undocumented | Medium | **Avoid**: GetItems and appinfo give the same data |
| `ISteamApps/GetAppList` | Full app list | – | – | – | – | **Removed: 404** [verified]. The replacement `IStoreService/GetAppList` needs a key; `IStoreQueryService/Query` is keyless. | – | **Avoid** |
| **Wikidata** (SPARQL / Action API) | Cross-store IDs, series/franchise, ESRB/PEGI, platforms, genres, developer/publisher, dates, Wikipedia sitelink | K | Free | WDQS: 60 s of query time per minute, 5 parallel queries per IP; Wikimedia 2026 API limits are 200 req/min for a compliant User-Agent and **10/min without contact info** [docs] | **CC0**. No attribution required; credit as a courtesy. | Fine to cache and redistribute (including a bundled mapping file) | High; query took 0.7 s for 5 IDs | **Use** |
| Wikipedia (REST summary / extracts) | Lead paragraph | K | Free | Same Wikimedia limits; REST: at most 3 concurrent, under 5 rps [docs] | Text **CC BY-SA 4.0**; most game cover images are **non-free** | Text: attribution plus licence link, share-alike on adaptations. Images: don't use. | High | **Opt-in** (text only) |
| **Microsoft display catalog** | Poster/BoxArt/SuperHeroArt/TitledHeroArt/screenshots, trailers, description, developer/publisher, ratings, attributes (HDR/4K/co-op), XboxTitleId, PFN, user rating | K | Free | Not published | Microsoft/publisher copyright | Grey: undocumented, used by Microsoft's own store web pages | High | **Use** (Xbox/MS games) |
| **Game Pass `catalog.gamepass.com/sigls`** | Lists of Game Pass product IDs | K | Free | ? | Microsoft | Grey: undocumented, used by xbox.com | Medium (list GUIDs can change) | **Use** (badge only) |
| **GOG `api.gog.com` / `catalog.gog.com`** | Box art, background, logo, icon, description, screenshots, videos, series, tags, features, ESRB/PEGI/USK, developer/publisher, requirements | K | Free | Not published | GOG/publisher copyright | Grey: undocumented, used by gog.com and Galaxy; community docs exist | High | **Use** (GOG games) |
| Epic `store-content.ak.epicgames.com` CMS / `freeGamesPromotions` | Product page JSON by slug, keyImages | K | Free | ? | Epic | Grey: undocumented | Medium (CMS being retired [unverified]) | **Avoid** (local catcache is better) |
| Epic store GraphQL / catalog service | Full catalog | Auth / Cloudflare | – | – | – | GraphQL **403** and catalog **401** without the launcher's token [verified] | – | **Avoid** |
| **AreWeAntiCheatYet `games.json`** | Anti-cheat names and status (Supported 196 / Running 276 / Broken 640 / Denied 53 / Planned 2), notes, Steam/Epic IDs | K (raw.githubusercontent) | Free | GitHub raw limits | **MIT** (bundle with notice) | Fine | High | **Use** |
| GeForce NOW public game list | Cloud availability, steamUrl, store, genres | K | Free | ? | NVIDIA; no stated licence | Static file meant for public consumption by NVIDIA's site; grey | Medium | **Opt-in** ("Cloud" badge) |
| **CheapShark** | Cheapest price, deals, store list, thumbnails | K | Free | Unpublished; 429 with `Retry-After`; **no bulk catalog building** [docs] | Deal links go through the CheapShark redirect (affiliate) | Call only in response to user action | Medium–high | **Use, on demand only** |
| ProtonDB summaries | Linux/Proton tier, score, total | K | Free | ? | Data dumps **ODbL** | Summary endpoint is undocumented; dumps are open | Medium | **Avoid** for a Windows launcher (maybe later) |
| SteamSpy | Owners range, CCU, tags, price | K | Free | 1 req/s; `all` 1 per 60 s [docs] | None stated | – | Low: `average_forever`/`median_forever` returned **0** [verified] | **Avoid** |
| PCGamingWiki | HDR, ultrawide, controller, fixes, save locations, IDs | **BYO bot password** (Cargo); anonymous `cargoquery` → `permissiondenied` [verified] | Free | ? | **CC BY-NC-SA 3.0** | NC and SA complicate an MIT app; caching for display is OK with attribution | Medium (server migration in Aug 2026) | **Opt-in** (advanced) / link-out |
| IGDB (Twitch) | Everything: covers, artworks, screenshots, videos, time-to-beat, age ratings, franchises, collections, similar games, external IDs | **S** (client ID + secret, client-credentials flow) | Free [docs] | 4 req/s, 8 concurrent [docs] | Free under the Twitch Developer Services Agreement; the FAQ allows caching ("we prefer if you store") [docs] | Secret must stay private, so **BYO only** | High | **Opt-in (BYO)** |
| RAWG | Description, genres/tags, metacritic, playtime, ESRB, screenshots, stores | BYO key | Free up to 20k req/month [docs] | 20k/month | **Attribution plus an active hyperlink on every page** that uses RAWG data; no redistribution [docs] | Personal use; key must not be exposed | Medium | **Opt-in (BYO)** |
| SteamGridDB | Community grids (600×900), heroes, logos, icons; platforms include steam/egs/gog/origin/uplay/bnet | BYO key (Bearer) | Free | Unpublished | Community uploads; ToS: personal, non-commercial | Fits a free, non-commercial app with a BYO key | High | **Opt-in (manual picker)** |
| IsThereAnyDeal | Prices, historical low, bundles, ITAD ID lookup, reviews (Metacritic/OpenCritic/Steam), tags, box art | Per-app key (some lookup endpoints have `Authorizations: None`) | Free | 1,000 per 5 minutes [docs] | "SHOULD" link to ITAD; **MUST NOT change data or affiliate links**; no competing apps [docs] | A per-app key can't be embedded, so BYO | High | **Opt-in (BYO)** |
| GG.deals | Lowest prices (including keyshops), by Steam appid, up to 100 per request | BYO key | Free for personal/hobby [docs] | 100 records/min, 1,000/hour [docs] | Attribution plus a hyperlink on every page; keep referral links [docs] | BYO | High | **Opt-in (BYO)** |
| OpenCritic (RapidAPI) | Top critic score, % recommend, tier | BYO RapidAPI key | Basic $0: 200 req/day plus 25 searches/day [docs, via search] | 4 rps | Name plus link next to the score [docs, via search] | BYO | Medium | **Opt-in** (low priority) |
| Metacritic | Scores | No API | – | – | – | Scraping is not acceptable. Use Steam `appdetails.metacritic` instead. | – | **Avoid** |
| HowLongToBeat | Time-to-beat | No official API | – | Anti-bot, rotating search endpoint | – | Scraping a private endpoint | Breaks often | **Avoid** (link out through Wikidata P2816) |
| MobyGames | Credits, covers, descriptions | Paid key | $9.99/mo hobbyist (0.2 rps); commercial from $99.99 [docs, via search] | – | – | – | – | **Avoid** |
| Giant Bomb | Wiki data, images | BYO key | Free [unverified post-2025 sale] | About 200 requests per resource per hour [unverified] | Non-commercial [unverified] | – | Unclear | **Avoid** |
| TheGamesDB | Retro/console metadata and images | Key on request | Free | About 1,000 per month "monthly allowance" [unverified] | – | – | Medium | **Avoid** |
| LaunchBox Games DB `Metadata.zip` | 100 MB XML: name, date, overview, genres, developer/publisher, ESRB, rating, video URL, Wikipedia URL, image file names | K | Free | One daily file | **No licence stated** on the site [verified absence]. A "CC BY-SA" claim only appears on third-party pages. | Unclear | High | **Avoid** (licence unclear, retro-heavy) |
| ScreenScraper / OpenRetro / Libretro | Retro ROM metadata | Dev credentials | – | – | Various | – | – | **Avoid** (out of scope) |
| Xbox app private caches (`Microsoft.GamingApp_*\LocalState\GameArtCache`, `ThirdPartyLibraries`, `AsyncCache.db`) | Art the Xbox app cached | Local | – | – | – | Private implementation inside another app's package | Low | **Avoid** |

---

## 3. Per-source notes

### 3.1 Steam (network)

**`IStoreBrowseService/GetItems/v1`** (keyless GET, batched) [verified]
```
GET https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=<url-encoded JSON>
{"ids":[{"appid":1245620},{"appid":440}],
 "context":{"language":"english","country_code":"US"},
 "data_request":{"include_assets":true,"include_basic_info":true,"include_release":true,
   "include_platforms":true,"include_ratings":true,"include_reviews":true,"include_tag_count":20,
   "include_screenshots":true,"include_trailers":true,"include_full_description":true,
   "include_supported_languages":true,"include_links":true,"include_included_items":true}}
```
- **Batch:** 250 appids in one GET worked (URL about 7.6 KB, response 281 KB with assets only). Use 100 for safety. POST returns 405.
- **Fields to map:** `assets.{asset_url_format, library_capsule[_2x], library_hero[_2x], header[_2x], main_capsule, hero_capsule, page_background, community_icon, last_modified}`; `basic_info.{short_description, developers[].name, publishers[].name}`; `release.{steam_release_date, original_release_date}`; `reviews.summary_filtered.{percent_positive, review_count, review_score_label}`; `platforms.{steam_deck_compat_category (0 unknown, 1 unsupported, 2 playable, 3 verified), steam_os_compat_category, steam_machine_compat_category, steam_frame_compat_category}`; `game_rating.{rating, descriptors, required_age, image_url}`; `categories.{supported_player_categoryids, feature_categoryids, controller_categoryids}`; `tagids`/`tags[].weight`; `best_purchase_option.formatted_final_price`; `screenshots.all_ages_screenshots[].filename`; `trailers.highlights[].{microtrailer, adaptive_trailers (dash_av1, dash_h264, hls)}`; `full_description_bbcode`; `links`.
- **Gotchas:** hashed file names (§1). `asset_url_format` includes `?t=<last_modified>`, which is useful as a cache key. There is **no logo** in `assets`. About half of librarycache entries (DLC, soundtracks, tools) have no `library_capsule`. Mature games include `content_descriptorids`; respect an "hide adult content" setting.

**Tag and category names:** `https://api.steampowered.com/IStoreService/GetTagList/v1/?language=english` (keyless, has `version_hash`) [verified]. Useful category IDs from `appdetails` [verified]: 18 partial controller support, 28 full controller support, **61 HDR available**, 23 Steam Cloud, 62 Family Sharing, 22 achievements, 55/57/58 DualShock/DualSense, 64–79 accessibility.

**`appdetails`** (one appid per call for full data): `https://store.steampowered.com/api/appdetails?appids=<id>&cc=US&l=english` (add `&filters=basic,metacritic,categories,pc_requirements,…` to trim). It maps `metacritic.score/url`, `pc_requirements.minimum/recommended` (HTML; sanitize it), `dlc[]`, `movies[]`, `controller_support`, `required_age`, `ratings`. Always pass `cc`: without it, prices follow the caller's IP (INR came back from the dev PC).

**DLC:** `https://store.steampowered.com/api/dlcforapp/?appid=<id>&cc=US` (undocumented) [verified] returns DLC with header images, prices and release dates. Locally, appinfo `extended.listofdlc` [unverified].

**Reviews (documented):** `https://store.steampowered.com/appreviews/<id>?json=1&num_per_page=0&language=all&purchase_type=all` returns `query_summary.{review_score_desc,total_positive,total_negative,total_reviews}` [verified].

**Players:** `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=<id>` [verified]. Call it on demand only.

**News / patch notes:** `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=<id>&count=10&maxlength=0&feeds=steam_community_announcements` [verified without `feeds`]. External feeds return third-party press in other languages; filter by `feedname`/`feed_type`.

**Global achievement %:** `…/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=<id>` (keyless) [verified]. Pair it with the local schema (§4) for a fully keyless achievements view of rarity.

**Search:** `IStoreQueryService/SearchSuggestions/v1` and `IStoreQueryService/Query/v1` (keyless) [verified]. `storesearch` is still fine for exact-title matching.

**Animated assets / micro-trailers** [verified 2026-10-05 against appids 1245620, 1091500, 730, 413150]: `IStoreBrowseService/GetItems` with `data_request.include_assets` returns only still images (`main_capsule`, `header`, `hero_capsule`, `library_capsule`, `library_hero`, `page_background`, … each with `_2x`); no `*_animated` or video asset field exists. With `include_trailers`, each `trailers.highlights[]` entry has `microtrailer: [{filename: "<appid>/<trailer_base_id>/<hash>/<ts>/microtrailer.webm", type: "video/webm"}, {…microtrailer.mp4, "video/mp4"}]` plus `adaptive_trailers` (dash_av1, dash_h264, hls_264_master.m3u8) in the *same folder*. The files are served from `https://video.{akamai,fastly}.steamstatic.com/store_trailers/<filename>` (200, `Cache-Control: public, max-age≈10 years`); the `cdn.*`/`shared.*` hosts and the `trailer_url_format` (`steam/apps/${FILENAME}`) path 404. Measured: ~7.9 s, 853×480, no audio track, 1.4–3.0 MB (mp4 1.9–2.8 MB). appdetails no longer lists micro-trailers, but its `hls_h264` master sits in a folder that also holds `microtrailer.mp4` (verified for 1245620/468149), so VYSTRAL derives the URL from the trailer it already looked up — no extra API call (`SteamMicroTrailers.Resolve`).

**Steam Web API terms** [docs]: 100,000 calls per day; "keep your Steam Web API key confidential" (so BYO, never bundled); "only retrieve Steam Data about a Steam end user as requested by the end user"; don't imply Valve endorsement.

### 3.2 Wikidata: the ID backbone

- **Endpoint:** `https://query.wikidata.org/sparql?query=…` with `Accept: application/sparql-results+json`. A **compliant User-Agent is required**, e.g. `VYSTRAL/0.2 (https://github.com/Arnav-Dugad/vystral)`. Without contact info, Wikimedia's 2026 limits drop to 10 req/min.
- **Properties [verified labels]:**

| Property | Meaning | Value format notes |
|---|---|---|
| P1733 | Steam application ID | numeric string |
| P2725 | GOG application ID | **slug path** like `game/baldurs_gate_iii` [verified] |
| P12727 | GOG product ID | numeric (matches `goggame-<id>.info`) |
| P6278 | Epic Games Store ID | **store slug** like `expedition-33-b3240d` [verified], not the namespace or AppName |
| P5885 | Microsoft Store product ID | BigId, stored lower-case (`9p3j32ctxlrz`) [verified]; compare case-insensitively |
| P5794 | IGDB game ID | **slug** (`elden-ring`) [verified], not the numeric ID |
| P6337 | PCGamingWiki ID | page title (`Elden_Ring`) |
| P2816 | HowLongToBeat ID | numeric |
| P12561 | SteamGridDB ID | numeric game ID |
| P12570 | IsThereAnyDeal ID | – |
| P13193 | Battle.net game ID | format [unverified] |
| P8268 | Ubisoft Store game ID | format [unverified] |
| P8261 | EA games ID | format [unverified] |
| P9968 | RAWG game ID | – |
| P2864 | OpenCritic ID | – |
| P1712 | Metacritic ID | – |
| P11688 / P1933 | MobyGames game ID (new / former) | – |
| P7785 / P7622 / P7597 | LaunchBox / TheGamesDB / Lutris game ID | – |
| P179 / P8345 | part of the series / media franchise | – |
| P852 / P908 | ESRB / PEGI rating | – |
| P400 / P404 / P136 / P178 / P123 / P577 | platform / game mode / genre / developer / publisher / publication date | – |

- **Batch query (tested: 5 IDs in 672 ms):**
```sparql
SELECT ?item ?steam ?gog ?gogId ?epic ?ms ?igdb ?pcgw ?hltb ?sgdb ?series ?esrb WHERE {
  VALUES ?steam { "1245620" "1086940" }
  ?item wdt:P1733 ?steam .
  OPTIONAL{?item wdt:P2725 ?gog} OPTIONAL{?item wdt:P12727 ?gogId} OPTIONAL{?item wdt:P6278 ?epic}
  OPTIONAL{?item wdt:P5885 ?ms} OPTIONAL{?item wdt:P5794 ?igdb} OPTIONAL{?item wdt:P6337 ?pcgw}
  OPTIONAL{?item wdt:P2816 ?hltb} OPTIONAL{?item wdt:P12561 ?sgdb}
  OPTIONAL{?item wdt:P179 ?series} OPTIONAL{?item wdt:P852 ?esrb}
}
```
- **Gotchas:** some items have no English label (the label service returned the QID). Use `wikibase:language "en,mul"` or read `rdfs:label`. One Steam appid can map to several items (editions, remasters); prefer items with `P31` = video game (Q7889). Coverage is good for notable games and weak for small indie titles; PEAK had IGDB, PCGW, HLTB and SGDB IDs but no GOG or Epic ID.
- **Recommended pattern: ship a mapping file.** A GitHub Action runs one SPARQL dump weekly (all items with P1733, P12727, P2725, P6278, P5885, P13193, P8268 or P8261, plus P5794, P6337, P2816 and P12561) and commits `data/id-map.json.gz` into each release. Wikidata is CC0, so redistribution is fine. Users then resolve cross-store IDs with **zero network calls**, which also helps privacy. Size [unverified estimate]: a few MB compressed if limited to rows with at least two IDs.

### 3.3 Microsoft Store / Xbox / Game Pass

- **Product by BigId** [verified]: `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=9P3J32CTXLRZ,…&market=US&languages=en-us` (comma-separated, batched).
- **Lookup by local IDs** [verified]: `…/v7.0/products/lookup?alternateId=PackageFamilyName&value=<PFN>&market=US&languages=en-us&fieldsTemplate=details` and `…alternateId=XboxTitleId&value=<decimal title ID>`. `MicrosoftGame.config` stores the TitleId as hex, so convert it to decimal (for Elden Ring, `LegacyXboxProductId` `…70c95f35` is TitleId 1892245301).
- **Images** (`LocalizedProperties[0].Images[]`, `ImagePurpose`, protocol-relative URIs, so prefix `https:`) [verified]: `Poster` 1440×2160 (best 2:3 cover), `BoxArt` 2160×2160, `BrandedKeyArt` 584×800, `SuperHeroArt` 3840×2160 (hero), `TitledHeroArt` 1920×1080, `FeaturePromotionalSquareArt`, `Screenshot` 3840×2160, sometimes `Logo`. The image CDN `store-images.s-microsoft.com` accepts `?w=600&h=900` resizing [unverified].
- **Other fields:** `DeveloperName`, `PublisherName`, `ShortDescription`/`ProductDescription`, `CMSVideos[].{HLS,DASH}`, `MarketProperties[0].{OriginalReleaseDate, ContentRatings[] (ESRB, PEGI, USK, IARC…), UsageData[].AverageRating}`, `Properties.{Category, Attributes[] e.g. CapabilityHDR, Capability4k, XblOnlineCoop, XblAchievements}`, `AlternateIds[]` (XboxTitleId).
- **Game Pass lists** [verified]: `https://catalog.gamepass.com/sigls/v2?id=<siglId>&language=en-us&market=US`. Both `fdd9e2a7-0fee-49f6-ad69-4354098401ff` and `609d944c-d395-4c0a-9ea4-e9f39b52c1ad` returned "All PC Games" (an array of `{id:BigId}`). Sigl IDs for cloud, EA Play and "leaving soon" lists exist [unverified IDs].
- **Grey area:** neither endpoint is documented for third parties. Both are public, keyless and serve microsoft.com/xbox.com pages; widely used by Playnite plugins [unverified]. Use them politely, with batching and caching.

### 3.4 GOG

- **v2** [verified]: `https://api.gog.com/v2/games/<productId>?locale=en-US` provides `_links.{boxArtImage (vertical cover), backgroundImage, galaxyBackgroundImage, logo (png), icon}` and `_embedded.{product, developers, publisher, tags, features (e.g. "Controller support", "Cloud saves"), screenshots, videos, series, esrbRating, pegiRating, uskRating, gogRating, editions, supportedOperatingSystems}`, plus `description` (HTML; sanitize it).
- **v1** [verified]: `https://api.gog.com/products/<id>?expand=description,screenshots,videos` provides `images.{background, logo, logo2x (glx_logo jpg), icon, sidebarIcon}`. These are protocol-relative URLs. DLC is under `dlcs` [unverified].
- **Catalog search** [verified]: `https://catalog.gog.com/v1/catalog?limit=…&query=like:<term>`. Screenshot URLs contain `{formatter}`; substitute a size token such as `ggvgm` or `1600` [unverified token list].
- **Matching:** the GOG product ID comes from `goggame-<id>.info` and registry keys (already read by `GogAdapter`). Its Wikidata equivalent is P12727.
- **Grey area:** these endpoints are undocumented (community docs exist at gogapidocs.readthedocs.io [unverified current]). They serve gog.com and Galaxy; Heroic and others use them. No key is needed.

### 3.5 Epic

- **Local is the best source** (§4). Every network option is a problem: the store GraphQL returns **403** (Cloudflare) [verified]; the `catalog-public-service-prod06` bulk items endpoint returns **401** without a launcher token [verified]; and using the user's launcher token would mean extracting auth, which is forbidden. `store-content.ak.epicgames.com/api/<locale>/content/products/<slug>` returns 200 [verified] but is undocumented and slug-based. `freeGamesPromotions` is keyless and shows the keyImage types: `OfferImageTall` 1200×1600, `OfferImageWide` 2560×1440, `Thumbnail` [verified].
- **keyImage priority for a portrait cover** (Heroic's PR #387): `DieselGameBoxTall` → `DieselStoreFrontTall` → `DieselGameBox` → `Thumbnail`. Type names are case-sensitive.
- **IDs:** local manifests have `AppName`, `CatalogNamespace` and `CatalogItemId`. AWACY uses `{namespace, slug}`. Wikidata P6278 is the store slug, so join through catcache's slug field [unverified field name].

### 3.6 IGDB (opt-in, BYO only)

- **Auth:** `POST https://id.twitch.tv/oauth2/token?client_id=…&client_secret=…&grant_type=client_credentials` returns an app token (the docs example gives `expires_in` of about 64 days). Requests then go to `POST https://api.igdb.com/v4/<endpoint>` with `Client-ID` and `Authorization: Bearer` headers and an Apicalypse body [docs].
- **Why it's a problem for an open-source desktop app:** a confidential client is required ("Client Type must be set to Confidential"). An embedded secret lets anyone mint tokens as VYSTRAL and burn the shared 4 req/s budget. Twitch can then revoke the client, which breaks every installed copy, and rotating the secret breaks old builds. IGDB itself says to use a backend proxy, since it blocks CORS so tokens aren't exposed [docs]. Playnite historically ran its own server-side service for this, so the secret never shipped (the `JosefNemec/PlayniteServices` repository returned 404 on 2026-10-05) [unverified current]. A VYSTRAL proxy would contradict "local-first, no server", add hosting cost, pool all users into one rate limit, and reveal every user's library to the proxy.
- **Options:** (a) **BYO credentials**: the user registers a Twitch app (2FA required) and pastes the client ID and secret; store them in Credential Manager. (b) Skip IGDB; Steam, Wikidata and the store APIs cover most needs. Recommendation: (a) as an "Advanced" opt-in, built only after Tier 0–1 is done.
- **Mapping:** `external_games` with `where external_game_source = 1 & uid = "1245620"; fields game,uid,url;`. Source IDs [docs]: steam 1, gog 5, microsoft 11, amazon_asin 20, amazon_adg 23, epic_game_store 26, itch_io 30, xbox_marketplace 31, playstation_store_us 36, xbox_game_pass_ultimate_cloud 54. The `category`→`external_game_source` and enum→table migration window has ended; use the new fields (`external_game_source`, `game_release_format`, `age_rating.organization`/`rating_category`).
- **Useful endpoints:** `games` (`cover.image_id, artworks, screenshots, videos.video_id, summary, storyline, genres, themes, game_modes, player_perspectives, franchises, collections, similar_games, age_ratings, involved_companies, first_release_date, aggregated_rating, total_rating`) and `game_time_to_beats` (`hastily, normally, completely, count`).
- **Images:** `https://images.igdb.com/igdb/image/upload/t_<size>/<image_id>.jpg`. Sizes [docs]: `cover_big` 264×374, `720p`, `1080p`, `screenshot_huge` 1280×720, `logo_med`. A `_2x` variant (e.g. `t_cover_big_2x`) exists [unverified].
- **Terms:** free for non-commercial use under the Twitch Developer Services Agreement. The FAQ says it's free for commercial use too (via a partnership with attribution), caching is allowed and "preferred", and data may be kept after termination. Daily CSV dumps are for **partners only** [docs].

### 3.7 SteamGridDB (opt-in, BYO key)

- Base URL `https://www.steamgriddb.com/api/v2`, `Authorization: Bearer <key>`. Users get a key from their SteamGridDB profile preferences [docs, official node wrapper].
- **Endpoints** (official wrapper): `/search/autocomplete/<term>`, `/games/{id|steam}/<id>`, `/grids/{game|steam|…}/<id>?dimensions=600x900,342x482&styles=…&mimes=image/png,image/jpeg,image/webp&types=static&nsfw=false&humor=false&epilepsy=false`, `/heroes/…`, `/logos/…`, `/icons/…`. Platform types beyond `steam`/`game`: `egs`, `gog`, `origin`, `uplay`, `bnet`, `flashpoint`, `eshop` [unverified exact list]. Results include `url`, `thumb`, `author`, `score`, `style`, `width`, `height`.
- **Use it as a manual "choose different art" picker**, filtered to `nsfw=false&humor=false` and static images, and credit the `author.name`. Rate limits aren't published [unverified]. Its ToS limits use to personal, non-commercial, which matches a free tool with a BYO key. Art is community-uploaded and copyrighted by its creators or publishers.

### 3.8 RAWG, IsThereAnyDeal, GG.deals, CheapShark, OpenCritic

- **RAWG** [docs]: `https://api.rawg.io/api/games?search=…&key=<key>` and `/games/{id|slug}` (fields `background_image`, `metacritic`, `playtime`, `esrb_rating`, `genres`, `tags`, `stores`, `short_screenshots`). Free plan: 20k req/month, personal use, attribution plus an active hyperlink on every page. Its API ToS says the key must be proxied and not exposed. **BYO only.** Lower priority: largely duplicates Steam and Wikidata.
- **ITAD** [docs]: `GET /games/lookup/v1?appid=<steam>` returns the ITAD ID and assets (boxart, banners). `POST /lookup/id/shop/{shopId}/v1` (`["app/220"]`) and `/lookup/shop/{shopId}/id/v1` list `Authorizations: None`, so they work keyless; good for cross-store mapping. `GET /games/info/v2` gives tags, reviews (Metacritic/OpenCritic/Steam), players, achievements and trading cards. `POST /games/prices/v3` and `/games/historylow/v1` give prices. 1,000 requests per 5 minutes. Rules: no data changes, keep affiliate tags, link to ITAD, no competing apps. Keys are per app, so **BYO**.
- **GG.deals** [docs, via search]: prices by Steam appids (up to 100 per request), 100 records/min, 1,000/hour, free for personal/hobby use, hyperlink attribution on every page, keep referral links. **BYO.**
- **CheapShark** [verified, docs via search]: `https://www.cheapshark.com/api/1.0/games?steamAppID=<id>` returns `cheapest`, `cheapestDealID` and `thumb`. Deals are under `/deals?id=…` and stores under `/stores`. It's keyless, but the docs warn that automated catalog building leads to bans. **Call it only when the user opens a game's page**, and link deals through `https://www.cheapshark.com/redirect?dealID=…` [unverified exact path].
- **OpenCritic**: via RapidAPI only (a BYO RapidAPI key). It's low value next to Steam's `metacritic` field and ITAD's reviews block.

### 3.9 PCGamingWiki

- **Status change [verified + search]:** `https://www.pcgamingwiki.com/w/api.php?action=cargoquery&tables=Infobox_game,…` now returns `"permissiondenied": "You don't have permission to run arbitrary Cargo queries."` Anonymous `cargoquery` was disabled after the late-August-2026 server migration; authenticated MediaWiki **bot passwords** are needed. Scripted requests to the `/api/appid.php?appid=<id>` redirect got 403 (Cloudflare); a browser link-out still works [unverified for browsers].
- **Valuable tables (with auth):** `Infobox_game` (`Steam_AppID`, `GOGcom_ID`, developers, release), `Video` (`HDR`, `Ultrawidescreen`, `Ray_tracing`, `4K_Ultra_HD`, frame-rate cap), `Input` (`Controller_support`, `Full_controller_support`), `API` (DirectX/Vulkan), `Cloud` (save sync) [table and field names from pre-2026 usage; unverified post-migration].
- **Licence: CC BY-NC-SA 3.0.** Displaying cached facts with attribution is fine for a free app. Don't bundle PCGW data into MIT-licensed release artifacts: downstream commercial forks would violate NC, and SA would attach to the bundled dataset.
- **Verdict:** this is the only good free source for ultrawide and detailed HDR data, but it now needs the user's own PCGW account and bot password, so make it an advanced opt-in. Otherwise, show a "View on PCGamingWiki" link-out. Steam category 61 and Microsoft `CapabilityHDR` cover HDR keylessly.

### 3.10 Anti-cheat, cloud and compatibility

- **AreWeAntiCheatYet** [verified]: `https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/HEAD/games.json` (469 KB). Fields: `name, slug, url, logo, native, status, reference, anticheats[], notes[], updates[], dateChanged, storeIds{steam | epic{namespace,slug}}`. **MIT**: it can be bundled (include the notice) and refreshed daily with an ETag. It's Linux/Proton-centric, but the `anticheats` list (EAC, BattlEye, Vanguard…) is useful on Windows too, for example to warn "kernel anti-cheat".
- **GeForce NOW** [verified]: `https://static.nvidiagrid.net/supported-public-game-list/locales/gfnpc-en-US.json` (409 KB) gives `title, steamUrl, store, publisher, genres, status, isFullyOptimized`. No licence is stated. It's public static JSON, so treat it as grey and opt-in, and fetch it at most weekly.
- **ProtonDB** [verified]: `https://www.protondb.com/api/v1/reports/summaries/<appid>.json` returns `{tier, bestReportedTier, trendingTier, score, confidence, total}`. It's undocumented; monthly dumps are **ODbL** (github.com/bdefore/protondb-data, last commit 2026-10-01). Low relevance on Windows.
- **Steam Deck / SteamOS / Steam Machine:** use GetItems `platforms.*_compat_category`, or local appinfo `common.steam_deck_compatibility` (category, tests[] tokens, `configuration.hdr_support`, `recommended_runtime`) [verified].

### 3.11 Wikipedia and Wikimedia Commons

- **Text** [verified]: `https://en.wikipedia.org/api/rest_v1/page/summary/<title>` or Action API `prop=extracts&exintro=1&explaintext=1`. Get the title from the Wikidata sitelink (`schema:about`). Licence **CC BY-SA 4.0**: show "From Wikipedia, CC BY-SA 4.0" with links to the article and the licence. Truncating text is an adaptation, so keep the attribution on the excerpt. SA applies to the excerpt, not to VYSTRAL's code or UI.
- **Images: do not use.** The summary's `thumbnail` for Elden Ring is `upload.wikimedia.org/wikipedia/en/…/Elden_Ring_Box_art.jpg`, a local **non-free** (fair-use) file [verified]. Commons images (`/wikipedia/commons/`) can be free, but game logos there are often "PD-textlogo" with trademark caveats. Low value; skip.

---

## 4. Local, non-API sources per store

| Store | Path | Format | Contains | Notes |
|---|---|---|---|---|
| Steam | `<Steam>\appcache\librarycache\<appid>\` | jpg/png, flat **or** `<sha1>\file` subfolders | `library_600x900.jpg`, `library_capsule[_2x].jpg` (new), `library_hero.jpg`, `library_hero_blur.jpg`, `logo.png`, `header.jpg`, `library_header.jpg`, `<sha1>.jpg` (icon), rarely `markers.svg` | [verified] Tally on the dev PC: header 485, icon 351, hero 271, logo 248, 600x900 234, library_header 111, library_capsule 47. Covers owned, not-installed apps that Steam has displayed. |
| Steam | `<Steam>\appcache\librarycache\assetcache.vdf` | binary KV | appid → cached asset file list (0 = 600x900, 1 = hero, 2 = logo, 3 = header, 4 = icon, 5 = hero_blur) | [verified header strings] An index of what is cached; optional. |
| Steam | `<Steam>\appcache\appinfo.vdf` | binary, magic `0x07564429` (v29) + string table | `common.{name,type,library_assets_full,header_image,logo_position,steam_deck_compatibility,review_score,review_percentage,metacritic_score,associations (dev/pub/franchise),genres,store_tags,category,steam_release_date,original_release_date,icon,clienticon,controller_support}`, `extended.*`, `config.*` | [verified] 1,660 records on the dev PC, covering all 642 librarycache apps. Per-record header: appid u32, size u32, infoState u32, lastUpdated u32, **PICS token u64 (never use)**, sha1[20], changeNumber u32, binary sha1[20], then KV. Types: 0 subsection, 1 string, 2 int32, 7 uint64, 8 end; key = int32 string-table index. |
| Steam | `<Steam>\appcache\packageinfo.vdf` | binary | package → apps, billing | Not needed for metadata. |
| Steam | `<Steam>\appcache\stats\UserGameStatsSchema_<appid>.bin` | binary KV (no string table) | Achievement `name`, localised `display.name/desc`, `hidden`, `icon`/`icon_gray` hashes | [verified] Icon URL: `https://shared.akamai.steamstatic.com/community_assets/images/apps/<appid>/<icon>`. Present for games the client has opened or fetched. |
| Steam | `<Steam>\appcache\stats\UserGameStats_<accountid>_<appid>.bin` | binary KV with bit fields | The user's unlock state and times | [file names verified; layout unverified] The user's own data, but an undocumented layout. Optional; prefer the Web API when a key exists. |
| Steam | `<Steam>\userdata\<id>\config\localconfig.vdf` | text VDF | Playtime, LastPlayed | Already used. |
| Steam | `<Steam>\userdata\<id>\config\grid\` | `<appid>p.png`, `<appid>_hero.png`, `<appid>_logo.png` | **User-customised** Steam library art | [unverified naming] Respect it as user choice (import as source `steam-user`). |
| Epic | `%ProgramData%\Epic\EpicGamesLauncher\Data\Catalog\catcache.bin` | base64 → JSON array | Catalog items: `title, description, keyImages[{type,url,width,height}], developer, namespace, id, categories, customAttributes, releaseInfo, mainGameItem` | [unverified on dev PC; community-documented] Owned/installed catalog items only. |
| Epic | `…\Data\Manifests\*.item`, `%ProgramData%\Epic\UnrealEngineLauncher\LauncherInstalled.dat` | JSON | AppName, namespace, item ID, install path | Already used. |
| GOG | `%ProgramData%\GOG.com\Galaxy\storage\galaxy-2.0.db` | SQLite | `GamePieces(releaseKey, gamePieceTypeId, value JSON)` + `GamePieceTypes`; types `originalTitle/title`, `originalMeta/meta` (`releaseDate, developers, publishers, genres, themes, criticsScore`), `originalImages` (keys reported as `verticalCover, background, squareIcon` [unverified]); `releaseKey` = `gog_<id>`, `steam_<appid>`, etc. | Open **read-only** with a shared-cache/immutable URI. Galaxy holds a lock while running. Contains cross-store keys if the user linked integrations. Don't read Galaxy's credential/token tables. |
| GOG | `<install>\goggame-<id>.info`, `goggame-<id>.ico` | JSON / ico | ID, play tasks, icon | Already used. |
| Xbox / MS | `<install>\MicrosoftGame.config` | XML | `StoreId` (BigId), `TitleId` (hex), `Identity`, `ShellVisuals` (StoreLogo, Square150x150Logo, Square44x44Logo, SplashScreenImage) | Join to displaycatalog by StoreId/TitleId. The logos are small tiles, not covers. |
| Xbox / MS | `AppxManifest.xml` | XML | PFN, `uap:VisualElements` logos | PFN → displaycatalog lookup [verified]. |
| Xbox app | `%LOCALAPPDATA%\Packages\Microsoft.GamingApp_8wekyb3d8bbwe\LocalState\{GameArtCache,ThirdPartyLibraries,AsyncCache.db}` | private | The Xbox app's art cache and third-party library icons | [verified exists] **Avoid**: another app's private package data, and it may contain account data. |
| EA app | `<install>\__Installer\installerdata.xml` | XML (UTF-16 or UTF-8) | Content IDs, localised titles | Already used. |
| EA app | `%ProgramData%\EA Desktop\<hash>\IS`, `%LOCALAPPDATA%\Electronic Arts\EA Desktop\{cookie.ini,…}` | **encrypted** / auth | Install state, session | **Never read.** Decrypting is reverse engineering; cookie.ini is auth. |
| Ubisoft | `<Ubisoft Game Launcher>\cache\configuration\configurations` | protobuf-framed YAML per product | `root.name`, `thumb_image`, `logo_image`, `background_image`, `icon_image`, `localizations`, `start_game` | [unverified on dev PC; community parsers such as Ubi-Parser] Images are commonly resolved at `https://ubistatic3-a.akamaihd.net/orbit/uplay_launcher_3_0/assets/<file>` [unverified]. Don't read `settings.yml` user/session data or `user.dat`. |
| Ubisoft | `<Ubisoft Game Launcher>\cache\assets\` | images | Downloaded art | [unverified] |
| Battle.net | `%ProgramData%\Battle.net\Agent\product.db` | protobuf | Installed product codes, install paths | [unverified on dev PC] No art. Use a small hand-curated product-code → Steam/Wikidata map for the ~15 Blizzard/Activision titles, or SteamGridDB `bnet`. |
| Any exe | `<install>\*.exe` | PE icon resource | App icon | Extract with `SHGetFileInfo`/`ExtractIconEx`; good fallback icon for manual games. |

---

## 5. Matching and caching design

### 5.1 ID-first matching with confidence

| Confidence | Method | Auto-apply? |
|---|---|---|
| 1.00 | Store-native ID from the adapter (Steam appid, GOG product ID, Epic AppName/namespace, MS BigId/PFN) | Yes |
| 0.95 | Cross-ID via the bundled Wikidata map or a live Wikidata query, AWACY `storeIds`, IGDB `external_games`, GOG Galaxy `releaseKey`, ITAD shop lookup | Yes, for metadata **and** art |
| 0.85 | Exact normalised title + release year ±1 + developer match (from any two sources) | Yes, metadata only. Art needs one more signal. |
| 0.70 | Exact normalised title, single unambiguous result (current `PickExactMatch`) | Metadata yes (as today); label it "matched by title" |
| < 0.7 | Fuzzy / multiple candidates | Never automatic. Offer a "Fix match" picker. |

Rules: store `metadata_source`, `match_method`, `confidence` and `matched_id` per game. Never overwrite user-set fields or art (`is_user`). Let users pin a match. Exclude DLC/soundtracks/tools (Steam `type`, GetItems `type`/`item_type`). Normalise titles by stripping ™®©, edition suffixes ("GOTY", "Definitive Edition", "Enhanced") and roman/arabic numeral variants (the existing `TitleNormalizer`).

### 5.2 Source precedence per field

- **Cover (2:3):** user > store-local (Steam librarycache/appinfo, Epic `DieselGameBoxTall`, GOG `verticalCover`) > store CDN (Steam hashed `library_capsule_2x`, MS `Poster`, GOG `boxArtImage`) > cross-store via ID map (usually Steam) > SteamGridDB (opt-in) > IGDB cover (opt-in) > generated placeholder.
- **Hero:** Steam `library_hero[_2x]` > MS `SuperHeroArt` > Epic `DieselGameBox`/`OfferImageWide` > GOG `galaxyBackgroundImage`/`backgroundImage` > SteamGridDB heroes.
- **Logo (transparent):** Steam `logo.png` (hashed via appinfo) > Epic `DieselGameBoxLogo` [unverified type name] > GOG v2 `logo` png > SteamGridDB logos. **No logo** is a valid state, so render the title text.
- **Description:** store-native > Steam (via cross-ID) > Wikipedia extract (opt-in, attributed).
- **Genres/tags:** Steam tags (top N by weight) > GOG tags > MS Category > Wikidata P136.
- **Ratings/age:** store-native (Steam `game_rating`, MS `ContentRatings`, GOG ESRB/PEGI/USK) > Wikidata P852/P908.
- **Review score:** Steam `appreviews` / GetItems reviews > Steam `metacritic` > ITAD/OpenCritic (opt-in).
- **Deck/HDR/controller:** Steam GetItems/appinfo/categories > MS Attributes > GOG features > PCGW (opt-in).

### 5.3 Cache TTLs (suggested)

| Data | TTL | Notes |
|---|---|---|
| Art files | Forever, keyed by URL hash | Re-check the asset index when `assets.last_modified` / `?t=` changes, at most every 30 days |
| Steam asset index (GetItems) | 30 days | Batched |
| appdetails / GOG / MS product | 30 days; 7 days for games released within 90 days | |
| Reviews summary | 3 days | |
| Deck/compatibility | 14 days | |
| News | 6 hours, on demand | |
| Live players | 10 minutes, on demand only | |
| Prices (CheapShark/ITAD/GG.deals) | 6–12 hours, on demand only | Show "as of <time>" |
| Global achievement % | 7 days | |
| Wikidata map | Bundled per release; live fallback 30 days | |
| AWACY / GFN lists | 1 day / 7 days with ETag/If-Modified-Since | |
| Negative results (404 / no match) | 7 days, then 30 days | Avoids hammering for delisted apps |

### 5.4 Offline mode, Data saver and politeness

- **Offline (`privacy.localOnly`):** only Tier 0 runs. This must include the librarycache and appinfo art path for owned-only games (fix A/B), so offline users still get covers.
- **Data saver:** allow local imports and metadata JSON. Defer image downloads, or allow only the cover at 1× (`library_capsule`, not `_2x`). Never prefetch trailers or screenshots.
- **One HTTP client per host** with a token bucket: Steam store at most 1 req/1.6 s (as today); GetItems batched; Wikidata at most 1 concurrent query; GOG/MS at most 2 rps. Honour `Retry-After`. Back off for the whole run on 429/403 (as `MetadataService` already does).
- **User-Agent:** `VYSTRAL/<version> (+https://github.com/Arnav-Dugad/vystral)`. Nothing user-identifying. Wikimedia requires a contact URL.
- **Pause** all enrichment while a game runs (already done) and on metered networks (`NetworkCostService`).

### 5.5 Attribution UI

- Show a per-game "Sources" footnote, e.g. "Art: Steam · Description: GOG · IDs: Wikidata".
- Add a **Settings → Data sources** page listing each source, whether it's enabled, its licence, the last sync time, and "clear cached data from this source".
- **Required attributions:** Wikipedia (CC BY-SA 4.0, link), RAWG (hyperlink on every page using it), GG.deals (hyperlink on each page), IGDB (visible, static attribution if partnered; good practice anyway), ITAD (link), ProtonDB (ODbL notice, if used), PCGamingWiki (CC BY-NC-SA, link), AWACY (MIT notice in About/licences), SteamGridDB (credit the artist).
- Keep affiliate and referral links unmodified where the terms require it (ITAD, GG.deals, CheapShark).

---

## 6. Risks and legal flags

1. **Undocumented-but-public endpoints (grey):** Steam `appdetails`/`storesearch`/`dlcforapp`/`IStoreBrowseService`, Microsoft `displaycatalog` and `sigls`, `api.gog.com`, Epic `store-content`, ProtonDB summaries, the GeForce NOW list. These serve the vendors' own public pages and need no auth, but they can change or rate-limit at any time. Treat them as best-effort, don't try to evade Cloudflare or anti-bot checks, and keep a per-source kill switch.
2. **Never use another launcher's credentials or tokens:** Steam `config/loginusers.vdf` tokens, `ssfn*`, and appinfo's per-app PICS tokens; Epic `GameUserSettings.ini` RememberMe and launcher tokens (needed for the catalog service, so avoid it); EA `cookie.ini` and the encrypted `IS`; Ubisoft `user.dat`/settings; GOG Galaxy auth tables; the Xbox app's `AsyncCache.db`.
3. **Secrets in an open-source binary:** IGDB/Twitch client secret, ITAD per-app key, RAWG key, Steam Web API key (whose terms require confidentiality), GG.deals and RapidAPI keys. The answer is **BYO** in Credential Manager. A VYSTRAL-run proxy would be a new server, a privacy surface and a cost, and it conflicts with "no telemetry / local-first".
4. **Artwork copyright:** all store art belongs to the publishers or the store. Display it inside the user's own library, cache it per user, **never** bundle downloaded art in releases or the repo, and don't build a "share/export art pack" feature. SteamGridDB art is community-made and also copyrighted; credit the authors.
5. **Licences with strings attached:** PCGamingWiki is **NC-SA**, so don't redistribute its data in MIT artifacts. Wikipedia text is **BY-SA**: attribute it and keep excerpts identifiable. ProtonDB dumps are **ODbL**: bundling a derived DB in releases triggers share-alike, while per-user display needs only attribution. RAWG forbids redistribution. ITAD forbids altering data and competing apps. LaunchBox's licence is unclear, so avoid it.
6. **Policy changes in 2026:** Wikimedia's global API rate limits (a contact User-Agent is required), PCGamingWiki's anonymous Cargo shutdown, Steam's `ISteamApps` removal (Nov 2025), and IGDB's enum→table migration. Build adapters defensively (schema-tolerant parsing, feature flags) and add a monthly "sources health" CI job that hits one known ID per source.
7. **Privacy:** every lookup tells the provider that "this IP has game X". Prefer local data, the bundled Wikidata map and on-demand calls for third parties. Batch only to first-party stores (Valve already knows the Steam library). Document each source in `docs/PRIVACY.md`.
8. **Untrusted data:** sanitize HTML (Steam requirements, GOG descriptions), strip BBCode, use HTTPS-only host allowlists for image URLs (`*.steamstatic.com`, `store-images.s-microsoft.com`, `images.gog-statics.com`, `cdn1.epicgames.com`, `images.igdb.com`, `cdn2.steamgriddb.com`), and keep the existing size caps and magic-byte sniffing. Validate relative asset paths with a strict regex (the §1 fix).
9. **Scraping:** HowLongToBeat, Metacritic and SteamDB have no API for this use. Don't scrape; link out instead.

---

## 7. Sources

**Steam / Valve**
- Steam Web API Terms of Use: https://steamcommunity.com/dev/apiterms
- ISteamApps (deprecation note): https://partner.steamgames.com/doc/webapi/isteamapps
- GetAppList migration discussion: https://github.com/AuthFailed/steamy-py/issues/13
- appdetails rate-limit reports: https://medium.com/codex/scraping-information-of-all-games-from-steam-with-python-6e44eb01a299
- Live endpoints probed: `api.steampowered.com/IStoreBrowseService/GetItems/v1`, `IStoreService/GetTagList`, `IStoreQueryService/{Query,SearchSuggestions}`, `ISteamUserStats/*`, `ISteamNews/GetNewsForApp`, `store.steampowered.com/{api/appdetails,api/dlcforapp,appreviews,saleaction/ajaxgetdeckappcompatibilityreport,tagdata/populartags}`, `shared.akamai.steamstatic.com/store_item_assets/…`

**IGDB / Twitch**
- https://api-docs.igdb.com/ (auth, rate limits, external games, time-to-beat, images, partnership, data dumps, FAQ)
- Embedded-secret risk discussion: https://github.com/Mithrandir21/game-deals-app/issues/325

**Wikidata / Wikimedia**
- https://www.wikidata.org/wiki/Property:P1733 (and the properties listed in §3.2, via `wbgetentities`)
- https://www.mediawiki.org/wiki/Wikidata_Query_Service/User_Manual
- https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits
- https://lists.wikimedia.org/hyperkitty/list/wikidata@lists.wikimedia.org/thread/PNQ4FPLNUR77WPWQFF7GSSSLWO3NNOIA/

**PCGamingWiki**
- https://www.pcgamingwiki.com/wiki/PCGamingWiki:API
- https://github.com/arelate/vangogh/issues/212
- https://github.com/dguay/goodgame/issues/11
- https://github.com/Jeshibu/PlayniteExtensions/issues/110
- https://github.com/PCGamingWiki/api/blob/master/README.md
- Licence (CC BY-NC-SA 3.0): https://www.wikidata.org/wiki/Q17013880

**Art databases**
- SteamGridDB API: https://www.steamgriddb.com/api/v2
- SteamGridDB node wrapper: https://github.com/SteamGridDB/node-steamgriddb
- SteamGridDB terms: https://www.steamgriddb.com/terms
- Heroic Epic keyImages order: https://github.com/Heroic-Games-Launcher/HeroicGamesLauncher/pull/387

**Other metadata APIs**
- RAWG: https://rawg.io/apidocs, https://rawg.io/tos_api
- MobyGames: https://www.mobygames.com/api/subscribe/, https://www.mobygames.com/mobyplus/
- Giant Bomb: https://giantbomb.com/articles/changes-to-the-giant-bomb-api
- TheGamesDB: https://api.thegamesdb.net/, https://forums.thegamesdb.net/viewtopic.php?t=60
- OpenCritic (RapidAPI): https://rapidapi.com/opencritic-opencritic-default/api/opencritic-api/pricing
- LaunchBox: https://gamesdb.launchbox-app.com/Metadata.zip, https://feedback.launchbox-app.com/help/articles/8890692-getting-started-with-the-launchbox-games-database

**Prices**
- IsThereAnyDeal: https://docs.isthereanydeal.com/
- CheapShark: https://apidocs.cheapshark.com/
- GG.deals: https://gg.deals/api/, https://gg.deals/api/prices/

**Compatibility, anti-cheat and cloud**
- ProtonDB data (ODbL): https://github.com/bdefore/protondb-data
- AreWeAntiCheatYet (MIT): https://github.com/AreWeAntiCheatYet/AreWeAntiCheatYet
- GeForce NOW list: https://static.nvidiagrid.net/supported-public-game-list/locales/gfnpc-en-US.json

**Stores (probed)**
- GOG: `api.gog.com/products/<id>`, `api.gog.com/v2/games/<id>`, `catalog.gog.com/v1/catalog`
- Microsoft: `displaycatalog.mp.microsoft.com/v7.0/products`, `/products/lookup`, `catalog.gamepass.com/sigls/v2`
- Epic: `store-content.ak.epicgames.com/api/en-US/content/products/<slug>`, `store-site-backend-static.ak.epicgames.com/freeGamesPromotions`

**Local formats**
- GOG Galaxy DB: https://github-wiki-see.page/m/AB1908/GOG-Galaxy-Export-Script/wiki/Query, https://github.com/ChriZ982/gog-galaxy-2.0-start-menu-tiles/blob/master/database.go
- Ubisoft cache parser: https://github.com/UplayDB/Ubi-Parser

**HowLongToBeat (no official API)**
- https://github.com/ckatzorke/howlongtobeat (community scraper, for context only)

---

## 8. Track D4 decisions: every source for every game (2026-10-10)

Checked on **2026-10-10** with live requests from the development PC (fixtures in `tests/Vystral.Tests/Fixtures/D4/`, trimmed) and the providers' own pages. Same markings as above.

### 8.1 Cross-store identity

Built (`src/Vystral.Windows/DataSources/Identity/`): a resolver that gives every library game a Steam app ID, IGDB ID, RAWG slug, GOG product ID and Wikidata item **with a confidence and the evidence**, following §5.1. Sources, in the order asked: Wikidata entity search (title → item with `P1733`/`P12727`/`P9968` and `P577` year) [verified], Steam `storesearch` (unique exact title) then `appdetails` (type `game`, year within ±1) [verified], IGDB search + `external_games` (your key), RAWG search + `/games/{id}/stores` cross-check (your key), GOG catalogue search (opt-in). Rules and thresholds are in INTEGRATIONS.md. Findings:

- Steam's `storesearch` has **no release years** [verified], so a title match alone is 0.70 ("suggested"); the year comes from that one app's `appdetails`.
- GOG's catalogue search must **not** use `order=desc:score`: with it, `query=like:Cyberpunk 2077` returned unrelated games; without it, the two Cyberpunk products [verified]. For a game GOG doesn't sell (Hades), `like:` returns fuzzy unrelated titles, which the exact-title rule rejects [verified, fixture `gog_catalog_hades.json`].
- Xbox installations only carry a package family name (no Store ID) in VYSTRAL today, so Xbox games are matched by title + year; Microsoft's `displaycatalog` lookup by PFN (§3.3) would make that ID-based and is the obvious next step.

### 8.2 Trailers from any source

- **Steam** through the resolved app ID first (no new endpoint).
- **RAWG** `/games/{id}/movies` — documented ("Get a list of game trailers"), `Movie.data` is an object keyed by quality [docs: RAWG OpenAPI]; from memory and community reports the values are `480`/`max` MP4 URLs that mostly point at Steam's CDN [unverified with a live key]. VYSTRAL accepts only allow-listed HTTPS hosts (Steam video CDNs, `media.rawg.io`) and `.mp4` paths.
- **IGDB** `game_videos` → YouTube IDs only [docs]. **GOG** `api.gog.com/v2/games/{id}` → `_embedded.videos[]` with `provider: "youtube"` and `videoId` [verified: 1207664663].
- **YouTube** is embedded only behind an opt-in, in privacy-enhanced mode (`www.youtube-nocookie.com/embed/{id}` returned 200 [verified]) in a sandboxed frame that the window's frame-navigation check pins to that exact URL shape. Reasoning for doing it at all: it's the only trailer source for most non-Steam games, and it can be contained (no navigation, no popups, no access to the page or the bridge). Residual: Google sees the viewer's IP and the video; documented in PRIVACY.md and next to the setting.

### 8.3 New free sources: chosen

| Source | Verdict | Why |
|---|---|---|
| **GamerPower** `www.gamerpower.com/api/giveaways` | **Integrated, opt-in** | Documented, keyless, "free for personal and commercial use" with an active link back to GamerPower.com; < 10 requests/s asked [docs: gamerpower.com/api-read]. Live list returned 6+ PC giveaways with worth, end date and a GamerPower page per item [verified]. Answers `201` when there are none [docs]. Feeds `freebies.get` for Track D5's shelf |
| **Epic free-games feed** `store-site-backend-static.ak.epicgames.com/freeGamesPromotions` | **Integrated, opt-in (grey)** | Keyless JSON behind Epic's own store page [verified, 50 KB]. Free items are promotions with `discountPercentage: 0`; "upcoming" ones sit in `upcomingPromotionalOffers` and the feed is a snapshot, so a window that has started is "free now". Exact dates make it better than GamerPower for Epic |
| **ProtonDB summaries** `www.protondb.com/api/v1/reports/summaries/{appid}.json` | **Integrated, opt-in (grey)** | `{tier, bestReportedTier, trendingTier, score, confidence, total}` [verified: 1245620 → gold, 2,105 reports]. Undocumented; dumps are ODbL. Useful as "Runs on Linux / Steam Deck" for Steam and matched games |
| **GOG catalogue** `catalog.gog.com/v1/catalog`, `api.gog.com/v2/games/{id}` | **Integrated, opt-in (grey)** | Gives GOG product IDs for non-GOG games (identity) and GOG's trailer list. Product data (art, features) could follow later |

### 8.4 New free sources: rejected

| Source | Verdict | Why |
|---|---|---|
| **SteamSpy** | Rejected | Re-checked: `appdetails` for Hades still returns `average_forever: 0`, `median_forever: 0` [verified]; only a coarse owners range ("5,000,000 .. 10,000,000") and tags remain, and Steam's own tags are already used. No stated terms |
| **OpenCritic** (RapidAPI) | Rejected for now | Needs a RapidAPI key; the free tier is ~25 searches a day [docs, via search], too small for library-wide matching; Steam's Metacritic field and IGDB's critic score already cover "critics" |
| **Giant Bomb** | Rejected | The API page answers **403** to scripted requests [verified]; terms are non-commercial and unclear after the 2025 sale [unverified]; key in the query string; little over IGDB/Wikidata |
| **MobyGames** | Rejected | Paid key (from $9.99/month) [docs, via search]; `api.mobygames.com` answers 401 without one [verified] |
| **TheGamesDB** | Rejected | Key on request with a small monthly allowance; `api.thegamesdb.net` answers 418 without one [verified]; retro/console-centred |

### 8.5 Health

Each new source is a row in `dataSources.status` (last test, rate-limit pause, licence, host, what's sent) with *Test*, and a probe in `NetworkHealthService` (`provider.gamerpower`, `provider.epicfree`, `provider.protondb`, `provider.gogcatalog`), so Track D6's health page can list them without new plumbing.

