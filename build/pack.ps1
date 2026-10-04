<#
.SYNOPSIS
  Builds a release of VYSTRAL: UI bundle -> self-contained WinUI app -> Velopack installer.

.DESCRIPTION
  Produces, in .\Releases:
    Vystral-win-Setup.exe     per-user installer (no admin), installs the WebView2 runtime if missing
    Vystral-win-Portable.zip  portable copy (no auto-update)
    Vystral-<ver>-full.nupkg  update package (+ -delta.nupkg when a previous release was downloaded)
    releases.win.json         update feed read by the in-app updater

  The same script runs locally and in GitHub Actions (.github/workflows/release.yml).

.EXAMPLE
  ./build/pack.ps1 -Version 0.1.0
  ./build/pack.ps1 -Version 0.1.1 -DownloadPrevious   # builds a delta against the latest GitHub release
#>
param(
  [Parameter(Mandatory)] [ValidatePattern('^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$')] [string] $Version,
  [switch] $DownloadPrevious,
  [string] $Repo = 'https://github.com/Arnav-Dugad/vystral',
  [string] $Token = $env:GITHUB_TOKEN
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($name) { Write-Host "`n==> $name" -ForegroundColor Cyan }

Step 'Building the interface (ui/)'
Push-Location ui
npm ci --no-audit --no-fund
if ($LASTEXITCODE) { throw 'npm ci failed' }
npm run build
if ($LASTEXITCODE) { throw 'UI build failed' }
Pop-Location

Step "Publishing VYSTRAL $Version (self-contained, win-x64)"
$publish = Join-Path $root 'artifacts\publish'
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }
dotnet publish src/Vystral.App/Vystral.App.csproj -c Release -r win-x64 --self-contained `
  -p:Platform=x64 -p:Version=$Version -p:PublishTrimmed=false -o $publish
if ($LASTEXITCODE) { throw 'dotnet publish failed' }
if (-not (Test-Path (Join-Path $publish 'wwwroot\index.html'))) { throw 'wwwroot is missing from the published app' }

$releases = Join-Path $root 'Releases'
New-Item -ItemType Directory -Force $releases | Out-Null

if ($DownloadPrevious) {
  Step 'Downloading the previous release (for delta updates)'
  $args = @('download', 'github', '--repoUrl', $Repo, '-o', $releases)
  if ($Token) { $args += @('--token', $Token) }
  vpk @args
  if ($LASTEXITCODE) { Write-Warning 'No previous release found; building a full package only.' }
}

Step 'Writing release notes'
$notes = Join-Path $root 'artifacts\release-notes.md'
$changelog = Get-Content (Join-Path $root 'CHANGELOG.md') -Raw
$pattern = "(?ms)^## \[?$([regex]::Escape($Version))\]?.*?(?=^## |\z)"
$section = [regex]::Match($changelog, $pattern).Value
if (-not $section) { $section = "## $Version`n`nSee CHANGELOG.md for details." }
Set-Content -Path $notes -Value $section.Trim() -Encoding utf8

Step 'Packing with Velopack'
vpk pack `
  --packId Vystral `
  --packVersion $Version `
  --packDir $publish `
  --mainExe Vystral.exe `
  --packTitle VYSTRAL `
  --packAuthors 'VYSTRAL contributors' `
  --icon assets/brand/vystral.ico `
  --splashImage assets/brand/installer-splash.png `
  --releaseNotes $notes `
  --framework webview2 `
  --shortcuts 'Desktop,StartMenuRoot' `
  --outputDir $releases
if ($LASTEXITCODE) { throw 'vpk pack failed' }

Step 'Done'
Get-ChildItem $releases | Format-Table Name, @{ n = 'Size (MB)'; e = { [math]::Round($_.Length / 1MB, 1) } }
