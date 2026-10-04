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
