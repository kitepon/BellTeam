#Requires -Version 7.0
# Builds the unsigned MSIX for Microsoft Store submission. The Store signs it; no certificate is used here.
# The identity values come from Partner Center > the app > Product identity (public values, not secrets).
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$IdentityName,
    [Parameter(Mandatory)][string]$Publisher,
    [Parameter(Mandatory)][string]$PublisherDisplayName,
    [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName PresentationCore
$taskRepository = Split-Path -Parent $PSScriptRoot
$taskProject = Join-Path $taskRepository 'windows\BellTeam.App\BellTeam.App.csproj'
$taskVersion = ([xml](Get-Content -LiteralPath $taskProject -Raw)).Project.PropertyGroup.Version
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw "csprojのVersionをMSIXの版にできません: $taskVersion" }
$taskOutput = Join-Path $taskRepository "windows\artifacts\store-win-$Architecture"
$taskLayout = Join-Path $taskOutput 'layout'
if (Test-Path -LiteralPath $taskLayout) { Remove-Item -LiteralPath $taskLayout -Recurse -Force }
& dotnet publish $taskProject -c Release -r "win-$Architecture" --self-contained true -o $taskLayout --nologo
if ($LASTEXITCODE -ne 0) { throw '.NET同梱ビルドに失敗しました。' }

# Store tile and logo images, rendered from the shared brand image like scripts/build-windows-icon.ps1.
$taskSource = [System.Windows.Media.Imaging.BitmapFrame]::Create([Uri](Join-Path $taskRepository 'ios\BellBot\BellBot\Assets.xcassets\AppIcon.appiconset\bellbot-icon.png'))
New-Item -ItemType Directory -Force -Path (Join-Path $taskLayout 'Assets') | Out-Null
foreach ($taskLogo in @(@{ Name = 'Square44x44Logo'; Size = 44 }, @{ Name = 'Square150x150Logo'; Size = 150 }, @{ Name = 'StoreLogo'; Size = 50 })) {
    $taskVisual = [System.Windows.Media.DrawingVisual]::new()
    [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($taskVisual, [System.Windows.Media.BitmapScalingMode]::HighQuality)
    $taskDrawing = $taskVisual.RenderOpen(); $taskDrawing.DrawImage($taskSource, [System.Windows.Rect]::new(0, 0, $taskLogo.Size, $taskLogo.Size)); $taskDrawing.Close()
    $taskBitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new($taskLogo.Size, $taskLogo.Size, 96, 96, [System.Windows.Media.PixelFormats]::Pbgra32); $taskBitmap.Render($taskVisual)
    $taskEncoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new(); $taskEncoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($taskBitmap))
    $taskFile = [IO.File]::Create((Join-Path $taskLayout "Assets\$($taskLogo.Name).png")); try { $taskEncoder.Save($taskFile) } finally { $taskFile.Dispose() }
}

$taskValues = @{ IdentityName = $IdentityName; Publisher = $Publisher; PublisherDisplayName = $PublisherDisplayName; Version = "$taskVersion.0"; Architecture = $Architecture }
$taskManifest = Get-Content -LiteralPath (Join-Path $taskRepository 'windows\BellTeam.App\Package\AppxManifest.xml') -Raw
foreach ($taskValue in $taskValues.GetEnumerator()) { $taskManifest = $taskManifest.Replace("{$($taskValue.Key)}", [Security.SecurityElement]::Escape($taskValue.Value)) }
if ($taskManifest -match '\{[A-Za-z]+\}') { throw "マニフェストに未設定の値があります: $($Matches[0])" }
Set-Content -LiteralPath (Join-Path $taskLayout 'AppxManifest.xml') -Value $taskManifest -Encoding utf8NoBOM

$taskHost = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$taskMakeAppx = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\$taskHost\makeappx.exe" -ErrorAction SilentlyContinue | Sort-Object { [version]$_.Directory.Parent.Name } | Select-Object -Last 1
if (!$taskMakeAppx) { throw 'Windows SDKのmakeappx.exeがありません。Windows SDKを公式installerで導入してください。' }
$taskPackage = Join-Path $taskOutput "BellTeam_$($taskValues.Version)_$Architecture.msix"
& $taskMakeAppx.FullName pack /d $taskLayout /p $taskPackage /o
if ($LASTEXITCODE -ne 0) { throw 'MSIXの作成に失敗しました。' }
Write-Output "Store提出用のMSIXを作成しました: $taskPackage"
