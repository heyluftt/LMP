param(
  [string]$OutPath = (Join-Path $PSScriptRoot '..\src-tauri\icons\icon.ico')
)

Add-Type -AssemblyName System.Drawing

function New-IconBitmap {
  param([int]$Size)

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $padding = [Math]::Max(2, [Math]::Round($Size * 0.055))
  $rect = New-Object System.Drawing.RectangleF $padding, $padding, ($Size - $padding * 2), ($Size - $padding * 2)
  $radius = $Size * 0.22

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($rect.X, $rect.Y, $diameter, $diameter, 180, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Y, $diameter, $diameter, 270, 90)
  $path.AddArc($rect.Right - $diameter, $rect.Bottom - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
    ([System.Drawing.Color]::FromArgb(255, 8, 13, 15)),
    ([System.Drawing.Color]::FromArgb(255, 27, 33, 34)),
    38
  $graphics.FillPath($bg, $path)

  $glowRect = New-Object System.Drawing.RectangleF ($Size * -0.04), ($Size * -0.02), ($Size * 0.88), ($Size * 0.88)
  $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glowPath.AddEllipse($glowRect)
  $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
  $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(210, 164, 234, 208)
  $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 164, 234, 208))
  $graphics.FillPath($glowBrush, $glowPath)

  $warmRect = New-Object System.Drawing.RectangleF ($Size * 0.34), ($Size * 0.32), ($Size * 0.84), ($Size * 0.84)
  $warmPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $warmPath.AddEllipse($warmRect)
  $warmBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $warmPath
  $warmBrush.CenterColor = [System.Drawing.Color]::FromArgb(210, 237, 197, 120)
  $warmBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 237, 197, 120))
  $graphics.FillPath($warmBrush, $warmPath)

  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 255, 255, 255)), ([Math]::Max(1, $Size * 0.018))
  $graphics.DrawPath($borderPen, $path)

  $buttonRect = New-Object System.Drawing.RectangleF ($Size * 0.22), ($Size * 0.2), ($Size * 0.56), ($Size * 0.56)
  $buttonPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $buttonPath.AddEllipse($buttonRect)
  $buttonBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $buttonRect,
    ([System.Drawing.Color]::FromArgb(255, 173, 242, 218)),
    ([System.Drawing.Color]::FromArgb(255, 238, 204, 126)),
    135
  $graphics.FillPath($buttonBrush, $buttonPath)

  $buttonPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(80, 0, 0, 0)), ([Math]::Max(1, $Size * 0.018))
  $graphics.DrawPath($buttonPen, $buttonPath)

  $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tri.AddPolygon(@(
    (New-Object System.Drawing.PointF ($Size * 0.44), ($Size * 0.36)),
    (New-Object System.Drawing.PointF ($Size * 0.44), ($Size * 0.60)),
    (New-Object System.Drawing.PointF ($Size * 0.63), ($Size * 0.48))
  ))
  $graphics.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 8, 13, 15))), $tri)

  if ($Size -ge 64) {
    $fontSize = $Size * 0.115
    $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF ($Size * 0.12), ($Size * 0.74), ($Size * 0.76), ($Size * 0.16)
    $textBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(232, 247, 242, 235))
    $graphics.DrawString('LMP', $font, $textBrush, $textRect, $format)
    $font.Dispose()
    $format.Dispose()
    $textBrush.Dispose()
  }

  $tri.Dispose()
  $buttonPen.Dispose()
  $buttonBrush.Dispose()
  $buttonPath.Dispose()
  $borderPen.Dispose()
  $warmBrush.Dispose()
  $warmPath.Dispose()
  $glowBrush.Dispose()
  $glowPath.Dispose()
  $bg.Dispose()
  $path.Dispose()
  $graphics.Dispose()

  return $bitmap
}

function Get-IconDibBytes {
  param([System.Drawing.Bitmap]$Bitmap)

  $width = $Bitmap.Width
  $height = $Bitmap.Height
  $maskStride = [int]([Math]::Ceiling($width / 32.0) * 4)
  $maskBytes = New-Object byte[] ($maskStride * $height)
  $pixelBytes = New-Object byte[] ($width * $height * 4)

  $offset = 0
  for ($y = $height - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $width; $x++) {
      $color = $Bitmap.GetPixel($x, $y)
      $pixelBytes[$offset++] = $color.B
      $pixelBytes[$offset++] = $color.G
      $pixelBytes[$offset++] = $color.R
      $pixelBytes[$offset++] = $color.A
    }
  }

  $stream = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter $stream
  $writer.Write([UInt32]40)
  $writer.Write([Int32]$width)
  $writer.Write([Int32]($height * 2))
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]0)
  $writer.Write([UInt32]$pixelBytes.Length)
  $writer.Write([Int32]0)
  $writer.Write([Int32]0)
  $writer.Write([UInt32]0)
  $writer.Write([UInt32]0)
  $writer.Write($pixelBytes)
  $writer.Write($maskBytes)
  $writer.Flush()
  $bytes = $stream.ToArray()
  $writer.Dispose()
  $stream.Dispose()
  return $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = @()
foreach ($size in $sizes) {
  $bitmap = New-IconBitmap -Size $size
  $bytes = Get-IconDibBytes -Bitmap $bitmap
  $entries += [pscustomobject]@{
    Size = $size
    Bytes = $bytes
  }
  $bitmap.Dispose()
}

$resolvedOut = [System.IO.Path]::GetFullPath($OutPath)
$parent = Split-Path -Parent $resolvedOut
if (!(Test-Path $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}

$file = [System.IO.File]::Create($resolvedOut)
$writer = New-Object System.IO.BinaryWriter $file
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$entries.Count)

$offset = 6 + ($entries.Count * 16)
foreach ($entry in $entries) {
  $sizeByte = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
  $writer.Write([byte]$sizeByte)
  $writer.Write([byte]$sizeByte)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$entry.Bytes.Length)
  $writer.Write([UInt32]$offset)
  $offset += $entry.Bytes.Length
}

foreach ($entry in $entries) {
  $imageBytes = [byte[]]$entry.Bytes
  $writer.Write($imageBytes, 0, $imageBytes.Length)
}

$writer.Dispose()
$file.Dispose()
Write-Output "Wrote icon: $resolvedOut"
