<p align="center">
  <img src="assets/brand/png/vystral-128.png" width="96" alt="VYSTRAL logo" />
</p>

<h1 align="center">VYSTRAL</h1>
<p align="center"><strong>Your Universe of Play.</strong><br/>One beautiful, private home for every PC game you own — Steam, Xbox &amp; PC Game Pass, Epic, GOG, EA, Ubisoft and Battle.net.</p>

<p align="center">
  <a href="https://github.com/Arnav-Dugad/vystral/releases/latest/download/Vystral-win-Setup.exe"><strong>⬇ Download VYSTRAL for Windows</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Arnav-Dugad/vystral/releases/latest">All downloads &amp; release notes</a>
</p>

---

## Install (for friends)

1. Click **[Download VYSTRAL for Windows](https://github.com/Arnav-Dugad/vystral/releases/latest/download/Vystral-win-Setup.exe)** — that link always points to the newest version.
2. Run `Vystral-win-Setup.exe`. It installs just for you (no administrator rights) and adds Desktop and Start-menu shortcuts.
3. **Windows SmartScreen may warn** that the app is from an unknown publisher, because VYSTRAL isn’t code-signed yet (signing certificates cost money). Click **More info → Run anyway**. The installer only comes from this repository’s Releases page — never download it anywhere else.
4. VYSTRAL finds your installed games automatically. Nothing to sign in to.

**Updates are automatic.** VYSTRAL checks GitHub shortly after it starts, shows the download with a live progress viewer (Settings → Updates, or the pill in the title bar), and installs when you restart. You can turn this off.

**Requirements:** Windows 10 21H2+ or Windows 11, x64. The WebView2 runtime (built into Windows 11) is installed automatically if missing. Uninstall from *Settings → Apps*; your library data in `%LOCALAPPDATA%\VYSTRAL.Data` is kept unless you delete that folder.

> Prefer a portable copy? Download `Vystral-win-Portable.zip` from the release page. The portable copy doesn’t auto-update.

## What it does

| | |
|---|---|
| **Every store, one library** | Reads Steam, Xbox/Game Pass, Epic, GOG, EA app, Ubisoft Connect and Battle.net installs directly from what those apps keep on your PC — no passwords, no sign-in. Add any other game or program yourself. |
| **Launches the right way** | Each game starts through its store’s official mechanism (or directly for DRM-free GOG/manual games). VYSTRAL confirms the game actually started before it says so, and never relaunches anything on its own. |
| **Smart duplicates** | Own a game on two stores? It appears once, with a chooser for which store to play from. Different editions and remasters are never merged automatically — you decide. |
| **Living Canvas** | A calm animated background that takes on each game’s colours and mood (light trails for racing, stars for space, fog for horror…). It pauses whenever you’re playing. |
| **Live Home** | Steam games’ tiles come alive with their short, silent store loops while on screen (two at a time, never on Data saver); an *Owned, never played* gallery with gentle picks for tonight; optional ambient sound that follows each game’s mood. |
| **Command bar** (`Ctrl+K`) | “installed racing games under 20 GB”, “launch forza”, “not played in 3 months”, “everything on my second SSD” — understood instantly, on your PC, without AI. |
| **Immersive Mode** (`F11` / Menu button) | A separate full-screen, controller-first layout for TVs and couch gaming, with one gliding focus ring and an attract-mode slideshow when idle. |
| **Performance Mode** | When a game starts, VYSTRAL minimizes and suspends its interface: **0% CPU** while minimized in our measurements. |
| **Journal & Performance** | Private play history, playtime charts, milestones, game status (Backlog → Completed) and per-session CPU/GPU/temperature graphs. Optional real FPS, 1% lows and stutters via Intel PresentMon. Nothing is estimated or faked. |
| **Launches that explain themselves** | A pre-flight card (disk space, pending updates, controller battery, HDR), a progress arc that learns how long each game takes, one-click fixes when something fails, and GPU heat alerts afterwards. |
| **Storage Studio** | A map of each drive showing which games take the space, with gentle suggestions. VYSTRAL never deletes: uninstalling happens in the store. |
| **Play calendar & achievements** | A year of play day by day with streaks, every Steam achievement on one timeline (rare ones highlighted), achievement toasts after a session, and frame rates before vs after a driver update. |
| **Controller-first** | Gentle haptics, an on-screen keyboard with library suggestions, and hold-to-confirm for anything you can't undo. |
| **Steam extras** | Live install progress and trailers; with your own Steam Web API key (kept in Windows Credential Manager), games you own but haven’t installed and achievements with rarity. |
| **Windows integration** | A summon shortcut (`Ctrl+Alt+V`), Windows notifications, a notification centre and a now-playing chip. |
| **Moments** | Your Steam screenshots and Xbox Game Bar captures in one gallery. Nothing is uploaded. |
| **Constellation** | An optional 3D map of your library, with an accessible list view. |
| **Local AI (optional)** | Natural-language search and an assistant powered by [Ollama](https://ollama.com) on your own PC. Never required, never in the cloud. |

## Promises

- **Your games are untouched.** VYSTRAL never modifies game files, never injects into game processes, never touches DRM or anti-cheat, and never changes hardware settings. If you uninstall VYSTRAL, every game still works from its own store.
- **Private by default.** No account, no telemetry, no ads. Network access is limited to optional game details/artwork from Steam’s public store pages and update checks on GitHub — both can be switched off (Settings → Privacy → Offline mode).
- **Free.** No subscription, no paid APIs.

## For developers

```powershell
# prerequisites: .NET 10 SDK, Node 24+
cd ui; npm ci; npm run build; cd ..
dotnet build src/Vystral.App -c Debug
dotnet test tests/Vystral.Tests
src\Vystral.App\bin\x64\Debug\net10.0-windows10.0.22621.0\win-x64\Vystral.exe
```

UI-only development with sample data: `cd ui && npm run dev` (a **Preview · sample data** badge marks it).

| Doc | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | How the native shell, bridge, services and UI fit together, and why |
| [Integration capability matrix](docs/INTEGRATIONS.md) | Exactly what each store integration can and can’t do |
| [Design system](docs/DESIGN-SYSTEM.md) | Tokens, motion language, components, accessibility rules |
| [Product requirements](docs/PRODUCT.md) · [Progress](docs/PROGRESS.md) · [Known limitations](docs/KNOWN-LIMITATIONS.md) | Scope and honest status |
| [Security threat model](docs/THREAT-MODEL.md) · [Privacy](docs/PRIVACY.md) | Trust boundaries and data handling |
| [Testing](docs/TESTING.md) · [Performance](docs/PERFORMANCE.md) | How it’s verified, with measured numbers |
| [Development](docs/DEVELOPMENT.md) · [Releasing](docs/RELEASING.md) · [Install](docs/INSTALL.md) | Build, ship, install |
| [Research](docs/RESEARCH.md) · [Changelog](CHANGELOG.md) | Background research and history |

## License

MIT — see [LICENSE](LICENSE). Third-party components are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Game names, artwork and descriptions belong to their respective owners; VYSTRAL is not affiliated with Valve, Microsoft, Epic Games, GOG, Electronic Arts, Ubisoft or Blizzard. Store names and logos are trademarks of their owners, used only to identify the store.
