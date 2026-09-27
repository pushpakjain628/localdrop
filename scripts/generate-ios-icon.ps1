# Generates the LocalDrop iOS app icon.
#
# Draws the same mark as the Windows app - a download arrow into a tray - so the two halves of
# the product read as one thing. Written in code rather than committed as a binary so the icon
# is reproducible and reviewable.
#
# Requires only the .NET drawing assemblies that ship with Windows PowerShell:
#
#   powershell -ExecutionPolicy Bypass -File scripts/generate-ios-icon.ps1

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$target = Join-Path $PSScriptRoot '..\apps\ios\ios\LocalDrop\Assets.xcassets\AppIcon.appiconset\AppIcon-1024.png'
$targetDir = Split-Path -Parent $target
New-Item -ItemType Directory -Force -Path $targetDir | Out-Null

$size = 1024
$bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# iOS app icons must be a full square with no transparency and no rounded corners: the system
# applies the mask. A pre-rounded icon produces a double-rounded "squircle in a squircle".
$g.FillRectangle([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 47, 111, 237)), 0, 0, $size, $size)

# A soft vertical gradient keeps the flat blue from looking like a placeholder.
$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point(0, $size)),
    [System.Drawing.Color]::FromArgb(255, 60, 126, 245),
    [System.Drawing.Color]::FromArgb(255, 36, 78, 200)
)
$g.FillRectangle($gradient, 0, 0, $size, $size)

$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$scale = $size / 1024.0

# Downward arrow: the stem, the head, then the tray it lands in.
$stem = New-Object System.Drawing.RectangleF ([Single](430 * $scale)), ([Single](215 * $scale)), ([Single](164 * $scale)), ([Single](330 * $scale))
$g.FillRectangle($white, $stem)

$head = New-Object 'System.Drawing.PointF[]' 3
$head[0] = New-Object System.Drawing.PointF ([Single](300 * $scale)), ([Single](505 * $scale))
$head[1] = New-Object System.Drawing.PointF ([Single](724 * $scale)), ([Single](505 * $scale))
$head[2] = New-Object System.Drawing.PointF ([Single](512 * $scale)), ([Single](720 * $scale))
$g.FillPolygon($white, $head)

$trayBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
$tray = New-Object System.Drawing.RectangleF ([Single](300 * $scale)), ([Single](790 * $scale)), ([Single](424 * $scale)), ([Single](72 * $scale))
$g.FillRectangle($trayBrush, $tray)

$g.Dispose()
$bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

Write-Host "wrote $target"
