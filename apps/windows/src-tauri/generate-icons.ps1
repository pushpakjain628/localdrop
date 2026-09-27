# Generates the LocalDrop application icon.
#
# Draws the mark in code rather than shipping a binary blob: the icon is simple geometry, and
# this keeps the repository free of opaque assets while staying reproducible. Run from the
# repository root:
#
#   powershell -ExecutionPolicy Bypass -File apps/windows/src-tauri/generate-icons.ps1
#
# Output: apps/windows/src-tauri/icons/icon.png and icon.ico

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot 'icons'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-Mark([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = $size / 512.0

    # Rounded-square backdrop with a subtle vertical gradient.
    $radius = 112 * $s
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $size
    $arc = $radius
    $path.AddArc(0, 0, $arc, $arc, 180, 90)
    $path.AddArc($d - $arc, 0, $arc, $arc, 270, 90)
    $path.AddArc($d - $arc, $d - $arc, $arc, $arc, 0, 90)
    $path.AddArc(0, $d - $arc, $arc, $arc, 90, 90)
    $path.CloseFigure()

    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point(0, $d)),
        [System.Drawing.Color]::FromArgb(255, 79, 124, 255),
        [System.Drawing.Color]::FromArgb(255, 43, 88, 208)
    )
    $g.FillPath($gradient, $path)

    # White arrow pointing down into a tray: "backed up to the PC".
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $stem = New-Object System.Drawing.RectangleF ([Single](232 * $s)), ([Single](120 * $s)), ([Single](48 * $s)), ([Single](150 * $s))
    $head = New-Object 'System.Drawing.PointF[]' 3
    $head[0] = New-Object System.Drawing.PointF ([Single](160 * $s)), ([Single](250 * $s))
    $head[1] = New-Object System.Drawing.PointF ([Single](352 * $s)), ([Single](250 * $s))
    $head[2] = New-Object System.Drawing.PointF ([Single](256 * $s)), ([Single](348 * $s))
    $g.FillRectangle($white, $stem)
    $g.FillPolygon($white, $head)

    # Tray the arrow lands in.
    $trayBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 255, 255, 255))
    $tray = New-Object System.Drawing.RectangleF ([Single](150 * $s)), ([Single](378 * $s)), ([Single](212 * $s)), ([Single](34 * $s))
    $g.FillRectangle($trayBrush, $tray)

    $g.Dispose()
    return $bmp
}

# 512px PNG for the bundler and the window.
$png = Join-Path $outDir 'icon.png'
$mark = New-Mark 512
$mark.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$mark.Dispose()
Write-Host "wrote $png"

# ICO containing 16/32/48/64/128/256 px images. Vista+ reads PNG-compressed entries directly,
# which keeps this small and avoids needing a separate encoder.
$ico = Join-Path $outDir 'icon.ico'
$sizes = @(16, 32, 48, 64, 128, 256)
$images = @()
foreach ($size in $sizes) {
    $bmp = New-Mark $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += ,@{ Bytes = $ms.ToArray(); Size = $size }
    $bmp.Dispose()
    $ms.Dispose()
}

$stream = [System.IO.File]::Create($ico)
$writer = New-Object System.IO.BinaryWriter($stream)

# ICONDIR
$writer.Write([UInt16]0)      # reserved
$writer.Write([UInt16]1)      # type: icon
$writer.Write([UInt16]$images.Count)

# ICONDIRENTRY per image
$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { [byte]0 } else { [byte]$img.Size }
    $writer.Write($dim)                                  # width
    $writer.Write($dim)                                  # height
    $writer.Write([byte]0)                               # palette
    $writer.Write([byte]0)                               # reserved
    $writer.Write([UInt16]1)                             # colour planes
    $writer.Write([UInt16]32)                            # bits per pixel
    $writer.Write([UInt32]$img.Bytes.Length)             # size
    $writer.Write([UInt32]$offset)                       # offset
    $offset += $img.Bytes.Length
}

foreach ($img in $images) {
    $writer.Write($img.Bytes)
}

$writer.Dispose()
$stream.Dispose()
Write-Host "wrote $ico"
