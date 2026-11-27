#Requires -Version 7.0
<#
Builds the published Windows app downloads into -Out: one self-contained zip per CPU (BellTeam-win-x64.zip, BellTeam-win-arm64.zip), SHA256SUMS and install-windows.ps1.
Only those four files in -Out are replaced; anything else there is left as it is.
The Desktop Google OAuth client JSON (the secret goes into the build, never into git or a log) arrives on stdin from scripts/windows-install-with-oauth.sh --package (auth exec on main-server, the authentication module).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Out,
    [switch]$GoogleDesktopOAuthStdin
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (!$GoogleDesktopOAuthStdin) { throw 'Googleのデスクトップ用クライアントの値が要ります。auth exec /home/kite/BellTeam/scripts/windows-install-with-oauth.sh --package <出力先> から実行してください。' }
$taskRepository = Split-Path -Parent $PSScriptRoot
Add-Type -AssemblyName System.IO.Compression.FileSystem
# The catch hides the parser's message so no part of the JSON can reach a log.
try { $env:BELLTEAM_GOOGLE_DESKTOP_SECRET = ([Console]::In.ReadToEnd() | ConvertFrom-Json).installed.client_secret } catch { $env:BELLTEAM_GOOGLE_DESKTOP_SECRET = $null }
if (!$env:BELLTEAM_GOOGLE_DESKTOP_SECRET) { throw 'Google Desktopクライアントの秘密を標準入力から読めませんでした（値は表示しません）。' }
$taskWork = Join-Path ([IO.Path]::GetTempPath()) ('bellteam-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $taskWork | Out-Null
try {
    foreach ($taskRid in 'win-x64', 'win-arm64') {
        $taskApp = Join-Path $taskWork "build-$taskRid"
        & dotnet publish (Join-Path $taskRepository 'windows\BellTeam.App\BellTeam.App.csproj') -c Release -r $taskRid --self-contained true -o $taskApp --nologo
        if ($LASTEXITCODE -ne 0) { throw ".NET同梱ビルドに失敗しました（$taskRid）。" }
        if ($taskRid -eq 'win-x64') {
            # The prebuilt libdatachannel (windows/native/README.md): shipped only when its SHA-256 matches the committed one, as install-windows.ps1 checks.
            $taskDllHash = (Get-Content -LiteralPath (Join-Path $taskRepository 'windows\native\prebuilt\win-x64\datachannel.dll.sha256') -Raw).Trim()
            $taskDll = Join-Path $taskApp 'datachannel.dll'
            if (!(Test-Path -LiteralPath $taskDll) -or (Get-FileHash -LiteralPath $taskDll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDllHash) { throw 'datachannel.dllがありません、またはSHA-256が一致しません。' }
        }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-windows.ps1') -Destination $taskApp -Force
        [IO.Compression.ZipFile]::CreateFromDirectory($taskApp, (Join-Path $taskWork "BellTeam-$taskRid.zip"), [IO.Compression.CompressionLevel]::Optimal, $false)
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-windows.ps1') -Destination $taskWork -Force
    $taskNames = 'BellTeam-win-x64.zip', 'BellTeam-win-arm64.zip', 'install-windows.ps1'
    $taskSums = foreach ($taskName in $taskNames) { (Get-FileHash -LiteralPath (Join-Path $taskWork $taskName) -Algorithm SHA256).Hash.ToLowerInvariant() + ' *' + $taskName }
    [IO.File]::WriteAllText((Join-Path $taskWork 'SHA256SUMS'), (($taskSums -join "`n") + "`n"))
    New-Item -ItemType Directory -Force -Path $Out | Out-Null
    foreach ($taskName in $taskNames + 'SHA256SUMS') { Move-Item -LiteralPath (Join-Path $taskWork $taskName) -Destination (Join-Path $Out $taskName) -Force }
    Write-Output "BellTeamの配布物を作りました: $Out"
} finally {
    Remove-Item Env:BELLTEAM_GOOGLE_DESKTOP_SECRET -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $taskWork -Recurse -Force -ErrorAction SilentlyContinue
}
