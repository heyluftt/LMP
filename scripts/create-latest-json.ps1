[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $Version,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $ArtifactUrl,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $SignatureFile,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string] $NotesFile,

  [ValidateNotNullOrEmpty()]
  [string] $Output = "latest.json",

  [ValidateNotNullOrEmpty()]
  [string] $PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
)

function Get-RequiredTextFile {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Label
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label file was not found."
  }

  $content = (Get-Content -LiteralPath $Path -Raw).Trim()
  if (-not $content) {
    throw "$Label file is empty."
  }

  return $content
}

function Assert-HttpsUrl {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Url
  )

  $uri = $null
  if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref] $uri)) {
    throw "ArtifactUrl must be an absolute URL."
  }

  if ($uri.Scheme -ne "https") {
    throw "ArtifactUrl must use https."
  }
}

function Write-Utf8NoBom {
  param(
    [Parameter(Mandatory = $true)]
    [string] $Path,

    [Parameter(Mandatory = $true)]
    [string] $Value
  )

  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }

  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Value + [Environment]::NewLine, $encoding)
}

Assert-HttpsUrl -Url $ArtifactUrl

$signature = Get-RequiredTextFile -Path $SignatureFile -Label "Signature"
$notes = Get-RequiredTextFile -Path $NotesFile -Label "Notes"

$latest = [ordered]@{
  version = $Version
  notes = $notes
  pub_date = $PubDate
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      url = $ArtifactUrl
      signature = $signature
    }
  }
}

$json = $latest | ConvertTo-Json -Depth 6
Write-Utf8NoBom -Path $Output -Value $json
Write-Output "Wrote $Output"
