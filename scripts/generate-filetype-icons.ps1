param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\src-tauri\icons\filetypes')
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$types = @(
  @{ Name = 'video'; Label = 'VID'; Glyph = 'play'; AccentA = [System.Drawing.Color]::FromArgb(255, 164, 234, 208); AccentB = [System.Drawing.Color]::FromArgb(255, 237, 197, 120) },
  @{ Name = 'audio'; Label = 'AUD'; Glyph = 'note'; AccentA = [System.Drawing.Color]::FromArgb(255, 176, 231, 255); AccentB = [System.Drawing.Color]::FromArgb(255, 164, 234, 208) },
  @{ Name = 'image'; Label = 'IMG'; Glyph = 'image'; AccentA = [System.Drawing.Color]::FromArgb(255, 177, 233, 190); AccentB = [System.Drawing.Color]::FromArgb(255, 135, 191, 252) },
  @{ Name = 'pdf'; Label = 'PDF'; Glyph = 'page'; AccentA = [System.Drawing.Color]::FromArgb(255, 255, 174, 160); AccentB = [System.Drawing.Color]::FromArgb(255, 237, 197, 120) },
  @{ Name = 'text'; Label = 'TXT'; Glyph = 'code'; AccentA = [System.Drawing.Color]::FromArgb(255, 205, 188, 255); AccentB = [System.Drawing.Color]::FromArgb(255, 164, 234, 208) },
  @{ Name = 'word'; Label = 'DOC'; Glyph = 'doc'; AccentA = [System.Drawing.Color]::FromArgb(255, 164, 203, 255); AccentB = [System.Drawing.Color]::FromArgb(255, 164, 234, 208) }
)

function Add-RoundedRect {
  param(
    [System.Drawing.Drawing2D.GraphicsPath]$Path,
    [System.Drawing.RectangleF]$Rect,
    [double]$Radius
  )
  $diameter = $Radius * 2
  $Path.AddArc($Rect.X, $Rect.Y, $diameter, $diameter, 180, 90)
  $Path.AddArc(($Rect.Right - $diameter), $Rect.Y, $diameter, $diameter, 270, 90)
  $Path.AddArc(($Rect.Right - $diameter), ($Rect.Bottom - $diameter), $diameter, $diameter, 0, 90)
  $Path.AddArc($Rect.X, ($Rect.Bottom - $diameter), $diameter, $diameter, 90, 90)
  $Path.CloseFigure()
}

function Draw-CenteredText {
  param(
    [System.Drawing.Graphics]$Graphics,
    [string]$Text,
    [System.Drawing.RectangleF]$Rect,
    [float]$FontSize,
    [System.Drawing.Color]$Color,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Bold
  )
  $font = New-Object System.Drawing.Font 'Segoe UI', $FontSize, $Style, ([System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $brush = New-Object System.Drawing.SolidBrush $Color
  $Graphics.DrawString($Text, $font, $brush, $Rect, $format)
  $brush.Dispose()
  $format.Dispose()
  $font.Dispose()
}

function New-FileTypeBitmap {
  param(
    [int]$Size,
    [hashtable]$Spec
  )

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)

  $padding = [Math]::Max(2, [Math]::Round($Size * 0.055))
  $rect = New-Object System.Drawing.RectangleF $padding, $padding, ($Size - $padding * 2), ($Size - $padding * 2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect -Path $path -Rect $rect -Radius ($Size * 0.22)

  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect,
    ([System.Drawing.Color]::FromArgb(255, 7, 12, 14)),
    ([System.Drawing.Color]::FromArgb(255, 25, 31, 32)),
    38
  $graphics.FillPath($bg, $path)

  $glowRect = New-Object System.Drawing.RectangleF ($Size * -0.08), ($Size * -0.06), ($Size * 0.92), ($Size * 0.92)
  $glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $glowPath.AddEllipse($glowRect)
  $glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $glowPath
  $glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(205, $Spec.AccentA.R, $Spec.AccentA.G, $Spec.AccentA.B)
  $glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $Spec.AccentA.R, $Spec.AccentA.G, $Spec.AccentA.B))
  $graphics.FillPath($glowBrush, $glowPath)

  $warmRect = New-Object System.Drawing.RectangleF ($Size * 0.36), ($Size * 0.36), ($Size * 0.84), ($Size * 0.84)
  $warmPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $warmPath.AddEllipse($warmRect)
  $warmBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush $warmPath
  $warmBrush.CenterColor = [System.Drawing.Color]::FromArgb(185, $Spec.AccentB.R, $Spec.AccentB.G, $Spec.AccentB.B)
  $warmBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $Spec.AccentB.R, $Spec.AccentB.G, $Spec.AccentB.B))
  $graphics.FillPath($warmBrush, $warmPath)

  $panelRect = New-Object System.Drawing.RectangleF ($Size * 0.19), ($Size * 0.18), ($Size * 0.62), ($Size * 0.58)
  $panelPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  Add-RoundedRect -Path $panelPath -Rect $panelRect -Radius ($Size * 0.105)
  $panelBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $panelRect, $Spec.AccentA, $Spec.AccentB, 135
  $graphics.FillPath($panelBrush, $panelPath)

  $ink = [System.Drawing.Color]::FromArgb(255, 7, 12, 14)
  $inkBrush = New-Object System.Drawing.SolidBrush $ink
  $inkPen = New-Object System.Drawing.Pen $ink, ([Math]::Max(2, $Size * 0.028))
  $white = [System.Drawing.Color]::FromArgb(232, 247, 242, 235)

  switch ($Spec.Glyph) {
    'play' {
      $tri = New-Object System.Drawing.Drawing2D.GraphicsPath
      $tri.AddPolygon(@(
        (New-Object System.Drawing.PointF ($Size * 0.44), ($Size * 0.34)),
        (New-Object System.Drawing.PointF ($Size * 0.44), ($Size * 0.60)),
        (New-Object System.Drawing.PointF ($Size * 0.65), ($Size * 0.47))
      ))
      $graphics.FillPath($inkBrush, $tri)
      $tri.Dispose()
    }
    'note' {
      $graphics.DrawLine($inkPen, ($Size * 0.53), ($Size * 0.30), ($Size * 0.53), ($Size * 0.57))
      $graphics.DrawLine($inkPen, ($Size * 0.53), ($Size * 0.30), ($Size * 0.68), ($Size * 0.36))
      $graphics.FillEllipse($inkBrush, ($Size * 0.34), ($Size * 0.51), ($Size * 0.19), ($Size * 0.14))
    }
    'image' {
      $pictureRect = New-Object System.Drawing.RectangleF ($Size * 0.31), ($Size * 0.32), ($Size * 0.39), ($Size * 0.30)
      $graphics.DrawRectangle($inkPen, $pictureRect.X, $pictureRect.Y, $pictureRect.Width, $pictureRect.Height)
      $mountain = New-Object System.Drawing.Drawing2D.GraphicsPath
      $mountain.AddPolygon(@(
        (New-Object System.Drawing.PointF ($Size * 0.33), ($Size * 0.58)),
        (New-Object System.Drawing.PointF ($Size * 0.45), ($Size * 0.45)),
        (New-Object System.Drawing.PointF ($Size * 0.53), ($Size * 0.53)),
        (New-Object System.Drawing.PointF ($Size * 0.60), ($Size * 0.46)),
        (New-Object System.Drawing.PointF ($Size * 0.69), ($Size * 0.58))
      ))
      $graphics.DrawPath($inkPen, $mountain)
      $mountain.Dispose()
    }
    'page' {
      Draw-CenteredText -Graphics $graphics -Text 'PDF' -Rect $panelRect -FontSize ([float]($Size * 0.16)) -Color $ink
    }
    'code' {
      Draw-CenteredText -Graphics $graphics -Text '<>' -Rect $panelRect -FontSize ([float]($Size * 0.22)) -Color $ink
    }
    'doc' {
      Draw-CenteredText -Graphics $graphics -Text 'DOC' -Rect $panelRect -FontSize ([float]($Size * 0.16)) -Color $ink
    }
  }

  if ($Size -ge 64) {
    $labelRect = New-Object System.Drawing.RectangleF ($Size * 0.08), ($Size * 0.75), ($Size * 0.84), ($Size * 0.15)
    Draw-CenteredText -Graphics $graphics -Text $Spec.Label -Rect $labelRect -FontSize ([float]($Size * 0.105)) -Color $white
  }

  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(95, 255, 255, 255)), ([Math]::Max(1, $Size * 0.018))
  $graphics.DrawPath($borderPen, $path)

  $borderPen.Dispose()
  $inkPen.Dispose()
  $inkBrush.Dispose()
  $panelBrush.Dispose()
  $panelPath.Dispose()
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

function Write-Ico {
  param(
    [string]$Path,
    [hashtable]$Spec
  )

  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $entries = @()
  foreach ($size in $sizes) {
    $bitmap = New-FileTypeBitmap -Size $size -Spec $Spec
    $bytes = Get-IconDibBytes -Bitmap $bitmap
    $entries += [pscustomobject]@{ Size = $size; Bytes = $bytes }
    $bitmap.Dispose()
  }

  $file = [System.IO.File]::Create($Path)
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
}

$resolvedOutDir = [System.IO.Path]::GetFullPath($OutDir)
if (!(Test-Path $resolvedOutDir)) {
  New-Item -ItemType Directory -Path $resolvedOutDir -Force | Out-Null
}

foreach ($type in $types) {
  $path = Join-Path $resolvedOutDir "$($type.Name).ico"
  Write-Ico -Path $path -Spec $type
  Write-Output "Wrote filetype icon: $path"
}
