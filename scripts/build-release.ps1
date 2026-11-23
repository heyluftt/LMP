[CmdletBinding()]
param(
  # Minisign key created with `npx tauri signer generate`. Its public half is the
  # updater pubkey in src-tauri/tauri.conf.json.
  [string] $KeyPath = (Join-Path $env:USERPROFILE ".tauri\lmp-updater.key"),

  [string] $Repository = "heyluftt/LMP",

  [string] $TagSuffix = "-alpha"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf)) {
  throw "Signing key not found: $KeyPath"
}

$version = (Get-Content -LiteralPath "src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
$tag = "v$version$TagSuffix"
$installerName = "LMP_${version}_x64-setup.exe"
$bundleDir = Join-Path $root "src-tauri\target\release\bundle\nsis"

# Release notes for the updater come from this version's CHANGELOG section.
$changelog = Get-Content -LiteralPath "CHANGELOG.md" -Raw
$pattern = "(?ms)^## $([regex]::Escape($version))\b[^\r\n]*\r?\n(.*?)(?=^## |\z)"
$match = [regex]::Match($changelog, $pattern)
if (-not $match.Success) {
  throw "CHANGELOG.md has no section for $version."
}
$notesFile = Join-Path ([System.IO.Path]::GetTempPath()) "lmp-notes-$version.md"
$title = "# LMP $tag" -replace "-alpha$", " Alpha"
Set-Content -LiteralPath $notesFile -Value ($title + "`n`n" + $match.Groups[1].Value.Trim()) -Encoding utf8

$password = Read-Host "Password for $KeyPath (leave empty if it has none)" -AsSecureString
try {
  $env:TAURI_SIGNING_PRIVATE_KEY = $KeyPath
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new("", $password).Password

  # npm ci keeps the @tauri-apps JS packages on the versions the Rust crates expect.
  npm.cmd ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }

  npx.cmd tauri build --bundles nsis
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed." }
}
finally {
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$installer = Join-Path $bundleDir $installerName
$signature = "$installer.sig"
if (-not (Test-Path -LiteralPath $signature -PathType Leaf)) {
  throw "No updater signature next to $installerName. Check the signing key and password."
}

& (Join-Path $PSScriptRoot "create-latest-json.ps1") `
  -Version $version `
  -ArtifactUrl "https://github.com/$Repository/releases/download/$tag/$installerName" `
  -SignatureFile $signature `
  -NotesFile $notesFile `
  -Output (Join-Path $root "updater\latest.json")

Write-Output ""
Write-Output "Installer: $installer"
Write-Output "Signature: $signature"
Write-Output "Release tag: $tag"
