# Releasing

Releases are built by GitHub Actions from version tags and published as GitHub Releases. The in-app updater (Velopack) reads those releases, and the README's download link always points at the newest installer:

`https://github.com/Arnav-Dugad/vystral/releases/latest/download/Vystral-win-Setup.exe`

## Cutting a release

1. Update `CHANGELOG.md` with a `## [x.y.z] — YYYY-MM-DD` section. Its text becomes the in-app "What's new".
2. Commit, then tag and push:
   ```powershell
   git tag v0.2.0
   git push origin main --tags
   ```
3. `.github/workflows/release.yml` then:
   - runs the .NET tests
   - builds the UI and publishes the self-contained app
   - downloads the previous release (to generate a **delta** update)
   - runs `vpk pack`
   - uploads everything to a published GitHub Release named `VYSTRAL 0.2.0`

Every installed copy with automatic checks on sees the update within a session, shows it in the update viewer, and installs it on restart.

## "What's new" and "New" badges

After an update, VYSTRAL shows a short tour of the new version once (never on a fresh install, never in Immersive Mode, where it waits for the next desktop session). It's also under Settings → About and in the update centre ("See what's new").

- **Default source: `CHANGELOG.md`.** At UI build time a Vite plugin parses the newest sections into `virtual:vystral-changelog`. Items written as `- **Bold lead.** Text` in sections other than *Fixed*, *Known issue*, *Research* or *Note…* become cards (up to five), so a fixes-only release shows no tour. Keep the existing format: `## [x.y.z] — YYYY-MM-DD`, `### Section`, bullets.
- **Curated tour (recommended for feature releases):** `ui/src/whatsnew/versions/<x.y.z>.ts` exporting `tour` with 3–6 cards: `key`, `eyebrow`, `title`, `body` (one or two sentences), optional `icon` and `hue`, and an optional deep link `action: { label, to: { name: 'settings', section: 'privacy' } | 'updates' }`. A curated tour wins over the changelog for that version; a patch release without its own tour shows nothing new to people already on that minor version.
- **"New" badges:** add `{ key, since: 'x.y.z', seenOn? }` to `NEW_FEATURES` in `ui/src/whatsnew/badges.ts` and put `<NewBadge k="key" />` next to the feature (`variant="pill" seenWhenVisible` for settings rows and buttons). `nav.<route>` keys light the sidebar item automatically; `settings.<section>.<row>` keys light the Settings section. Badges disappear once seen (visiting the page, or being on screen for a moment) and on their own two feature releases later (0.4.x badges end with 0.6.0). Keys: lowercase, dots and hyphens, at most 64 characters (the native side rejects anything else).

## Silent rollback

If a newly installed version fails to start twice in a row (it never reached "interface ready + 20 s"), its third start returns to the previous version, shows "VYSTRAL x didn't start correctly, so you're back on y. It will try again with the next update.", and skips that exact version in automatic updates. Shipping a fixed **higher** version is the way out: never re-publish the same version number. Details: [ARCHITECTURE.md](ARCHITECTURE.md#key-decisions) ("Silent rollback"), state in `%LOCALAPPDATA%\VYSTRAL.Data\update\` (`startup.json`, `rollback/`), log area `rollback`.

To test a release candidate's rollback by hand: install version N, update to N+1 built to crash at start (for example `throw` in `App.OnLaunched` behind an environment variable), start it three times, and check that N comes back with the notice and that "Check for updates" says N+1 is skipped.

## Release assets

| File | Purpose |
|---|---|
| `Vystral-win-Setup.exe` | Per-user installer (no admin; installs WebView2 if missing; Desktop and Start-menu shortcuts) |
| `Vystral-win-Portable.zip` | Portable copy (no auto-update) |
| `Vystral-<ver>-full.nupkg` | Full update package |
| `Vystral-<ver>-delta.nupkg` | Delta from the previous version (small downloads) |
| `releases.win.json`, `RELEASES` | Update feed |

## Building a release locally

```powershell
dotnet tool install -g vpk --version 1.2.161
./build/pack.ps1 -Version 0.2.0                     # full package only
./build/pack.ps1 -Version 0.2.0 -DownloadPrevious   # plus delta against the latest GitHub release
vpk upload github --repoUrl https://github.com/Arnav-Dugad/vystral --token <PAT> --publish --merge --releaseName "VYSTRAL 0.2.0" --tag v0.2.0 -o Releases
```

## Versioning

SemVer. Velopack compares versions to decide what is newer, so never reuse or lower a version. Pre-releases (`0.3.0-beta.1`) are only offered to installs built with prerelease updates enabled (not the default).

## Signing (not yet enabled)

`build/pack.ps1` is ready for `vpk pack --signParams "/fd sha256 /tr http://timestamp.digicert.com /td sha256 /f cert.pfx /p ..."` or `--azureTrustedSignFile metadata.json`. Until a certificate is configured, SmartScreen shows a warning on first run; see [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md). Never commit certificates or tokens.
