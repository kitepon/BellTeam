#Requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSource = Join-Path $taskRoot 'ios\BellBot\BellBot\Assets.xcassets\AppIcon.appiconset\bellbot-icon.png'
$taskOutput = Join-Path $taskRoot 'windows\BellTeam.App\Assets\BellTeam.ico'
$taskImage = [System.Windows.Media.Imaging.BitmapFrame]::Create([Uri]$taskSource)
$taskSizes = @(16, 20, 24, 32, 40, 48, 64, 256)
$taskFrames = foreach ($taskSize in $taskSizes) {
    $taskVisual = [System.Windows.Media.DrawingVisual]::new()
    [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($taskVisual, [System.Windows.Media.BitmapScalingMode]::HighQuality)
    $taskDrawing = $taskVisual.RenderOpen()
    $taskDrawing.DrawImage($taskImage, [System.Windows.Rect]::new(0, 0, $taskSize, $taskSize))
    $taskDrawing.Close()
    $taskBitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new($taskSize, $taskSize, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32)
    $taskBitmap.Render($taskVisual)
    $taskStream = [IO.MemoryStream]::new()
    $taskWriter = [IO.BinaryWriter]::new($taskStream)
    if ($taskSize -eq 256) {
        $taskEncoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
        $taskEncoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($taskBitmap))
        $taskEncoder.Save($taskStream)
    } else {
        $taskPixels = [byte[]]::new($taskSize * $taskSize * 4)
        $taskConverted = [System.Windows.Media.Imaging.FormatConvertedBitmap]::new($taskBitmap, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
        $taskConverted.CopyPixels($taskPixels, $taskSize * 4, 0)
        $taskMask = [byte[]]::new([int]([Math]::Ceiling($taskSize / 32.0) * 4 * $taskSize))
        # ICOのDIBは下から上へ並べ、色32bitと透過マスクを格納する。
        $taskWriter.Write([int]40); $taskWriter.Write([int]$taskSize); $taskWriter.Write([int]($taskSize * 2))
        $taskWriter.Write([int16]1); $taskWriter.Write([int16]32); $taskWriter.Write([int]0)
        $taskWriter.Write([int]($taskPixels.Length + $taskMask.Length))
        1..4 | ForEach-Object { $taskWriter.Write([int]0) }
        for ($taskRow = $taskSize - 1; $taskRow -ge 0; $taskRow--) { $taskWriter.Write($taskPixels, $taskRow * $taskSize * 4, $taskSize * 4) }
        $taskWriter.Write($taskMask)
    }
    $taskWriter.Flush()
    ,$taskStream.ToArray()
    $taskWriter.Dispose(); $taskStream.Dispose()
}
$taskFile = [IO.File]::Create($taskOutput)
$taskIcon = [IO.BinaryWriter]::new($taskFile)
try {
    $taskIcon.Write([int16]0); $taskIcon.Write([int16]1); $taskIcon.Write([int16]$taskSizes.Count)
    $taskOffset = 6 + 16 * $taskSizes.Count
    for ($taskIndex = 0; $taskIndex -lt $taskSizes.Count; $taskIndex++) {
        $taskDimension = if ($taskSizes[$taskIndex] -eq 256) { 0 } else { $taskSizes[$taskIndex] }
        $taskIcon.Write([byte]$taskDimension); $taskIcon.Write([byte]$taskDimension); $taskIcon.Write([byte]0); $taskIcon.Write([byte]0)
        $taskIcon.Write([int16]1); $taskIcon.Write([int16]32); $taskIcon.Write([int]$taskFrames[$taskIndex].Length); $taskIcon.Write([int]$taskOffset)
        $taskOffset += $taskFrames[$taskIndex].Length
    }
    foreach ($taskFrame in $taskFrames) { $taskIcon.Write([byte[]]$taskFrame) }
} finally { $taskIcon.Dispose(); $taskFile.Dispose() }
Write-Output "32bitの8サイズのアイコンを作成しました: $taskOutput"
