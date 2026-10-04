# Research summary (October 2026)

Before building, four research tracks were run. Their conclusions shaped the product; this is the condensed record.

## 1. What makes launchers great, and what users hate

**Context.** The Xbox PC app now aggregates installed games from Steam, Epic, GOG, EA, Ubisoft and Battle.net without account linking, so basic aggregation is table stakes. Steam's Big Picture beta (Sept 2026) added "Big Art Mode", an attract-mode screensaver and a calendar. Playnite 10.x remains the power-user benchmark. GOG Galaxy's community integrations are largely unmaintained.

**Loved, and adopted:**
- installed-game discovery with no login
- an instant, cache-first start
- excellent artwork with sensible fallbacks
- "Continue playing"
- a unified playtime view
- filters, collections and a command palette
- desktop and full-screen modes sharing one data store
- duplicate merging with a store chooser
- pinned favourites
- per-game launch options
- adding any program
- a hero view that follows focus
- a stats dashboard
- a "surprise me" pick
- clean return after a game

**Hated, and avoided:**
- network calls on the UI path
- ads on Home
- unmaintained integrations
- low-resolution or missing art
- **controller focus that disappears or resets**
- "browsing a web page with a controller"
- focus not restored after a game
- freezing on big libraries
- stale manifests
- busywork cards
- janky animation
- background bloat
- weak non-Steam support

**Original ideas considered.** Several shipped:
- Library Radar
- the deterministic "Picked from your library"
- tracked-vs-store transparency
- an honest launch overlay
- Performance Mode suspension
- the Pulse window

Others are on the roadmap: "what changed since you last played" patch notes, a save-backup vault (Ludusavi manifest), per-game display and audio profiles, and phone-as-keyboard pairing.

## 2. Store integrations

Verified against Playnite's source (the PlayniteExtensions repo, archived Sept 2026) and the real files on the development PC. Exact paths, fields and launch URIs are in [INTEGRATIONS.md](INTEGRATIONS.md).

Key findings:
- Steam manifest keys vary in casing, and `localconfig.vdf` can repeat `Playtime`.
- Steam's library cache uses content-hash subfolders.
- Newer Steam apps use hashed CDN asset names, resolved via `IStoreBrowseService/GetItems`.
- Epic has no local playtime.
- Xbox games are best identified by `MicrosoftGame.config` or `.GamingRoot`, whose format was verified locally.
- EA's encrypted client state must not be read.
- Ubisoft's registry contains stale keys.
- Session tracking must use `QueryFullProcessImageName` with limited rights, since `Process.MainModule` fails on elevated games.

## 3. Stack

| Choice | Finding |
|---|---|
| .NET 10 LTS (SDK 10.0.4xx) | .NET 11 is still RC; .NET 8 and 9 reach end of life in Nov 2026 |
| Windows App SDK 2.5.1 | Unpackaged, self-contained apps build with the plain CLI (verified with a spike before committing); `PublishTrimmed` must stay off |
| WebView2 | Use reserved `.example` virtual hosts, CSP in a `<meta>` tag, and `TrySuspendAsync` while hidden. The browser Gamepad API is unreliable in WinUI's composition-hosted WebView2 (WebView2Feedback #4968), so controllers are read natively via Windows.Gaming.Input |
| Velopack 1.2.161 | GitHub Releases source, delta packages, `-f webview2` bootstrapping, `VelopackApp.Build().Run()` first in `Main` |
| Ollama | Must be called from the host, because its default CORS rules don't allow custom origins. Recommended model `qwen3:4b` (2.5 GB, Apache-2.0) for 8 GB laptop GPUs |

## 4. Motion and visual design

- **Motion tokens** were synthesized from Fluent 2 durations and curves, Material 3 Expressive spring physics, SwiftUI spring presets and Motion's spring model. Spatial movement uses springs, opacity and colour are critically damped, and exits are faster.
- **Chromium techniques:** animate only compositor-friendly properties, keep `backdrop-filter` to a minimum, and fade pre-rendered glow layers rather than animating `box-shadow`. View Transitions can't be interrupted, so Motion springs are used for interactive transitions instead.
- **Focus design:** scale, glow ring and sheen with a light tilt; geometric spatial navigation with sticky-column memory; anchored shelves in Immersive Mode.
- **Living Canvas:** low-resolution WebGL2 domain-warped gradient with mood overlays, dithering, a 30 fps cap and pause-on-hidden.
- **Artwork theming:** k-means palette in OKLab, accent scoring, contrast-guaranteed lightness adjustment, a brand blend, and OKLCH tokens with `@property` transitions.
- **Type:** Geist, Geist Mono and Unbounded (all OFL), bundled locally.

Sources are cited in the original research notes. Key references: Playnite/PlayniteExtensions; Microsoft Learn (WebView2, Windows App SDK, GDK `MicrosoftGame.config`); Velopack docs; Ollama API docs; Motion docs; Fluent 2 tokens; Material 3 Expressive motion; Chrome developer docs on View Transitions and scroll-driven animations.
