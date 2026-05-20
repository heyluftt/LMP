$ErrorActionPreference = 'Stop'

$appName = 'LMP'
$appKeyName = 'lmp.exe'
$legacyAppKeyNames = @('lmp-one.exe', 'LMP One.exe', 'LMP.exe')
$legacyOpenWithExecutables = @('lmp-one.exe', 'LMP One.exe')
$progId = 'LMP.Media'
$progIds = @('LMP.Media', 'LMP.Video', 'LMP.Audio', 'LMP.Image', 'LMP.Pdf', 'LMP.pdf', 'LMP_PDF', 'LMP.Word', 'LMP.Document', 'LMP.Text')
$oldProgIds = @(
  'LMP.Media',
  'LMP.Video',
  'LMP.Audio',
  'LMP.Image',
  'LMP.Pdf',
  'LMP.pdf',
  'LMP_PDF',
  'LMP.Word',
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
$extensions = @(
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv',
  '.ts', '.mts', '.m2ts', '.mpeg', '.mpg', '.mpe', '.ogv',
  '.3gp', '.3g2', '.flv', '.f4v', '.asf', '.vob', '.divx', '.mxf',
  '.mp3', '.flac', '.wav', '.m4a', '.aac', '.ogg', '.opus',
  '.wma', '.aiff', '.aif', '.oga', '.weba', '.caf', '.amr',
  '.mka', '.mp2', '.mpa', '.ac3', '.eac3', '.dts', '.dtshd',
  '.ape', '.alac', '.au', '.snd',
  '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.bmp', '.avif',
  '.svg', '.ico', '.tif', '.tiff',
  '.pdf', '.doc', '.docx', '.docm', '.dotx', '.dotm',
  '.txt', '.md', '.markdown', '.log', '.json', '.jsonc', '.csv',
  '.tsv', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg',
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.xhtml', '.js',
  '.jsx', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.rs',
  '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.php',
  '.rb', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.lua', '.dart', '.kt',
  '.kts', '.swift', '.pl', '.r', '.gradle'
)
$videoExtensions = @(
  '.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v', '.wmv',
  '.ts', '.mts', '.m2ts', '.mpeg', '.mpg', '.mpe', '.ogv',
  '.3gp', '.3g2', '.flv', '.f4v', '.asf', '.vob', '.divx', '.mxf'
)
$thumbnailHandlerKey = '{e357fccd-a995-4576-b01f-234630154e96}'
$windowsVideoThumbnailProvider = '{9DBD2C50-62AD-11D0-B806-00C04FD706EC}'

function Remove-LmpVideoExplorerHints {
  param([string]$RootPath)
  if (-not (Test-Path -LiteralPath $RootPath)) {
    return
  }

  $handlerPath = Join-Path $RootPath "ShellEx\$thumbnailHandlerKey"
  if (Test-Path -LiteralPath $handlerPath) {
    $handlerValue = (Get-Item -LiteralPath $handlerPath).GetValue('')
    if ($handlerValue -eq $windowsVideoThumbnailProvider) {
      Remove-Item -LiteralPath $handlerPath -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  Remove-ItemProperty -LiteralPath $RootPath -Name 'PerceivedType' -ErrorAction SilentlyContinue
  Remove-ItemProperty -LiteralPath $RootPath -Name 'Content Type' -ErrorAction SilentlyContinue
}

foreach ($ext in $extensions) {
  if ($videoExtensions -contains $ext) {
    Remove-LmpVideoExplorerHints "HKCU:\Software\Classes\$ext"
  }

  Remove-Item -LiteralPath "HKCU:\Software\Classes\$ext\OpenWithList\$appKeyName" -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($legacyAppKeyName in $legacyAppKeyNames) {
    Remove-Item -LiteralPath "HKCU:\Software\Classes\$ext\OpenWithList\$legacyAppKeyName" -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($registeredProgId in $progIds) {
    Remove-ItemProperty -LiteralPath "HKCU:\Software\Classes\$ext\OpenWithProgids" -Name $registeredProgId -ErrorAction SilentlyContinue
  }
  foreach ($oldProgId in $oldProgIds) {
    Remove-ItemProperty -LiteralPath "HKCU:\Software\Classes\$ext\OpenWithProgids" -Name $oldProgId -ErrorAction SilentlyContinue
  }

  $explorerExtRoot = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext"
  if (Test-Path -LiteralPath "$explorerExtRoot\OpenWithList") {
    $openWithList = Get-ItemProperty -LiteralPath "$explorerExtRoot\OpenWithList"
    foreach ($property in $openWithList.PSObject.Properties) {
      if ($property.Name -match '^[a-z]$' -and $legacyOpenWithExecutables -contains $property.Value) {
        Remove-ItemProperty -LiteralPath "$explorerExtRoot\OpenWithList" -Name $property.Name -ErrorAction SilentlyContinue
      }
    }
  }
  if (Test-Path -LiteralPath "$explorerExtRoot\OpenWithProgids") {
    foreach ($registeredProgId in $progIds) {
      Remove-ItemProperty -LiteralPath "$explorerExtRoot\OpenWithProgids" -Name $registeredProgId -ErrorAction SilentlyContinue
    }
  }
}

Remove-LmpVideoExplorerHints 'HKCU:\Software\Classes\LMP.Video'
Remove-LmpVideoExplorerHints 'HKCU:\Software\Classes\LMP Video'

$pdfDefault = (Get-Item -LiteralPath 'HKCU:\Software\Classes\.pdf' -ErrorAction SilentlyContinue).GetValue('')
if (@('LMP.Pdf', 'LMP.pdf', 'LMP PDF') -contains $pdfDefault) {
  Remove-ItemProperty -LiteralPath 'HKCU:\Software\Classes\.pdf' -Name '(default)' -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath "HKCU:\Software\Classes\Applications\$appKeyName" -Recurse -Force -ErrorAction SilentlyContinue
foreach ($legacyAppKeyName in $legacyAppKeyNames) {
  Remove-Item -LiteralPath "HKCU:\Software\Classes\Applications\$legacyAppKeyName" -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($registeredProgId in $progIds) {
  Remove-Item -LiteralPath "HKCU:\Software\Classes\$registeredProgId" -Recurse -Force -ErrorAction SilentlyContinue
}
foreach ($oldProgId in $oldProgIds) {
  Remove-Item -LiteralPath "HKCU:\Software\Classes\$oldProgId" -Recurse -Force -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath 'HKCU:\Software\LMP' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'HKCU:\Software\LMP One' -Recurse -Force -ErrorAction SilentlyContinue
Remove-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name $appName -ErrorAction SilentlyContinue
Remove-ItemProperty -LiteralPath 'HKCU:\Software\RegisteredApplications' -Name 'LMP One' -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShellNotify {
  [DllImport("shell32.dll")]
  public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@

[ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)

Write-Output "Unregistered $appName from Open with candidates."
