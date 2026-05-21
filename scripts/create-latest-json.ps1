[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string] $Version,

  [Parameter(Mandatory = $true)]
  [string] $ArtifactUrl,

  [Parameter(Mandatory = $true)]
  [string] $SignatureFile,

  [Parameter(Mandatory = $true)]
  [string] $NotesFile,

  [string] $Output = "latest.json",

  [string] $PubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
)

$signature = (Get-Content -LiteralPath $SignatureFile -Raw).Trim()
$notes = (Get-Content -LiteralPath $NotesFile -Raw).Trim()

if (-not $signature) {
  throw "Signature file is empty."
}

if (-not $notes) {
  throw "Notes file is empty."
}

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
Set-Content -LiteralPath $Output -Value $json -Encoding utf8
Write-Output "Wrote $Output"
