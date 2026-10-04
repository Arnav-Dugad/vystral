# Generates a software bill of materials for both halves of VYSTRAL into docs/sbom/.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'docs\sbom'
New-Item -ItemType Directory -Force $out | Out-Null
Push-Location (Join-Path $root 'ui')
npm sbom --sbom-format cyclonedx --omit dev | Out-File -Encoding utf8 (Join-Path $out 'ui.cyclonedx.json')
Pop-Location
# Paths are made repository-relative so no machine-specific folders are published.
$json = dotnet list (Join-Path $root 'src\Vystral.App\Vystral.App.csproj') package --include-transitive --format json | Out-String
$json.Replace($root.Replace('\', '/'), '.').Replace($root.Replace('\', '\\'), '.') |
  Out-File -Encoding utf8 (Join-Path $out 'dotnet-packages.json')
Write-Host "SBOM written to $out"
