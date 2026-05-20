param(
  [string]$ExePath = '',
  [string]$IconPath = '',
  [string]$IconRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExePath)) {
  $releaseExe = Join-Path $PSScriptRoot '..\src-tauri\target\release\lmp.exe'
  $debugExe = Join-Path $PSScriptRoot '..\src-tauri\target\debug\lmp.exe'
  $legacyReleaseExe = Join-Path $PSScriptRoot '..\src-tauri\target\release\lmp-one.exe'

  if (Test-Path -LiteralPath $releaseExe -PathType Leaf) {
    $ExePath = $releaseExe
  } elseif (Test-Path -LiteralPath $legacyReleaseExe -PathType Leaf) {
    $ExePath = $legacyReleaseExe
  } else {
    $ExePath = $debugExe
  }
}

$resolvedExe = (Resolve-Path -LiteralPath $ExePath).Path
if (-not (Test-Path -LiteralPath $resolvedExe -PathType Leaf)) {
  throw "LMP executable not found: $ExePath"
}

if ([string]::IsNullOrWhiteSpace($IconPath)) {
  $repoIcon = Join-Path $PSScriptRoot '..\src-tauri\icons\icon.ico'
  if (Test-Path -LiteralPath $repoIcon -PathType Leaf) {
    $IconPath = $repoIcon
  } else {
    $IconPath = $resolvedExe
  }
}

$resolvedIcon = (Resolve-Path -LiteralPath $IconPath).Path
if (-not (Test-Path -LiteralPath $resolvedIcon -PathType Leaf)) {
  throw "LMP icon not found: $IconPath"
}

$iconHash = (Get-FileHash -LiteralPath $resolvedIcon -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  $iconCacheDir = Join-Path $env:LOCALAPPDATA 'LMP\icons'
  New-Item -ItemType Directory -Path $iconCacheDir -Force | Out-Null
  $cachedIconPath = Join-Path $iconCacheDir "lmp-icon-$iconHash.ico"
  try {
    Copy-Item -LiteralPath $resolvedIcon -Destination $cachedIconPath -Force
    $resolvedIcon = $cachedIconPath
  } catch {
    if (Test-Path -LiteralPath $cachedIconPath -PathType Leaf) {
      $resolvedIcon = $cachedIconPath
    } else {
      Write-Warning "Could not cache icon at $cachedIconPath. Falling back to $resolvedIcon."
    }
  }
}

if ($resolvedExe -match '\\target\\debug\\') {
  Write-Warning 'You are registering the debug executable. It only works while the Tauri/Vite dev server is running. Build release and register target\release\lmp.exe for normal Open with usage.'
}

if ([string]::IsNullOrWhiteSpace($IconRoot)) {
  $repoIconRoot = Join-Path $PSScriptRoot '..\src-tauri\icons\filetypes'
  if (Test-Path -LiteralPath $repoIconRoot -PathType Container) {
    $IconRoot = $repoIconRoot
  }
}

$resolvedIconRoot = $null
if (-not [string]::IsNullOrWhiteSpace($IconRoot) -and (Test-Path -LiteralPath $IconRoot -PathType Container)) {
  $resolvedIconRoot = (Resolve-Path -LiteralPath $IconRoot).Path
}

function Resolve-FileTypeIconReference {
  param(
    [string]$Kind,
    [string]$FileName,
    [string]$FallbackIcon
  )

  $candidate = if ($null -ne $resolvedIconRoot) {
    Join-Path $resolvedIconRoot $FileName
  } else {
    ''
  }
  $iconPath = if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    (Resolve-Path -LiteralPath $candidate).Path
  } else {
    $FallbackIcon
  }

  if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    $hash = (Get-FileHash -LiteralPath $iconPath -Algorithm SHA256).Hash.Substring(0, 12).ToLowerInvariant()
    $cacheDir = Join-Path $env:LOCALAPPDATA 'LMP\icons'
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
    $cachedPath = Join-Path $cacheDir "lmp-$Kind-$hash.ico"
    try {
      Copy-Item -LiteralPath $iconPath -Destination $cachedPath -Force
      $iconPath = $cachedPath
    } catch {
      if (Test-Path -LiteralPath $cachedPath -PathType Leaf) {
        $iconPath = $cachedPath
      }
    }
  }

  return "`"$iconPath`",0"
}

$appName = 'LMP'
$appKeyName = 'lmp.exe'
$legacyAppKeyNames = @('lmp-one.exe', 'LMP One.exe', 'LMP.exe')
$legacyOpenWithExecutables = @('lmp-one.exe', 'LMP One.exe')
$progId = 'LMP.Media'
$description = 'LMP media file'
$progIds = @{
  Video = 'LMP.Video'
  Audio = 'LMP.Audio'
  Image = 'LMP.Image'
  Pdf = 'LMP.Pdf'
  Word = 'LMP.Word'
  Text = 'LMP.Text'
}
$tauriFileClasses = @{
  Video = 'LMP Video'
  Audio = 'LMP Audio'
  Image = 'LMP Images'
  Pdf = 'LMP PDF'
  Word = 'LMP Word Documents'
  Text = 'LMP Text'
}
$progDescriptions = @{
  Video = 'LMP video file'
  Audio = 'LMP audio file'
  Image = 'LMP image file'
  Pdf = 'LMP PDF file'
  Word = 'LMP Word extracted document'
  Text = 'LMP text file'
}
$iconFileNames = @{
  Video = 'video.ico'
  Audio = 'audio.ico'
  Image = 'image.ico'
  Pdf = 'pdf.ico'
  Word = 'word.ico'
  Text = 'text.ico'
}
$iconReference = "`"$resolvedIcon`",0"
$iconReferences = @{}
foreach ($kind in $progIds.Keys) {
  $iconReferences[$kind] = Resolve-FileTypeIconReference -Kind $kind.ToLowerInvariant() -FileName $iconFileNames[$kind] -FallbackIcon $resolvedIcon
}
$oldProgIds = @(
  'LMP.Media',
  'LMP.Document',
  'LMPOne.Media',
  'LMPOne.MediaFile',
  'LMPOne.Video',
  'LMPOne.Audio',
  'LMPOne.Images',
  'LMPOne.Documents',
  'LMP One.Media',
  'LMP One.MediaFile'
)
$videoExtensions = @(
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv',
  '.ts', '.mts', '.m2ts', '.mpeg', '.mpg', '.mpe', '.ogv',
  '.3gp', '.3g2', '.flv', '.f4v', '.asf', '.vob', '.divx', '.mxf'
)
$videoContentTypes = @{
  '.mp4' = 'video/mp4'
  '.mkv' = 'video/x-matroska'
  '.mov' = 'video/quicktime'
  '.avi' = 'video/x-msvideo'
  '.webm' = 'video/webm'
  '.m4v' = 'video/mp4'
  '.wmv' = 'video/x-ms-wmv'
  '.ts' = 'video/mp2t'
  '.mts' = 'video/mp2t'
  '.m2ts' = 'video/mp2t'
  '.mpeg' = 'video/mpeg'
  '.mpg' = 'video/mpeg'
  '.mpe' = 'video/mpeg'
  '.ogv' = 'video/ogg'
  '.3gp' = 'video/3gpp'
  '.3g2' = 'video/3gpp2'
  '.flv' = 'video/x-flv'
  '.f4v' = 'video/mp4'
  '.asf' = 'video/x-ms-asf'
  '.vob' = 'video/dvd'
  '.divx' = 'video/divx'
  '.mxf' = 'application/mxf'
}
$audioExtensions = @(
  '.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus',
  '.wma', '.aiff', '.aif', '.oga', '.weba', '.caf', '.amr',
  '.mka', '.mp2', '.mpa', '.ac3', '.eac3', '.dts', '.dtshd',
  '.ape', '.alac', '.au', '.snd'
)
$imageExtensions = @(
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.bmp', '.avif',
  '.svg', '.ico', '.tif', '.tiff'
)
$pdfExtensions = @('.pdf')
$wordExtensions = @('.doc', '.docx', '.docm', '.dotx', '.dotm')
$textExtensions = @(
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonc', '.csv',
  '.tsv', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xhtml', '.js',
  '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.rs',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.php',
  '.rb', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.lua', '.dart', '.kt',
  '.kts', '.swift', '.pl', '.r', '.gradle'
)
$extensionsByKind = @{
  Video = $videoExtensions
  Audio = $audioExtensions
  Image = $imageExtensions
  Pdf = $pdfExtensions
  Word = $wordExtensions
  Text = $textExtensions
}
$extensions = @($videoExtensions + $audioExtensions + $imageExtensions + $pdfExtensions + $wordExtensions + $textExtensions)

function Ensure-Key {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -Path $Path -Force | Out-Null
  }
}

function Set-DefaultValue {
  param(
    [string]$Path,
    [string]$Value
  )
  Ensure-Key $Path
  Set-Item -LiteralPath $Path -Value $Value
}

$thumbnailHandlerKey = '{e357fccd-a995-4576-b01f-234630154e96}'
$windowsVideoThumbnailProvider = '{9DBD2C50-62AD-11D0-B806-00C04FD706EC}'

function Set-ThumbnailHandlerIfMissing {
  param([string]$RootPath)
  $handlerPath = Join-Path $RootPath "ShellEx\$thumbnailHandlerKey"
  Ensure-Key $handlerPath
  $currentHandler = (Get-Item -LiteralPath $handlerPath).GetValue('')
  if ([string]::IsNullOrWhiteSpace($currentHandler)) {
    Set-DefaultValue $handlerPath $windowsVideoThumbnailProvider
  }
}

function Set-VideoExplorerHints {
  param(
    [string]$RootPath,
    [string]$ContentType = ''
  )
  Ensure-Key $RootPath
  Set-ItemProperty -LiteralPath $RootPath -Name 'PerceivedType' -Value 'video'
  if (-not [string]::IsNullOrWhiteSpace($ContentType)) {
    Set-ItemProperty -LiteralPath $RootPath -Name 'Content Type' -Value $ContentType
  }
  Set-ThumbnailHandlerIfMissing $RootPath
}

$classesRoot = 'HKCU:\Software\Classes'
$appRoot = Join-Path $classesRoot "Applications\$appKeyName"
$progRoot = Join-Path $classesRoot $progId
$capabilitiesRoot = 'HKCU:\Software\LMP\Capabilities'

foreach ($legacyAppKeyName in $legacyAppKeyNames) {
  Remove-Item -LiteralPath (Join-Path $classesRoot "Applications\$legacyAppKeyName") -Recurse -Force -ErrorAction SilentlyContinue
}

foreach ($oldProgId in $oldProgIds) {
  Remove-Item -LiteralPath (Join-Path $classesRoot $oldProgId) -Recurse -Force -ErrorAction SilentlyContinue
}

Set-DefaultValue $progRoot $description
Set-DefaultValue (Join-Path $progRoot 'DefaultIcon') $iconReference
Set-DefaultValue (Join-Path $progRoot 'shell\open\command') "`"$resolvedExe`" `"%1`""

foreach ($kind in $progIds.Keys) {
  $kindProgRoot = Join-Path $classesRoot $progIds[$kind]
  Set-DefaultValue $kindProgRoot $progDescriptions[$kind]
  Set-DefaultValue (Join-Path $kindProgRoot 'DefaultIcon') $iconReferences[$kind]
  Set-DefaultValue (Join-Path $kindProgRoot 'shell\open\command') "`"$resolvedExe`" `"%1`""

  $tauriFileClassRoot = Join-Path $classesRoot $tauriFileClasses[$kind]
  if (Test-Path -LiteralPath $tauriFileClassRoot) {
    Set-DefaultValue (Join-Path $tauriFileClassRoot 'DefaultIcon') $iconReferences[$kind]
  }
}

Set-VideoExplorerHints (Join-Path $classesRoot $progIds['Video'])
$tauriVideoFileClassRoot = Join-Path $classesRoot $tauriFileClasses['Video']
Set-VideoExplorerHints $tauriVideoFileClassRoot

$pdfIconReference = $iconReferences['Pdf']
Set-DefaultValue (Join-Path $classesRoot 'LMP.Pdf\DefaultIcon') $pdfIconReference
Set-DefaultValue (Join-Path $classesRoot 'LMP.pdf\DefaultIcon') $pdfIconReference
Set-DefaultValue (Join-Path $classesRoot 'LMP PDF\DefaultIcon') $pdfIconReference
Set-DefaultValue (Join-Path $classesRoot 'LMP_PDF\DefaultIcon') $pdfIconReference

Set-DefaultValue (Join-Path $appRoot 'shell\open\command') "`"$resolvedExe`" `"%1`""
Set-ItemProperty -LiteralPath $appRoot -Name 'FriendlyAppName' -Value $appName
Set-DefaultValue (Join-Path $appRoot 'DefaultIcon') $iconReference

Ensure-Key (Join-Path $appRoot 'SupportedTypes')
Ensure-Key (Join-Path $capabilitiesRoot 'FileAssociations')

Set-ItemProperty -LiteralPath $capabilitiesRoot -Name 'ApplicationName' -Value $appName
Set-ItemProperty -LiteralPath $capabilitiesRoot -Name 'ApplicationDescription' -Value 'A soft, native-first media, image and document viewer for Windows.'
Set-ItemProperty -LiteralPath $capabilitiesRoot -Name 'ApplicationIcon' -Value $iconReference

foreach ($ext in $extensions) {
  $kind = if ($videoExtensions -contains $ext) {
    'Video'
  } elseif ($audioExtensions -contains $ext) {
    'Audio'
  } elseif ($imageExtensions -contains $ext) {
    'Image'
  } elseif ($pdfExtensions -contains $ext) {
    'Pdf'
  } elseif ($wordExtensions -contains $ext) {
    'Word'
  } else {
    'Text'
  }
  $kindProgId = $progIds[$kind]

  Set-ItemProperty -LiteralPath (Join-Path $appRoot 'SupportedTypes') -Name $ext -Value ''
  Set-ItemProperty -LiteralPath (Join-Path $capabilitiesRoot 'FileAssociations') -Name $ext -Value $kindProgId

  Ensure-Key (Join-Path $classesRoot "$ext\OpenWithProgids")
  foreach ($oldProgId in $oldProgIds) {
    Remove-ItemProperty -LiteralPath (Join-Path $classesRoot "$ext\OpenWithProgids") -Name $oldProgId -ErrorAction SilentlyContinue
  }
  New-ItemProperty -Path (Join-Path $classesRoot "$ext\OpenWithProgids") -Name $kindProgId -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null
  if ($kind -eq 'Video') {
    Set-VideoExplorerHints (Join-Path $classesRoot $ext) $videoContentTypes[$ext]
  }

  foreach ($legacyAppKeyName in $legacyAppKeyNames) {
    Remove-Item -LiteralPath (Join-Path $classesRoot "$ext\OpenWithList\$legacyAppKeyName") -Recurse -Force -ErrorAction SilentlyContinue
  }
  Ensure-Key (Join-Path $classesRoot "$ext\OpenWithList\$appKeyName")

  $explorerExtRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext"
  if (Test-Path -LiteralPath (Join-Path $explorerExtRoot 'OpenWithList')) {
    $openWithListPath = Join-Path $explorerExtRoot 'OpenWithList'
    $openWithList = Get-ItemProperty -LiteralPath $openWithListPath
    foreach ($property in $openWithList.PSObject.Properties) {
      if ($property.Name -match '^[a-z]$' -and $legacyOpenWithExecutables -contains $property.Value) {
        Remove-ItemProperty -LiteralPath $openWithListPath -Name $property.Name -ErrorAction SilentlyContinue
      }
    }
  }
  if (Test-Path -LiteralPath (Join-Path $explorerExtRoot 'OpenWithProgids')) {
    foreach ($oldProgId in $oldProgIds) {
      Remove-ItemProperty -LiteralPath (Join-Path $explorerExtRoot 'OpenWithProgids') -Name $oldProgId -ErrorAction SilentlyContinue
    }
    New-ItemProperty -Path (Join-Path $explorerExtRoot 'OpenWithProgids') -Name $kindProgId -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null
  }
}

Set-DefaultValue (Join-Path $classesRoot '.pdf') $progIds['Pdf']
Ensure-Key (Join-Path $classesRoot '.pdf\OpenWithProgids')
Remove-ItemProperty -LiteralPath (Join-Path $classesRoot '.pdf\OpenWithProgids') -Name 'LMP.Document' -ErrorAction SilentlyContinue
New-ItemProperty -Path (Join-Path $classesRoot '.pdf\OpenWithProgids') -Name $progIds['Pdf'] -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null
$pdfExplorerOpenWithProgIds = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.pdf\OpenWithProgids'
Ensure-Key $pdfExplorerOpenWithProgIds
Remove-ItemProperty -LiteralPath $pdfExplorerOpenWithProgIds -Name 'LMP.Document' -ErrorAction SilentlyContinue
New-ItemProperty -Path $pdfExplorerOpenWithProgIds -Name $progIds['Pdf'] -Value ([byte[]]@()) -PropertyType Binary -Force | Out-Null

Ensure-Key 'HKCU:\Software\RegisteredApplications'
Remove-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name 'LMP One' -ErrorAction SilentlyContinue
Set-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name $appName -Value 'Software\LMP\Capabilities'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellNotify {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@

[ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Output "Registered $appName for: $($extensions -join ', ')"
Write-Output "Executable: $resolvedExe"
Write-Output "Icon: $resolvedIcon"
Write-Output "Windows still requires you to choose it as the default app in Settings or the Open with dialog."
