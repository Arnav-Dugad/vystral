# Cloud gaming in VYSTRAL: Xbox Cloud Gaming and GeForce NOW

Research only. No code was changed. Researched 2026-10-05.

How evidence is marked in this document:

- **[Verified]**: checked directly on 2026-10-05, either by an HTTP probe, by looking at a public page, or by inspecting the dev PC (Xbox app 2610.1001.8.0 and GeForce NOW app 2.0.88.129 are installed).
- **[Official]**: stated in vendor documentation.
- **[Secondary]**: reported by press or community sources and not confirmed by the vendor.
- **[Unverified]**: an inference or an open question.

Some 2026 search results came from SEO content farms (tech-insider.org, shattered.io and similar). Those sites are not used as evidence for anything stated as fact here.

---

## 1. Executive summary

**Verdict: both services can be added.** VYSTRAL should be a **launcher and companion** for cloud play. It should not be a **cloud client**. It finds out that a game can be streamed, shows that next to the installed copies, checks whether the PC and network look ready, starts the stream using the vendor's own app or website, and keeps a local record of the session. The stream itself always runs in an official surface: the Xbox PC app, the GeForce NOW app, or Edge or Chrome on the vendor's own site.

| | Xbox Cloud Gaming | GeForce NOW |
|---|---|---|
| Launch a specific game | ✅ `https://www.xbox.com/{locale}/play/launch/{slug}/{productId}` in a browser. The slug is cosmetic and the site corrects it (verified). ✅ `msxbox://game/?productId={id}` opens the game's page in the Xbox PC app (Microsoft documents this). The user then presses Stream. No documented way exists to start the stream from inside the app. | ✅ `https://play.geforcenow.com/games?game-id={uuid}&utm_source=…&utm_campaign=…`. NVIDIA documents this deep link and lists "aggregator developers" as an intended user. ⚠️ `GeForceNOW.exe --url-route="#?cmsId={cmsId}&launchSource=External…"` starts the game directly in the desktop app. NVIDIA does not document it, but its own "Create desktop shortcut" feature and Playnite use it. |
| Which games can be streamed | ⚠️ `catalog.gamepass.com/sigls/v2?id=…`: undocumented but public JSON that xbox.com's own pages use. ⚠️ `displaycatalog.mp.microsoft.com/v7.0/products`: undocumented public JSON that gives each game's PackageFamilyName, which joins straight onto the existing XboxAdapter IDs. | ⚠️ `api-prod.nvidia.com/services/gfngames/v1/gameList`: undocumented public GraphQL that nvidia.com's public games page uses. It covers about 6,100 titles (US), with Steam, Epic, Xbox, Ubisoft, Battle.net, EA and GOG store IDs and an Install-to-Play flag. ❌ The old documented `gfnpc.json` now returns `null` (verified). |
| Service status | ⚠️ `xnotify.xboxlive.com/servicestatusv6/{market}/{lang}`: undocumented XML behind support.xbox.com. It has a "Cloud gaming & remote play" category. | ✅ `status.geforcenow.com/api/v2/*.json`: the standard public Atlassian Statuspage API, with 113 components (data centres and cloud storage). |
| SDK or partner programme | None for third-party launchers. | GFN SDK (NVIDIAGameWorks/GeForceNOW-SDK). Its EULA is proprietary, it is aimed at game developers and publishers, and it needs registration. **It isn't suitable for VYSTRAL.** The deep link documentation is what applies to VYSTRAL. |

**Recommended architecture:** "Play on" launch targets, with no embedded stream:

1. **Official desktop app first, if it's installed.** For GeForce NOW that means the `--url-route` launch, which goes straight into the game. For Xbox it means `msxbox://game/?productId=` (the game page in the Xbox app, one more click to stream).
2. **Otherwise, a chromeless Microsoft Edge `--app=` window** on the official URL. VYSTRAL gives it a separate Edge user-data folder that it never reads. A browser setting lets the user choose their default browser instead.
3. **Never** render xbox.com/play or play.geforcenow.com inside VYSTRAL's UI WebView2, and **don't** build a dedicated WebView2 player window either. Section 4 explains why.

**What is allowed, what is grey and what is forbidden** (judged against the VYSTRAL spec):

- **Clearly allowed:** launching the official apps or official URLs and deep links; the GeForce NOW deep link format (documented for aggregators); `msxbox://` and `ms-windows-store://` (Microsoft documents both); the public Statuspage API; read-only process and window detection; Windows network APIs (NetworkInformation, connection cost, signal bars, connected SSID); pinging the local default gateway; storing session history locally; pointing users to the vendors' own network tests.
- **Grey (allowed with care):** undocumented but public JSON that the vendors' own public web pages use: Game Pass SIGLs, displaycatalog, the NVIDIA gameList GraphQL and the Xbox xnotify status feed. All of them are unauthenticated and need no cookies or tokens. They can change without warning. They need caching, low request rates, an opt-in, and graceful failure. The GeForce NOW `--url-route` argument is also grey: it's undocumented, but it is what the vendor's own app writes into its desktop shortcuts.
- **Forbidden:** unofficial streaming clients (Greenlight, XStreaming, OpenNOW); injecting userscripts or extensions into vendor pages (Better xCloud approach); spoofing user agent or resolution (gfn-electron's "stream quality override"); calling private front-end APIs that need special headers (`emerald.xboxservices.com/xboxcomfd/…` asks for an `MS-CV` header; `*.cloudmatchbeta.nvidiagrid.net/v2/serverinfo` is the session-matching backend); reading another app's caches, cookies or LevelDB (GFNOW-SYNC reads GeForce NOW's CacheStorage); automating clicks in the vendor UI; reading or relaying sign-in tokens.

---

## 2. Xbox Cloud Gaming (xCloud)

### 2.1 What VYSTRAL already has

`src/Vystral.Windows/Integrations/XboxAdapter.cs` finds installed packaged games through `PackageManager.FindPackagesForUser("")` plus `MicrosoftGame.config` or `.GamingRoot`. It stores `PlatformGameId = PackageFamilyName` and launches by AUMID. `GetClientPageUri` returns `ms-windows-store://pdp/?PFN=…`. The adapter has no Store ProductId and no cloud awareness. Its own limitation text says "Game Pass games you haven't installed aren't shown". Cloud play fixes exactly that gap.

### 2.2 Launch methods

| Method | Shape | Status | Notes |
|---|---|---|---|
| Browser, game page | `https://www.xbox.com/{locale}/play/games/{slug}/{productId}` | **[Verified]** | `…/play/games/wrong-slug-test/9NPDN9R45JX4` redirected to `…/play/games/1000xresist/9NPDN9R45JX4` and showed the game with a Play button. **The slug is ignored and productId is the key.** |
| Browser, launch directly | `https://www.xbox.com/{locale}/play/launch/{slug}/{productId}` | **[Verified]** the URL returns 200. Starting the stream needs sign-in and wasn't tested. | Used by the Playnite XCloud Library plugin. A public page URL, not an API. |
| Xbox PC app, game page | `msxbox://game/?productId={productId}` | **[Official]** In Microsoft Learn's PlayFab "Economy v2 deep links" table it is listed as `microsoft-xbox-pc`. **[Verified]** the `msxbox` protocol is registered on the dev PC. | Opens the game's page. Whether a Stream or Play button appears depends on entitlement and region. No documented parameter starts the stream automatically. **[Unverified]** whether any undocumented action parameter exists. Don't guess one. |
| Xbox PC app, other protocols | `msgamelaunch`, `msgamepass`, `msgamingapp`, `msxboxl`, `xbox`, `xbox-gamehub`, `xbox-settings`, … | **[Verified]** declared in the Microsoft.GamingApp AppxManifest | None of their cloud routes are documented. Don't use them for streaming. `xbox-settings` might be useful later to open the Xbox app's settings. |
| Store page | `ms-windows-store://pdp/?ProductId={id}` | **[Official]** | Fallback for "Buy" or "Get". |
| Edge, chromeless | `msedge.exe --app="https://www.xbox.com/{locale}/play/launch/…/{id}"` | Microsoft's own Steam Deck guide uses Edge with `--kiosk "https://www.xbox.com/play"` as a launcher entry **[Official]**. | Kiosk mode on Windows runs **InPrivate**, so the user would have to sign in every time **[Secondary]**. Use `--app=` instead. Section 4 covers this. |

There is **no official API that lets a third-party app start a cloud session for a specific title.** The best available is a one-click launch into the official surface. In a browser, the `/play/launch/` URL may start the stream immediately once the user is signed in **[Unverified: not tested while signed in]**.

Process facts **[Verified]**: the Xbox app's executables are `XboxPcApp.exe` (AUMID `…!Microsoft.Xbox.AppL`) and `XboxPcAppCE.exe` (`…!Microsoft.Xbox.App`). The package contains `Microsoft.Web.WebView2.Core.dll`, so the Xbox app's own cloud player is probably a WebView2 surface **[Unverified]**.

### 2.3 Which games can be streamed (catalogue data)

**Game Pass SIGL lists** (`https://catalog.gamepass.com/sigls/v2?id={guid}&market={CC}&language={ll-CC}`) **[Verified]**:

- They need no authentication. The response is `Cache-Control: max-age=600`.
- The shape is a header object `{siglId,title,description,imageUrl}` followed by `[{"id":"<StoreProductId>"}…]`.
- The IDs come from xbox.com's own public script (`xgpcatPopulate-MWF2.js`, documented by the itimurcom/gamepass repo).

| SIGL GUID | Meaning (title the endpoint returns) | Count, US, 2026-10-05 |
|---|---|---|
| `29a81209-df6f-41fd-a528-2ae6b91f719c` | "allCloud" in xbox.com's script ("All games") | 561 |
| `97c6c862-d28a-4907-a3d5-c401f2296a53` | Ultimate "All games" | 901 |
| `09a72c0d-c466-426a-9580-b78955d8173a` | "Game Pass Premium" | 570 |
| `34031711-5a70-4196-bab7-45757dc2294e` | "Game Pass Essential" | 124 |
| `609d944c-…-e9f39b52c1ad` / `fdd9e2a7-…-4354098401ff` | "All PC Games" | — |
| `f13cf6b4-57e6-4459-89df-6aec18cf0538` | "Recently added" (the xCloud carousel) | 24 |
| `e7590b22-…`, `88c10a22-…` and genre lists | popular, touch, mobile and genre cloud lists | — |

`https://catalog.gamepass.com/subscriptions?subscription=all&market=US` **[Verified]** returns per-subscription product ID arrays with these keys: `pc`, `console`, `ultimate`, `gamepassstandard`, `gamepasscore`, `eaaccess`, `ubisoftplus`, `xgpp`, `nakupc`, `nakuconsole`, `gtaplus`.

**Product details**: `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds={ids,comma}&market=US&languages=en-us` **[Verified]**. It is unauthenticated and accepts batches of IDs. Useful fields:

- `LocalizedProperties[0].ProductTitle`, plus `Images[]` with `ImagePurpose` values: Poster (1440×2160), BoxArt, SuperHeroArt (3840×2160), TitledHeroArt, Logo and Screenshot.
- `Properties.PackageFamilyName`. **This joins directly onto `XboxAdapter.PlatformGameId`.**
- `Properties.Attributes[]`: for example `ConsoleKeyboardMouse`, `XblCloudSaves`, `XPA`, `Capability4k`.
- `AlternateIds` includes `XboxTitleId`.

No per-product "cloud playable" attribute turned up in our probe. Cloud availability comes from SIGL membership.

**What a SIGL entry means, and what's still unclear:**

- Membership in allCloud means the title can be streamed in that market.
- Whether a subscription *includes* it should come from the tier lists (Ultimate, Premium, Essential).
- Anomaly **[Verified]**: 1000xRESIST is in allCloud and in the Premium SIGL, yet its xbox.com page footnote says *"Cloud playable with Xbox Game Pass Essential, Premium or Ultimate. Game purchase required."* Treat inclusion as a hint. Word it carefully, for example "Cloud playable · may be included with Game Pass", and let xbox.com show the final answer.

**Stream your own game (BYOG):**

- Owned games outside Game Pass can be streamed if they're on the BYOG list **[Official]**.
- It reached the Xbox PC app for Insiders in July 2025 **[Official, Xbox Wire 2025-07-15]**.
- About 30 titles were added in September 2026 **[Secondary]**.
- No separate public BYOG list ID was found. VYSTRAL can't know what the user owns without signing in, and it won't sign in. The heuristic: if the game is installed locally through XboxAdapter **and** appears in allCloud, show "Stream (if you own it or it's in your plan)".

**Rate and terms:**

- No published rate limits exist.
- Refresh no more than once every 24 hours.
- Batch displaycatalog calls (about 20 IDs per request).
- Honour `Cache-Control` and back off on 429 or 5xx responses.
- Send no cookies. Send a plain `User-Agent` that identifies VYSTRAL.
- Put the feature behind an opt-in "Online catalogue data" switch, as VYSTRAL's other online features already are.

### 2.4 Requirements (as of October 2026)

| Topic | Fact | Source |
|---|---|---|
| Plans | **Essential, Premium and Ultimate** include cloud gaming. **PC Game Pass does not.** | xbox.com/cloud-gaming **[Official]** |
| **Hour caps** | From **November 2026**: Ultimate **15 h**, Premium **10 h** and Essential **5 h** per month. Extra hours can be bought in the Xbox Store (price not yet announced). Non-subscribers can buy cloud hours to stream games they own. Microsoft says the change affects about 4% of members. | Xbox Wire, 2026-09-03 **[Official]** |
| Grandfathering | Some existing auto-renewing subscribers in certain countries were emailed that the caps won't apply to them. | VGC **[Secondary]** |
| Resolution and bitrate | Ultimate: up to **1440p**, with peak bitrate raised from about 10 to **about 27 Mbps**. It reached consoles in February 2026. The beta tag was dropped. | Xbox Wire, 2026-02-25 **[Official]**, plus press **[Secondary]** |
| Free with ads | Insider test since about 2026-07-23: about 2 minutes of pre-roll ads, **1-hour sessions**, about 5 h a month. It covers owned games, Free Play Days and Retro Classics. | Press **[Secondary/Unverified]** |
| Bandwidth | At least 10 Mbps. 20 Mbps is recommended for PCs, consoles and tablets. Ethernet is preferred, then 5 GHz Wi-Fi. | xbox.com/cloud-gaming, Xbox Wire 2025-12-19 **[Official]** |
| Browsers | Edge, Chrome and Safari. | **[Official]** |
| Regions | 29 countries (xbox.com/regions). | **[Official]** |
| Input | "Most games require a gamepad". Some titles support mouse and keyboard or touch. The displaycatalog attribute `ConsoleKeyboardMouse` is a hint. | **[Official]** |
| Limitations | Limited resolution and audio outputs. Saves are cloud saves only. | **[Official]** |

**Estimated data use** (derived as Mbps × 0.45 = GB/h; these are upper bounds, and real use varies by game and scene):

- About 10 Mbps (1080p, non-Ultimate): **up to about 4.5 GB/h**
- About 20 Mbps (recommended link): **up to about 9 GB/h**
- About 27 Mbps peak (Ultimate 1440p): **up to about 12 GB/h**

### 2.5 Status

`https://xnotify.xboxlive.com/servicestatusv6/US/en-US` **[Verified]** returns XML with an `Overall` state and categories. Category 14 is "Cloud gaming & remote play". It also lists a "Cloud gaming" device and a "Launching cloud games" scenario. The feed is undocumented and backs `support.xbox.com/xbox-live-status`. **Grey.** Fetch it only when the user opens a cloud action or the Cloud panel, and cache it for 5 minutes. Always link to the official status page too.

### 2.6 Session detection (read-only)

- **Edge `--app` with a VYSTRAL-only `--user-data-dir`:** VYSTRAL owns the process tree. The session starts when the window appears and ends when the process exits. This is the most reliable option **[Unverified: Edge's process model should be checked on Windows 11 26H1]**.
- **Xbox app:** there's no separate stream process. Use `EnumWindows` and `GetWindowText` on `XboxPcApp.exe` windows and use foreground time. **[Unverified]** whether the window title changes while streaming. Otherwise fall back to "Xbox app focused after a VYSTRAL cloud launch", with a prompt such as "Still playing?".
- Never read the Xbox app's storage, use UI Automation on it, or hook it.

### 2.7 Terms of service notes

Microsoft Services Agreement (effective **30 September 2026**) **[Official]**:

- *"Don't circumvent any restrictions on access to, usage, or availability of the Services (e.g., … impermissible scraping)."*
- *"You may not … disassemble, decompile, decrypt, hack, emulate, exploit, or reverse engineer any software or other aspect of the Services."*
- *"You may not … enable access to the Services or modify any Microsoft-authorized device … by unauthorized third-party applications."*

Reading of these clauses:

- Opening xbox.com in Edge or Chrome, or starting the Xbox app, is ordinary use.
- An app that *hosts* the xCloud player (a WebView2 wrapper) is arguably "access … by an unauthorized third-party application". That is a grey area, and one more reason not to embed.
- Reading public catalogue JSON at a polite rate isn't circumvention, but "impermissible scraping" is undefined. Keep it low-volume, cached and opt-in, and stop if Microsoft objects.

---

## 3. GeForce NOW (GFN)

### 3.1 Launch methods

| Method | Shape | Status | Notes |
|---|---|---|---|
| **Documented web deep link** | `https://play.geforcenow.com/games?game-id={uuid}&utm_source={src}&utm_campaign={campaign}`. Optional: `utm_medium`, `utm_term`, `utm_content`. | **[Official]** `GfnSdk-Deep-Linking.md`. The intended audience includes *"Aggregator developers building game catalogs"*. **[Verified]** it redirects to `/mall/#/deeplink?game-id=…` and then a sign-in wall that says "Stream this game". | Supported in Chrome 77+, Edge 91+ (Windows) and Yandex. Games not available in the user's region open the home page. Use `utm_source=vystral`. |
| **Desktop app direct launch** | `"%LOCALAPPDATA%\NVIDIA Corporation\GeForceNOW\CEF\GeForceNOW.exe" --url-route="#?cmsId={cmsId}&launchSource=External&shortName=game_gfn_pc&parentGameId="` | **[Unverified]** that it's official. Playnite's GFN plugin uses exactly this. NVIDIA's app has a right-click "add a shortcut to your desktop" action (@NVIDIAGFN), and community shortcuts show the same arguments. | **[Verified]** the folder contains `GeForceNOW.exe`, `GeForceNOWStreamer.exe` and `GeForceNOWContainer.exe`. **Grey:** an undocumented argument, but the same one the vendor's own shortcuts carry. Older guides target `GeForceNOWStreamer.exe`; current tools target `GeForceNOW.exe`. |
| Protocol | `geforcenow:` → `"…\CEF\GeForceNOW.exe" "%1"` (registered under HKCU) | **[Verified]** that it's registered. The URL grammar is undocumented. | Don't build on it until NVIDIA documents it. |
| GFN SDK `StartStream` | — | The current public SDK 4.1 headers (`GfnRuntimeSdk_CAPI.h`) expose cloud-side APIs only (`gfnIsRunningInCloud`, `gfnSetupTitle`, `gfnOpenURLOnClient`, …). The README still mentions "GFN Client Deep Link". | The proprietary EULA allows distribution only inside apps with "substantial value-added content", requires a matching EULA and NVIDIA attribution, and **assigns source modifications to NVIDIA**. Registration goes through `gdp-queries@nvidia.com`. **Not suitable for an MIT, local-first launcher.** |

### 3.2 Supported-games data

- **`https://static.nvidiagrid.net/supported-public-game-list/gfnpc.json`**: the long-standing public list (Playnite and many tools used it). **[Verified] on 2026-10-05 the body is `null`** (4 bytes). It is still regenerated about every 15 minutes (`Last-Modified` changes), and `Access-Control-Allow-Origin: *` is set. The `locales/gfnpc-xx-XX.json` files are frozen at **2022-03-29**. **Unusable.**
- **`POST https://api-prod.nvidia.com/services/gfngames/v1/gameList`** **[Verified]**. The public nvidia.com/geforce-now/games page uses this endpoint.
  - **The body is the raw GraphQL text with `Content-Type: text/plain`.** A JSON-wrapped body returned HTTP 500.
  - Pages hold 750 items, with cursor paging through `pageInfo{endCursor hasNextPage}`.
  - US, 2026-10-05: **6,092 items in 9 pages**. 2,239 are `READY_TO_PLAY` and **3,853 are `INSTALL_TO_PLAY`**. `minimumMembershipTierLabel` is "Premium" on 4,005 items and null on 2,087.
  - Store variant counts: STEAM 5,914, EPIC 552, **XBOX 459** (the `storeId` is the Microsoft Store ProductId, e.g. `9P75CBJ9WT9W`), UPLAY 115, BATTLENET 29, EA_APP 22, GOG 13, plus others.

Working query (fields verified):

```graphql
{ apps(country:"US" language:"en_US" after:"") {
    numberReturned pageInfo { endCursor hasNextPage }
    items { id cmsId title sortName
            gfn { playType minimumMembershipTierLabel }
            variants { id appStore storeId publisherName }
            images { GAME_BOX_ART GAME_LOGO FEATURE_IMAGE TV_BANNER GAME_ICON } } } }
```

- `id` (a UUID) has the same format as the deep-link `game-id` in NVIDIA's documentation. `cmsId` (numeric) is the ID used by `--url-route`.
- **Mapping to VYSTRAL adapters:**
  - STEAM `storeId` is the appid (`SteamAdapter.PlatformGameId`) **[Verified: HL2 = 220]**.
  - EPIC `storeId` is a 32-hex ID. **[Unverified]** whether it's the `CatalogNamespace` or the `CatalogItemId`. EpicAdapter reads both from manifests but keys on `AppName`.
  - XBOX `storeId` → displaycatalog → PackageFamilyName → `XboxAdapter.PlatformGameId`.
  - UPLAY `storeId` probably equals Ubisoft's install ID (Far Cry 3 = 599) **[Unverified]**.
  - BATTLENET and EA_APP mappings are unknown. Playnite users report Battle.net ID mismatches (darklinkpower issue #576).
- **Install-to-Play**: Performance and Ultimate members can install Steam games that publishers have opted into Steam Cloud Gaming (2,200+ by NVIDIA's count at launch; 3,853 flagged today). From 2026-04-30 members keep Install-to-Play access after their 100 hours run out, at free-tier performance **[Secondary]**. Show it as "GeForce NOW · Install-to-Play (premium)".
- **Licence:** NVIDIA publishes no licence for the data. It's public facts with no stated terms. **Grey.** Fetch no more than once a day per country, and only with the user's opt-in. Store only the fields that are needed. Don't redistribute a cached copy inside VYSTRAL's releases.

### 3.3 Memberships and limits (as of October 2026)

| Topic | Fact | Source |
|---|---|---|
| Tiers | Free (ads, basic rigs, queues), **Performance** (up to 1440p60), **Ultimate** (RTX 5080 rigs, up to 5K 120 / 360 fps, DLSS), and a **Day Pass** (24 h of Performance or Ultimate). | nvidia.com FAQ and memberships pages **[Official]** |
| **Monthly playtime** | From **2026-01-01**: Performance and Ultimate get **100 h** a month, and **up to 15 unused hours roll over** for one month. 15-hour top-ups cost **$2.99 (Performance) / $5.99 (Ultimate)**. Founders keep unlimited time while their membership doesn't lapse. Paid members as of 2024-12-31 kept unlimited time until their first cycle after 2026-01-01. | NVIDIA FAQ **[Official]**, 9to5Google **[Secondary]** for prices |
| Session length | Free **1 h**, Performance **6 h**, Ultimate **8 h**. | Multiple secondary sources **[Secondary: verify on the memberships page, which renders with JavaScript]** |
| Price (US) | Performance $9.99 a month, Ultimate $19.99 a month. | **[Secondary]** |
| Bandwidth | 15 Mbps for 720p60, 25 Mbps for 1080p60, 35 Mbps for 1440p or ultrawide QHD at 120, 45 Mbps for 4K120. Latency under 80 ms to an NVIDIA data centre (under 40 ms recommended). 5 GHz Wi-Fi or Ethernet. | nvidia.com/geforce-now/system-reqs **[Official]** |
| Browser | Chrome 77+ and Edge 91+ on Windows. QHD and 120 fps in the browser need Ultimate. | **[Official]** |
| Windows app | 64-bit Windows 10+, a 2 GHz dual-core CPU (Snapdragon X in beta), DirectX 11 GPU, 4 GB RAM. | **[Official]** |
| Network test | Built into the app: Settings → Server Location: Auto → **TEST NETWORK**. NVIDIA says generic speed tests "do not evaluate your internet connection to a GeForce NOW server". | NVIDIA KB 5224 **[Official]** |
| Regions | Run directly by NVIDIA in the US, Canada, Europe, Japan, India and others. **Alliance partners** run it in Korea, Taiwan, Turkey, Australia and New Zealand, Latin America (ABYA, Digevo), Malaysia, South Africa, Thailand, and Armenia and the CIS. | NVIDIA KB **[Official]** |

**Estimated data use** (Mbps × 0.45, upper bounds): 720p60 up to about 6.8 GB/h; 1080p60 up to about 11 GB/h; 1440p120 up to about 16 GB/h; 4K120 up to about 20 GB/h. Secondary sources measure about 7 GB/h at 1080p60 and 18–22 GB/h at 4K.

### 3.4 Status

`https://status.geforcenow.com/api/v2/status.json` and `/summary.json` **[Verified]** work.

- This is Atlassian Statuspage, whose public JSON API is documented for every hosted status page. **Allowed.**
- It returned 113 components, named like `NP-LON-06 [RTX 5080]` and `Northern California (USA) [RTX 5080]`, plus "Cloud Storage". Active incidents carry game-specific notes.
- Use it for a "GeForce NOW: All systems operational" chip and for per-region incident banners. Alliance-partner regions have their own status pages.

### 3.5 Session detection (read-only)

- **Desktop app:**
  - Watch for `GeForceNOWStreamer.exe` to start and stop. It probably runs only while a stream is active **[Unverified]**.
  - Fall back to `GeForceNOW.exe`. Playnite polls `GeForceNOW` every 15 s and notes that *"GeForce NOW leaves leftover processes when closed"*. Don't use "GeForceNOW.exe exited" alone as the end-of-session signal.
  - Combine process presence with window foreground and title via `EnumWindows`, plus a grace period.
- **Edge `--app` with a VYSTRAL-only profile:** the same approach as for Xbox.

### 3.6 Terms of service notes

GeForce NOW Terms of Use (last updated 2025-08-18) **[Official]**:

- *"You may not reverse engineer, decompile, disassemble, modify, create derivative works … from any portion of GFN."*
- *"You may not misuse, disrupt or exploit GFN or NVIDIA servers for any unauthorized use, or try to access areas or download software not intended for users."*
- *"You may not use GFN to violate a game's terms of service or other unauthorized activity, such as cheating, exploiting, duping or botting."*
- *"You may not copy, sell, rent, sublicense, transfer or distribute any portion of GFN."*

Reading of these clauses:

- Deep links are explicitly invited for aggregators.
- The public games list is used by NVIDIA's own public page.
- Re-hosting the web client, or unofficial clients such as OpenNOW (PCWorld, 2026-04-08, "while you can"), are a different matter. VYSTRAL must stay with launching.

---

## 4. Embedding comparison

VYSTRAL's UI WebView2 is locked down, and this is the starting point:

- It allows only `https://{AppHost}` and the art host, and cancels every other navigation and frame navigation.
- It sets `NewWindowRequested` as handled, cancels downloads, and **denies all permission requests**.
- Browser extensions are off and dev tools are off in release builds.
- `docs/RESEARCH.md` records that **the browser Gamepad API is unreliable in WinUI's composition-hosted WebView2** (WebView2Feedback #4968), which is why VYSTRAL reads controllers natively.

| | (a) Official desktop app via deep link | (b) User's default browser | (c) Separate WebView2 window inside VYSTRAL | (d) Edge `--app=` window |
|---|---|---|---|---|
| ToS posture | ✅ Ordinary use | ✅ Ordinary use, and GFN's deep links are designed for it | ⚠️ VYSTRAL becomes the host for the vendor's player. That's arguably an "unauthorized third-party application" (MSA). Neither vendor lists WebView2 as a supported client. | ✅ Edge is a supported browser for both services, and Microsoft itself documents Edge launch flags for xCloud on Steam Deck. |
| Sign-in | ✅ Vendor-managed | ✅ The existing browser session | ❌ Google OAuth blocks embedded webviews (`disallowed_useragent`, 2021 policy), so GFN accounts that sign in with Google would break. Microsoft accounts do work in WebView2. Credentials are typed into a VYSTRAL-owned surface, and password managers and extensions are missing. | ✅ A real Edge profile, so Google, Microsoft and passkeys all work |
| Controller and mouse capture | ✅ Native | ✅ Gamepad and Pointer Lock work | ❌ The WinUI WebView2 control uses composition hosting, where Gamepad and Pointer Lock break (#4968, VYSTRAL's own finding). It would need a separate Win32 HWND-hosted controller, which is significant work. | ✅ A full browser |
| WebRTC, DRM, codecs | ✅ | ✅ | ⚠️ WebRTC and H.264 work in WebView2. **No DRM is needed:** both services stream over WebRTC, not EME. AV1 or HEVC hardware decoding and HDR would need checking per runtime **[Unverified]**. | ✅ |
| Security for VYSTRAL | ✅ No change | ✅ No change | ❌ The origin lock would need opening up for vendor sites, permissions (pointer lock, fullscreen, keyboard lock, autoplay) would need granting, and the risk grows if VYSTRAL ever loads attacker-controlled content in the same environment. It needs a separate environment and profile, and VYSTRAL would effectively be shipping a browser. | ✅ No change. The Edge profile folder is never read by VYSTRAL. |
| Session tracking | ⚠️ Process and window heuristics | ❌ Hard: tabs in an existing browser | ✅ Exact (navigation events), but at the costs above | ✅ Good, if a VYSTRAL-only `--user-data-dir` gives a separate process tree. ⚠️ Without it, Edge hands the window to the running browser and the launcher process exits at once. |
| Controller-first (Immersive) feel | ✅ Fullscreen app | ⚠️ Browser chrome and tabs | ✅ | ✅ A chromeless window; the vendor page can go fullscreen |
| Effort | Low | Lowest | High | Low |

**Recommendation: (a) when the vendor app is installed; otherwise (d), with (b) as a user setting. Never (c).**

- For (d), launch `msedge.exe --app="{officialUrl}" --user-data-dir="%LOCALAPPDATA%\VYSTRAL\cloud-edge" --no-first-run`. The user signs in once, inside Edge.
  - Be open about it in the UI, for example: "Cloud games open in a separate Microsoft Edge window. VYSTRAL never reads it."
  - Leave this folder out of VYSTRAL backups and diagnostic bundles.
  - Offer "Use my normal browser instead" for people who prefer their existing sign-ins.
- If Edge is missing, which is rare on Windows 11, fall back to (b).
- Don't use `--kiosk`. On Windows it runs InPrivate, so sign-in would never persist.
- The `--app` and `--user-data-dir` switches are standard Chromium switches. Microsoft doesn't formally document them as stable. **[Unverified]** current behaviour on Edge 140+.

---

## 5. Ways VYSTRAL can do better than the services alone

Each idea lists the data it needs and how feasible it is. "Local" means no network call.

1. **"Play on" selector per game: Installed (Steam) · Xbox Cloud · GeForce NOW.** Data: adapters plus the SIGL list and GFN list. **High.**
2. **Cloud badges on library tiles and in Immersive mode** ("☁ Xbox", "☁ GFN", "Install-to-Play"). Data: catalogues. **High.**
3. **"Play now without installing".** When a game is still downloading or isn't installed, offer cloud play straight away with an "install in the background" note. Data: catalogues plus install state. **High.**
4. **Smart default route.** Pick cloud or local based on a cached hardware score (when the local GPU is below the game's needs), battery state (on battery, cloud saves power), disk space, and the network check. Always explain why and let the user override. Data: local Performance view plus the catalogues. **Medium.**
5. **Pre-launch readiness check** (a 2-second sheet before launching). Data: Windows APIs only. **High.** It checks:
   - Ethernet or Wi-Fi: `ConnectionProfile.IsWlanConnectionProfile`, `NetworkAdapter.IanaInterfaceType` (6 = Ethernet, 71 = Wi-Fi)
   - Wi-Fi signal: `ConnectionProfile.GetSignalBars()`
   - Link speed: `NetworkAdapter.InboundMaxBitsPerSecond`
   - Metered or capped connection: `GetConnectionCost()`, giving `NetworkCostType`, `ApproachingDataLimit`, `OverDataLimit` and `Roaming`
   - Data plan: `GetDataPlanStatus()`
   - VPN active: an adapter-type heuristic
   - Local jitter and packet loss: 20 ICMP pings to the **default gateway** (`System.Net.NetworkInformation.Ping`). This is local only and no third party is contacted.
   - Wi-Fi band (2.4 or 5 GHz) needs `WlanQueryInterface`, which **on Windows 11 24H2+ needs location consent**. Make it optional. `WlanConnectionProfileDetails.GetConnectedSsid()` does not prompt.
6. **"Open official network test" button.** For GFN, open the app's Settings (or tell the user where TEST NETWORK is). For Xbox, link to the official troubleshooter. VYSTRAL shouldn't build its own WAN latency test against vendor servers. Optional M-Lab ndt7 test: see Risks. **High.**
7. **Data usage estimator.** "About 9 GB per hour at 20 Mbps; this session used about 6.1 GB (estimated)". Derived from the vendor bitrate tables multiplied by measured session time. Show a warning on metered connections. **High.**
8. **Hour-budget tracker.** Shows something like "Xbox: 9.5 of 15 h used this cycle" or "GFN: 62 of 100 h (+ rollover)". The user sets their plan and billing day. The count covers **only sessions started from VYSTRAL** and is labelled as an estimate, not the vendor's balance. Warn at 80% and 100%. Data: local sessions. **High.** This matters a lot given the new caps.
9. **Session length guard.** Shows "Free tier: session ends at 1 h, 10 minutes left" as a Windows toast or Game Bar-style overlay notification. Uses local timers and the tier the user picked. **High.** The toast must not draw over the stream in a way that steals focus.
10. **Service status chip** on every cloud action and in the Cloud hub. For GFN it can show per-region incidents. Data: Statuspage (allowed) and xnotify (grey). **High.**
11. **Queue-aware tips.** Before a GFN launch on the Free tier, show "Free tier often has queues; peak hours are…". VYSTRAL can't read live queue positions without private APIs, and it **won't claim** to. It can show the user's own history of measured time from launch to stream, which VYSTRAL records locally. **Medium.**
12. **Cloud journal.** Sessions appear in VYSTRAL's Journal with service, duration, estimated GB and the network quality recorded at launch. Results are compared over time ("your Wi-Fi sessions had 3× more gateway jitter"). Data: local. **High.**
13. **Controller-first Immersive launch.** Press A to pick the route and VYSTRAL starts the Edge app window or the vendor app fullscreen. While a cloud session is active, VYSTRAL's `GamepadBridge` **stops listening**, so it doesn't steal input or react to the Guide button. Data: local. **High.**
14. **Edition and region guidance.** "Not available in your region" comes from SIGL market or GFN country results. A "Your Steam copy works on GFN, but your Epic copy isn't supported" note comes from variant matching. **High.**
15. **"Cloud-only" library shelf.** Shows Game Pass cloud titles and GFN READY_TO_PLAY titles the user owns on linked stores but hasn't installed. Ownership comes only from local data VYSTRAL already has (installed or known games). It never signs in to stores. **Medium.**
16. **Input hints.** Mouse and keyboard support (displaycatalog `ConsoleKeyboardMouse`) and "controller recommended". **High (Xbox)**, **Low (GFN, no field)**.
17. **Resolution and bandwidth advisor.** Example: "Your link sustains about 40 Mbps and your display is 2560×1440 at 165 Hz, so choose GFN 1440p120 (Ultimate) in GFN's settings". VYSTRAL can't set the vendor's stream settings, so it advises only. Data: vendor tables, display info and the readiness check. **High.**
18. **Windows tuning hints.** Turn Game Mode on, unplug from battery saver, close bandwidth-heavy apps such as active OneDrive or Steam downloads during a session (VYSTRAL can **pause its own** downloads and update checks). **High.**
19. **Ad-tier awareness.** If the user's tier is "GFN Free" or "Xbox free (ads)", add the expected pre-roll time to launch-time estimates and suggest a tier upgrade only once. Never show ads itself. **High.**
20. **Notifications for catalogue changes.** For example: "3 games in your wishlist are now cloud playable" or "Leaving Game Pass soon" (SIGL `cc7fc951-…`). Data: daily catalogue diff, opt-in. **Medium.**
21. **Deep-link share card.** Copy an official link (xbox.com or the GFN deep link) for a friend. **High.**
22. **Hybrid save-sync warning.** "Cloud saves only" for xCloud, and a "GFN syncs saves via the store; local mods won't carry over" note. Data: static vendor facts. **High.**

---

## 6. Proposed data model and UX sketch

### 6.1 Data model (additions; illustrative, not code)

```text
CloudService        enum { XboxCloud, GeForceNow }

CloudCatalogEntry   (cached table, per service per market/country)
  Service, ServiceGameId          // xbox: StoreProductId; gfn: id (uuid)
  LaunchKey                       // xbox: StoreProductId; gfn: cmsId
  Title, SortTitle, Images{Poster,Hero,Logo,BoxArt}
  StoreLinks[]  { Store: Steam|Epic|Xbox|Ubisoft|BattleNet|EA|Gog, StoreId }
  PlayType      ReadyToPlay | InstallToPlay | ByogOwnedOnly | Unknown
  IncludedIn[]  e.g. GPU, GPP, GPE (xbox tiers) | MinTier (gfn)
  InputHints    { KeyboardMouse?: bool, Touch?: bool }
  Market, FetchedAt, SourceEtag

CloudAvailability   (join result, recomputed on scan or refresh)
  LibraryGameId -> [ { Service, CatalogEntryId, MatchedBy: StoreId|PackageFamilyName|TitleFuzzy,
                       Confidence 0..1 } ]

CloudPreferences    (local settings)
  Enabled: { Xbox: bool, Gfn: bool }       // opt-in, default off
  LaunchSurface: VendorApp | EdgeApp | DefaultBrowser
  Plan: { Xbox: None|Essential|Premium|Ultimate|FreeAds, Gfn: Free|Performance|Ultimate|Founders|DayPass }
  BillingDay, HourBudgetOverride, Market/Country

CloudSession        (Journal)
  Id, LibraryGameId, Service, Surface, StartedAt, EndedAt, DetectedBy (process|window|manual)
  NetworkAtLaunch { Kind: Ethernet|WiFi|Cellular, SignalBars, LinkMbps, Metered, GatewayRttMs, JitterMs, LossPct }
  EstimatedGB (= duration × assumed Mbps × 0.45)
```

Matching rules:

- Exact store ID first: Steam appid, Xbox ProductId to PackageFamilyName (via displaycatalog), then Epic and Ubisoft.
- Fuzzy title matching only as a suggestion, which the user confirms. This uses the same "Review possible duplicate" pattern the Library already has.
- Never auto-merge on fuzzy titles.

### 6.2 UX sketch

```text
┌ Game page: Forza Horizon 5 ─────────────────────────────────────────────┐
│  [ ▶ Play ]  Play on:  ● Installed · Xbox app   ○ Xbox Cloud   ○ GeForce NOW │
│                         62 GB on D:              ☁ Included:     ☁ Steam copy │
│                                                  Ultimate         Ready to play│
│  Cloud readiness  ● Ethernet 940 Mbps · gateway jitter 1 ms · unmetered     │
│  Xbox Cloud: ~9 GB/h · 6.5 of 15 h used this cycle (VYSTRAL-tracked)        │
│  Status: Xbox ✓ Operational · GeForce NOW ✓ Operational                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Library:** small cloud glyphs on tiles, and filters for "Cloud playable", "Not installed but streamable" and "Install-to-Play".
- **Immersive mode:** the hero card shows a route carousel (LB/RB switches route). A press triggers a 1.5 s readiness sweep, then launch. VYSTRAL fades to a "Streaming in Edge · press the Guide button to return" state and suspends its WebView, as it already does for local games.
- **Launching from the Command bar:** `Play Halo in the cloud`.
- **The first cloud launch** shows a one-time sheet explaining what VYSTRAL does and doesn't do: no sign-in through VYSTRAL, no tokens, and a separate Edge window.

---

## 7. Risks and open questions

1. **Undocumented catalogue endpoints can change or disappear.** It has already happened: `gfnpc.json` now returns `null`. Design for failure: keep the last good cache, show "cloud data may be out of date", and keep the feature switchable per service. Consider writing to `gdp-queries@nvidia.com` to register as an aggregator and ask for a supported catalogue feed.
2. **Hour caps and tiers are moving quickly** (Xbox caps from November 2026, regional exemptions, a free ad-supported test; GFN's 100 h rule). Keep plan rules in a small versioned JSON file in the repo, with dates and source URLs. Never hard-code "unlimited".
3. **VYSTRAL's hour counts aren't the vendor's balance.** Sessions on phones, TVs and other devices aren't seen. Always label them "tracked by VYSTRAL".
4. **Entitlement is unknown** without signing in. Keep the wording conservative ("may be included") and let the vendor page decide. The 1000xRESIST footnote anomaly shows that SIGL inclusion isn't the final word.
5. **The GFN `--url-route` argument is undocumented.** NVIDIA could change it in an app update. Detect launch failure (the app opens but no streamer process starts within N seconds) and fall back to the documented web deep link.
6. **Session detection heuristics:** stray GFN processes; the Xbox app streams inside its own window; Edge's process model with `--user-data-dir`. All of these must be tested on real hardware. Provide a manual "I'm done" button and an idle prompt.
7. **The Edge `--app` and `--user-data-dir` switches aren't formally documented by Microsoft.** Enterprise policies can block them. Fall back to the default browser.
8. **Optional internet latency test:** M-Lab ndt7 is open and documented, but M-Lab **publishes the client IP in its open data**, so it needs explicit informed consent, and it measures the path to M-Lab, not to Xbox or NVIDIA. NVIDIA explicitly says generic speed tests don't reflect GFN quality. Recommendation: don't ship it by default. Local gateway jitter plus the vendors' own tests are enough.
9. **Location consent for Wi-Fi band on 24H2+.** Make it optional and explain the prompt.
10. **Controller conflicts:** VYSTRAL's native `GamepadBridge` must release or ignore input while a cloud window has focus. This needs testing with Edge and the Xbox app.
11. **Legal:** the meaning of "impermissible scraping" (MSA) and NVIDIA's silence on catalogue reuse. Mitigate with low-rate opt-in fetching, attribution ("Catalogue data from Microsoft and NVIDIA public pages"), no redistribution of cached data, and a commitment to remove the feature on request. Don't use vendor logos beyond what their brand guidelines allow. Prefer text names ("Xbox Cloud Gaming", "GeForce NOW") and generic cloud glyphs.
12. **Open questions:**
    - Does `/play/launch/{slug}/{id}` start the stream immediately when signed in?
    - Is there an official Xbox app URI that triggers "Stream"?
    - Which Epic ID is GFN's `storeId`?
    - Does `GeForceNOWStreamer.exe` live exactly as long as a session?
    - Will Xbox publish a cloud catalogue API alongside purchasable cloud hours?
    - What is the current status of BYOG on the PC app outside Insiders?

---

## 8. Sources

**Microsoft / Xbox**
- Xbox Wire, "Upcoming Changes to XBOX Cloud Gaming" (2026-09-03): https://news.xbox.com/en-us/2026/09/03/xbox-cloud-gaming-changes/
- Xbox Cloud Gaming page (plans, hours, requirements): https://www.xbox.com/en-US/cloud-gaming
- Xbox Wire, "Getting Started with Xbox Cloud Gaming" (2025-12-19): https://news.xbox.com/en-us/2025/12/19/getting-started-with-xbox-cloud-gaming/
- Xbox Wire, February 2026 update (1440p streaming): https://news.xbox.com/en-us/2026/02/25/february-xbox-update-1440p-streaming-rog-xbox-ally-updates-and-more/
- Xbox Wire, Stream your own game on the PC app (2025-07-15): https://news.xbox.com/en-us/2025/07/15/xbox-insiders-with-game-pass-ultimate-stream-your-own-game-on-the-xbox-pc-app/
- Microsoft Learn, PlayFab Economy v2 deep links (`msxbox://game/?productId={id}`): https://learn.microsoft.com/en-us/gaming/playfab/features/economy-v2/catalog/deep-links
- Microsoft Support, Xbox Cloud Gaming in Edge on Steam Deck (Edge `--kiosk` launch options): https://support.microsoft.com/en-us/topic/xbox-cloud-gaming-in-microsoft-edge-with-steam-deck-43dd011b-0ce8-4810-8302-965be6d53296
- Microsoft Services Agreement (effective 2026-09-30): https://www.microsoft.com/en-us/servicesagreement
- Xbox status page: https://support.xbox.com/en-US/xbox-live-status · feed: https://xnotify.xboxlive.com/servicestatusv6/US/en-US
- Game Pass SIGL endpoint: https://catalog.gamepass.com/sigls/v2?id=29a81209-df6f-41fd-a528-2ae6b91f719c&market=US&language=en-US
- Subscriptions endpoint: https://catalog.gamepass.com/subscriptions?subscription=all&market=US
- Display catalogue: https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=9NPDN9R45JX4&market=US&languages=en-us
- SIGL ID list (from xbox.com's xgpcatPopulate-MWF2.js): https://github.com/itimurcom/gamepass/blob/main/xbox_sigl_ids.md
- MSAL.NET and WebView2: https://learn.microsoft.com/en-us/entra/msal/dotnet/advanced/webview2
- Native Wifi API permissions and location changes: https://learn.microsoft.com/en-us/windows/win32/nativewifi/wi-fi-access-location-changes
- WebView2Feedback #4968 (Gamepad and Pointer Lock break in visual hosting): https://github.com/MicrosoftEdge/WebView2Feedback/issues/4968
- WebView2Feedback #4960 (fullscreen and pointer-lock prompts): https://github.com/MicrosoftEdge/WebView2Feedback/issues/4960

**NVIDIA / GeForce NOW**
- GFN SDK repo: https://github.com/NVIDIAGameWorks/GeForceNOW-SDK · Deep linking: https://github.com/NVIDIAGameWorks/GeForceNOW-SDK/blob/master/doc/GfnSdk-Deep-Linking.md · SDK EULA: https://github.com/NVIDIAGameWorks/GeForceNOW-SDK/blob/master/LICENSE
- GFN developer portal: https://developer.geforcenow.com/
- System requirements: https://www.nvidia.com/en-us/geforce-now/system-reqs/
- FAQ (100 h, rollover, tiers): https://www.nvidia.com/en-us/geforce-now/faq/
- Memberships: https://www.nvidia.com/en-us/geforce-now/memberships/
- Network test KB: https://nvidia.custhelp.com/app/answers/detail/a_id/5224/~/how-do-i-test-my-network-for-geforce-now
- Install-to-Play KB: https://nvidia.custhelp.com/app/answers/detail/a_id/5675/~/geforce-now-install-to-play-overview
- Supported locations KB: https://nvidia.custhelp.com/app/answers/detail/a_id/5023/~/what-are-the-supported-locations-for-geforce-now
- Terms of Use (2025-08-18): https://www.nvidia.com/en-us/geforce-now/terms-of-use/
- Status page API: https://status.geforcenow.com/api/v2/summary.json
- Games list GraphQL (used by nvidia.com/en-us/geforce-now/games/): https://api-prod.nvidia.com/services/gfngames/v1/gameList
- Legacy list (now `null`): https://static.nvidiagrid.net/supported-public-game-list/gfnpc.json
- NVIDIA forum, "JSON list of GFN games": https://www.nvidia.com/en-us/geforce/forums/gfn-general-chat/20/497665/json-list-of-gfn-games/3268699/
- @NVIDIAGFN, desktop shortcuts: https://x.com/NVIDIAGFN/status/1014920120265654272
- 9to5Google on the 100-hour limit: https://9to5google.com/2025/12/23/nvidia-geforce-now-100-hour-limit-2026/

**Prior art and community**
- Playnite GFN controller (`--url-route` arguments, process polling): https://github.com/darklinkpower/PlayniteExtensionsCollection/blob/master/source/Library/NVIDIAGeForceNowLibrary/NVIDIAGeForceNowEnablerController.cs
- Playnite GFN Enabler wiki: https://github.com/darklinkpower/PlayniteExtensionsCollection/wiki/NVIDIA-GeForce-NOW-Enabler
- Playnite issue #1642 (GeForce NOW): https://github.com/JosefNemec/Playnite/issues/1642
- Playnite XCloud Library (SIGL plus `/play/launch/` URLs): https://github.com/joyrider3774/Playnite_XCloud_Library
- GOG Galaxy GFN integration: https://github.com/bertbert72/galaxy-integration-geforcenow
- GFNOW-SYNC (Steam shortcuts; reads GFN's CacheStorage, which is not acceptable for VYSTRAL): https://github.com/supernebuleux/GFNOW-SYNC
- OpenNOW (unofficial GFN client): https://github.com/OpenCloudGaming/OpenNOW · PCWorld (2026-04-08): https://www.pcworld.com/article/3109606/try-out-an-open-source-app-to-access-geforce-now-while-you-can.html
- gfn-electron (wrapper with a quality override): https://github.com/hmlendea/geforcenow-electron
- Better xCloud (userscript): https://better-xcloud.github.io/
- Greenlight / XStreaming (unofficial xCloud clients): https://github.com/unknownskl/greenlight · https://github.com/Geocld/XStreaming
- Electron xCloud wrapper: https://github.com/pjburnhill/xbox-cloud-gaming-wrapper
- Google, embedded-webview OAuth block: https://developers.googleblog.com/upcoming-security-changes-to-googles-oauth-20-authorization-endpoint-in-embedded-webviews/
- M-Lab developer policy (consent before IP collection): https://www.measurementlab.net/develop/

**Secondary press** (used only where marked)
- VGC on regional exemptions from the Xbox cap: https://www.videogameschronicle.com/news/xbox-tells-existing-game-pass-members-its-new-cloud-gaming-cap-doesnt-apply-to-them-but-only-in-certain-countries/
- Game Informer on Xbox hour limits: https://gameinformer.com/2026/09/03/xbox-announces-monthly-hour-limits-to-cloud-gaming-are-coming-in-november
- Windows Central on BYOG in the PC app: https://www.windowscentral.com/gaming/xbox/xbox-cloud-gaming-stream-your-own-game-pc-app-insiders
- Stevivor on the free ad-supported Xbox cloud tier: https://stevivor.com/news/free-ad-supported-xbox-cloud-gaming-looks-to-be-coming-in-2026/
