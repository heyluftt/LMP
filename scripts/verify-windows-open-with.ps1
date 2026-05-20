param(
  [string[]]$Extensions = @('.mp4', '.mkv', '.ts', '.mp3', '.png', '.pdf', '.doc', '.docx', '.txt', '.md', '.json')
)

$ErrorActionPreference = 'Stop'

$appName = 'LMP'
$appKeyName = 'lmp.exe'
$expectedProgIds = @('LMP.Video', 'LMP.Audio', 'LMP.Image', 'LMP.Pdf', 'LMP.Word', 'LMP.Text')
$expectedTauriFileClasses = @('LMP Video', 'LMP Audio', 'LMP Images', 'LMP PDF', 'LMP Word Documents', 'LMP Text')
$expectedProgIdByExtension = @{
  '.mp4' = 'LMP.Video'
  '.mkv' = 'LMP.Video'
  '.ts' = 'LMP.Video'
  '.mp3' = 'LMP.Audio'
  '.wav' = 'LMP.Audio'
  '.png' = 'LMP.Image'
  '.jpg' = 'LMP.Image'
  '.jpeg' = 'LMP.Image'
  '.jfif' = 'LMP.Image'
  '.pdf' = 'LMP.Pdf'
  '.doc' = 'LMP.Word'
  '.docx' = 'LMP.Word'
  '.txt' = 'LMP.Text'
  '.md' = 'LMP.Text'
  '.json' = 'LMP.Text'
}
$videoExtensions = @('.mp4', '.mkv', '.ts', '.mov', '.avi', '.webm', '.m4v', '.wmv', '.mts', '.m2ts', '.mpeg', '.mpg', '.mpe', '.ogv', '.3gp', '.3g2', '.flv', '.f4v', '.asf', '.vob', '.divx', '.mxf')
$thumbnailHandlerKey = '{e357fccd-a995-4576-b01f-234630154e96}'
$windowsVideoThumbnailProvider = '{9DBD2C50-62AD-11D0-B806-00C04FD706EC}'
$classesRoot = 'HKCU:\Software\Classes'
$appRoot = Join-Path $classesRoot "Applications\$appKeyName"
$capabilitiesRoot = 'HKCU:\Software\LMP\Capabilities'
$registeredApps = 'HKCU:\Software\RegisteredApplications'

function Read-DefaultValue {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  (Get-Item -LiteralPath $Path).GetValue('')
}

function Read-PropertyNames {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return @()
  }
  $item = Get-ItemProperty -LiteralPath $Path
  @($item.PSObject.Properties |
    Where-Object { $_.Name -notlike 'PS*' } |
    ForEach-Object { $_.Name })
}

function Read-PropertyValue {
  param(
    [string]$Path,
    [string]$Name
  )
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  $item = Get-ItemProperty -LiteralPath $Path
  $property = $item.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Test-IconReferenceExists {
  param([string]$Reference)
  if ([string]::IsNullOrWhiteSpace($Reference)) {
    return $false
  }
  $path = $Reference
  if ($path.StartsWith('"')) {
    $closing = $path.IndexOf('"', 1)
    if ($closing -gt 1) {
      $path = $path.Substring(1, $closing - 1)
    }
  } elseif ($path.Contains(',')) {
    $path = $path.Split(',')[0]
  }
  return Test-Path -LiteralPath $path -PathType Leaf
}

function Get-IconReferencePath {
  param([string]$Reference)
  if ([string]::IsNullOrWhiteSpace($Reference)) {
    return ''
  }
  $path = $Reference
  if ($path.StartsWith('"')) {
    $closing = $path.IndexOf('"', 1)
    if ($closing -gt 1) {
      return $path.Substring(1, $closing - 1)
    }
  }
  if ($path.Contains(',')) {
    return $path.Split(',')[0]
  }
  return $path
}

function Test-PdfIconReference {
  param([string]$Reference)
  $path = Get-IconReferencePath $Reference
  return ((Split-Path -Leaf $path) -ieq 'pdf.ico' -and (Test-Path -LiteralPath $path -PathType Leaf))
}

function Read-ThumbnailHandler {
  param([string]$RootPath)
  Read-DefaultValue (Join-Path $RootPath "ShellEx\$thumbnailHandlerKey")
}

function Test-HasNativeVideoThumbnailHandler {
  param([string]$RootPath)
  $handler = Read-ThumbnailHandler $RootPath
  return ($handler -eq $windowsVideoThumbnailProvider)
}

$issues = New-Object System.Collections.Generic.List[string]

if (-not (Test-Path -LiteralPath $appRoot)) {
  $issues.Add("Missing application key: $appRoot")
}

$openCommand = Read-DefaultValue (Join-Path $appRoot 'shell\open\command')
if ([string]::IsNullOrWhiteSpace($openCommand) -or $openCommand -notmatch 'lmp\.exe') {
  $issues.Add("Application open command is missing or does not point at lmp.exe.")
}

if (-not (Test-Path -LiteralPath $capabilitiesRoot)) {
  $issues.Add("Missing capabilities key: $capabilitiesRoot")
} else {
  $capabilities = Get-ItemProperty -LiteralPath $capabilitiesRoot
  if ($capabilities.ApplicationName -ne $appName) {
    $issues.Add("Capabilities ApplicationName is not LMP.")
  }
}

if (-not (Test-Path -LiteralPath $registeredApps)) {
  $issues.Add("Missing RegisteredApplications key.")
} else {
  $registered = Get-ItemProperty -LiteralPath $registeredApps
  $registeredLmp = $registered.PSObject.Properties[$appName]
  if ($null -eq $registeredLmp -or $registeredLmp.Value -ne 'Software\LMP\Capabilities') {
    $issues.Add("RegisteredApplications does not point LMP to Software\LMP\Capabilities.")
  }
}

foreach ($progId in $expectedProgIds) {
  $progRoot = Join-Path $classesRoot $progId
  if (-not (Test-Path -LiteralPath $progRoot)) {
    $issues.Add("Missing ProgID: $progId")
    continue
  }
  $progCommand = Read-DefaultValue (Join-Path $progRoot 'shell\open\command')
  if ([string]::IsNullOrWhiteSpace($progCommand) -or $progCommand -notmatch 'lmp\.exe') {
    $issues.Add("ProgID $progId has no lmp.exe open command.")
  }
  $defaultIcon = Read-DefaultValue (Join-Path $progRoot 'DefaultIcon')
  if (-not (Test-IconReferenceExists $defaultIcon)) {
    $issues.Add("ProgID $progId has no readable DefaultIcon: $defaultIcon")
  }
}

foreach ($fileClass in $expectedTauriFileClasses) {
  $fileClassRoot = Join-Path $classesRoot $fileClass
  if (-not (Test-Path -LiteralPath $fileClassRoot)) {
    continue
  }
  $defaultIcon = Read-DefaultValue (Join-Path $fileClassRoot 'DefaultIcon')
  if (-not (Test-IconReferenceExists $defaultIcon)) {
    $issues.Add("Tauri file class $fileClass has no readable DefaultIcon: $defaultIcon")
  }
}

$videoProgRoot = Join-Path $classesRoot 'LMP.Video'
if (Test-Path -LiteralPath $videoProgRoot) {
  $videoProgHandler = Read-ThumbnailHandler $videoProgRoot
  if ($videoProgHandler -ne $windowsVideoThumbnailProvider) {
    $issues.Add("LMP.Video should keep the native Windows video thumbnail handler, got: $videoProgHandler")
  }
  $videoProgPerceivedType = Read-PropertyValue $videoProgRoot 'PerceivedType'
  if ($videoProgPerceivedType -ne 'video') {
    $issues.Add("LMP.Video PerceivedType should be video, got: $videoProgPerceivedType")
  }
}

$pdfIconTargets = @('LMP.Pdf', 'LMP.pdf', 'LMP PDF', 'LMP_PDF')
foreach ($pdfIconTarget in $pdfIconTargets) {
  $pdfIconRoot = Join-Path $classesRoot "$pdfIconTarget\DefaultIcon"
  if (-not (Test-Path -LiteralPath $pdfIconRoot)) {
    if ($pdfIconTarget -eq 'LMP_PDF') {
      continue
    }
    $issues.Add("Missing PDF DefaultIcon key: $pdfIconTarget")
    continue
  }
  $pdfDefaultIcon = Read-DefaultValue $pdfIconRoot
  if (-not (Test-PdfIconReference $pdfDefaultIcon)) {
    $issues.Add("PDF class $pdfIconTarget should point to pdf.ico, got: $pdfDefaultIcon")
  }
}

foreach ($ext in $Extensions) {
  if (-not $ext.StartsWith('.')) {
    $ext = ".$ext"
  }

  $supportedTypes = Join-Path $appRoot 'SupportedTypes'
  $appSupported = Read-PropertyNames $supportedTypes
  if ($appSupported -notcontains $ext) {
    $issues.Add("$ext is missing from Applications\$appKeyName\SupportedTypes.")
  }

  $openWithProgIds = Join-Path $classesRoot "$ext\OpenWithProgids"
  $openWithNames = Read-PropertyNames $openWithProgIds
  $expectedProgId = $expectedProgIdByExtension[$ext]
  if ($null -ne $expectedProgId -and $openWithNames -notcontains $expectedProgId) {
    $issues.Add("$ext is missing expected ProgID $expectedProgId in HKCU OpenWithProgids.")
  } elseif ($null -eq $expectedProgId -and -not ($openWithNames | Where-Object { $_ -like 'LMP.*' })) {
    $issues.Add("$ext has no LMP ProgID in HKCU OpenWithProgids.")
  }
  if ($ext -eq '.pdf' -and $openWithNames -contains 'LMP.Document') {
    $issues.Add(".pdf still contains legacy LMP.Document in HKCU OpenWithProgids.")
  }
  if ($ext -eq '.pdf') {
    $pdfDefaultFileClass = Read-DefaultValue (Join-Path $classesRoot '.pdf')
    if ($pdfDefaultFileClass -eq 'LMP.Document') {
      $issues.Add(".pdf default file class still points at legacy LMP.Document.")
    } elseif (-not [string]::IsNullOrWhiteSpace($pdfDefaultFileClass) -and $pdfDefaultFileClass -like 'LMP*' -and $pdfDefaultFileClass -ne 'LMP.Pdf') {
      $issues.Add(".pdf default file class is $pdfDefaultFileClass, expected LMP.Pdf.")
    }

    $pdfExplorerOpenWith = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids'
    $pdfExplorerNames = Read-PropertyNames $pdfExplorerOpenWith
    if ($pdfExplorerNames -contains 'LMP.Document') {
      $issues.Add("Explorer FileExts .pdf still contains legacy LMP.Document.")
    }
  }

  $capAssociations = Join-Path $capabilitiesRoot 'FileAssociations'
  $capNames = Read-PropertyNames $capAssociations
  if ($capNames -notcontains $ext) {
    $issues.Add("$ext is missing from LMP capabilities FileAssociations.")
  } elseif ($null -ne $expectedProgId) {
    $capValue = Read-PropertyValue $capAssociations $ext
    if ($capValue -ne $expectedProgId) {
      $issues.Add("$ext capabilities value is $capValue, expected $expectedProgId.")
    }
  }

  $defaultFileClass = Read-DefaultValue (Join-Path $classesRoot $ext)
  if ($defaultFileClass -like 'LMP*') {
    $defaultClassIcon = Read-DefaultValue (Join-Path $classesRoot "$defaultFileClass\DefaultIcon")
    if (-not (Test-IconReferenceExists $defaultClassIcon)) {
      $issues.Add("$ext default file class $defaultFileClass has no readable DefaultIcon: $defaultClassIcon")
    }
  }

  if ($videoExtensions -contains $ext) {
    $extRoot = Join-Path $classesRoot $ext
    $perceivedType = Read-PropertyValue $extRoot 'PerceivedType'
    if ($perceivedType -ne 'video') {
      $issues.Add("$ext PerceivedType should be video, got: $perceivedType")
    }
    $contentType = Read-PropertyValue $extRoot 'Content Type'
    if ([string]::IsNullOrWhiteSpace($contentType)) {
      $issues.Add("$ext is missing Content Type for Windows Explorer video classification.")
    }
    if (-not (Test-HasNativeVideoThumbnailHandler $extRoot) -and -not (Test-HasNativeVideoThumbnailHandler $videoProgRoot)) {
      $issues.Add("$ext has no native Windows video thumbnail handler hint.")
    }
  }
}

if ($issues.Count -gt 0) {
  Write-Output 'LMP Open With verification failed:'
  foreach ($issue in $issues) {
    Write-Output " - $issue"
  }
  exit 1
}

Write-Output "LMP Open With verification passed for: $($Extensions -join ', ')"
Write-Output "Application command: $openCommand"
Write-Output 'Note: Windows still owns the protected UserChoice default-app value.'
