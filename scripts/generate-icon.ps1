param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\build\icon.png')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutputPath
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null

$size = 1024
$gridSize = 16
$cellSize = [int]($size / $gridSize)

$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::None
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$graphics.Clear([System.Drawing.Color]::FromArgb(43, 33, 24))

$shadowBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(182, 106, 44))
$fillBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(244, 232, 200))

$pixelRows = @(
  '................',
  '................',
  '...##....###....',
  '...##...###.....',
  '...##..###......',
  '...##.###.......',
  '...#####........',
  '...#####........',
  '...#####........',
  '...##.###.......',
  '...##..###......',
  '...##...###.....',
  '...##....###....',
  '...##.....###...',
  '................',
  '................'
)

$pixels = [System.Collections.Generic.List[object]]::new()
for ($y = 0; $y -lt $pixelRows.Length; $y++) {
  $row = $pixelRows[$y]
  for ($x = 0; $x -lt $row.Length; $x++) {
    if ($row[$x] -eq '#') {
      $pixels.Add([pscustomobject]@{ X = $x; Y = $y })
    }
  }
}

foreach ($pixel in $pixels) {
  if ($pixel.X -lt ($gridSize - 1) -and $pixel.Y -lt ($gridSize - 1)) {
    $graphics.FillRectangle($shadowBrush, ($pixel.X + 1) * $cellSize, ($pixel.Y + 1) * $cellSize, $cellSize, $cellSize)
  }
}

foreach ($pixel in $pixels) {
  $graphics.FillRectangle($fillBrush, $pixel.X * $cellSize, $pixel.Y * $cellSize, $cellSize, $cellSize)
}

$bitmap.Save($resolvedOutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$fillBrush.Dispose()
$shadowBrush.Dispose()
$graphics.Dispose()
$bitmap.Dispose()