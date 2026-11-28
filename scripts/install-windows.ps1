#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [switch]$NoLaunch,
    [switch]$SkipShareTarget,
    [switch]$Uninstall,
    # a540: the Desktop Google OAuth client JSON (client_id + client_secret) arrives on stdin from scripts/windows-install-with-oauth.sh (auth exec on main-server). The secret goes only into the build's environment, never a commit or a log.
    [switch]$GoogleDesktopOAuthStdin,
    # Install the published build (GitHub release windows-app, .NET bundled) instead of building from this checkout. Chosen by itself when no source tree sits beside this script, i.e. when this file was downloaded from the release.
    [switch]$FromRelease
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRepository = Split-Path -Parent $PSScriptRoot
$taskInstall = Join-Path $env:LOCALAPPDATA 'Programs\BellTeam'

$taskFromRelease = $FromRelease -or !(Test-Path -LiteralPath (Join-Path $taskRepository 'windows\BellTeam.App\BellTeam.App.csproj'))
if ($Uninstall) {
    $taskUninstall = Join-Path $PSScriptRoot 'uninstall-windows.ps1'
    if (!(Test-Path -LiteralPath $taskUninstall)) { $taskUninstall = Join-Path $taskInstall 'uninstall-windows.ps1' }   # a downloaded installer: the one the install placed
    & $taskUninstall
    exit
}

$taskExe = Join-Path $taskInstall 'BellTeam.exe'
$taskRunning = Get-CimInstance Win32_Process -Filter "Name='BellTeam.exe'" | Where-Object { $_.ExecutablePath -eq $taskExe }
if ($taskRunning) { throw 'BellTeamを閉じてから入れ直してください。' }
$taskArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($taskArchitecture -notin @('x64', 'arm64')) { throw "対応していないCPUです: $taskArchitecture" }
if ($taskFromRelease) {
    # The published build: the zip is checked against SHA256SUMS of the same release before anything is installed. It carries datachannel.dll (x64) and was checked when it was packaged.
    $taskRelease = if ($env:BELLTEAM_WINDOWS_RELEASE) { $env:BELLTEAM_WINDOWS_RELEASE.TrimEnd('/') } else { 'https://github.com/kitepon/BellTeam/releases/download/windows-app' }
    $taskWork = Join-Path ([IO.Path]::GetTempPath()) ('bellteam-install-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $taskWork | Out-Null
    $taskZipName = "BellTeam-win-$taskArchitecture.zip"
    try {
        Invoke-WebRequest -Uri "$taskRelease/SHA256SUMS" -OutFile (Join-Path $taskWork 'SHA256SUMS') -ErrorAction Stop
        Invoke-WebRequest -Uri "$taskRelease/$taskZipName" -OutFile (Join-Path $taskWork $taskZipName) -ErrorAction Stop
    } catch { throw "公開版を取得できませんでした。何も入れていません。もう一度実行すると取り直します。理由: $($_.Exception.Message)" }
    $taskLine = Get-Content -LiteralPath (Join-Path $taskWork 'SHA256SUMS') | Where-Object { $_ -match ('\s\*?' + [regex]::Escape($taskZipName) + '$') } | Select-Object -First 1
    $taskExpected = if ($taskLine) { ($taskLine -split '\s+')[0].ToLowerInvariant() } else { $null }
    if (!$taskExpected -or (Get-FileHash -LiteralPath (Join-Path $taskWork $taskZipName) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected) { throw "$taskZipName のSHA-256がSHA256SUMSと合いません。何も入れていません。" }
    $taskPublish = Join-Path $taskWork 'app'
    Expand-Archive -LiteralPath (Join-Path $taskWork $taskZipName) -DestinationPath $taskPublish -Force
} else {
    $taskPublish = Join-Path $taskRepository "windows\artifacts\publish-win-$taskArchitecture"
    if ($GoogleDesktopOAuthStdin) {
        # The catch hides the parser's message so no part of the JSON can reach a log.
        try { $env:BELLTEAM_GOOGLE_DESKTOP_SECRET = ([Console]::In.ReadToEnd() | ConvertFrom-Json).installed.client_secret } catch { $env:BELLTEAM_GOOGLE_DESKTOP_SECRET = $null }
        if (!$env:BELLTEAM_GOOGLE_DESKTOP_SECRET) { throw 'Google Desktopクライアントの秘密を標準入力から読めませんでした（値は表示しません）。' }
    }
    & dotnet publish (Join-Path $taskRepository 'windows\BellTeam.App\BellTeam.App.csproj') -c Release -r "win-$taskArchitecture" --self-contained true -o $taskPublish --nologo
    $taskPublishExit = $LASTEXITCODE
    Remove-Item Env:BELLTEAM_GOOGLE_DESKTOP_SECRET -ErrorAction SilentlyContinue
    if ($taskPublishExit -ne 0) { throw '.NET同梱ビルドに失敗しました。' }

    # The prebuilt libdatachannel of the Approval Box device part (windows/native/README.md): never built on this machine, placed with the app only when its SHA-256 matches the committed one.
    $taskDll = Join-Path $taskPublish 'datachannel.dll'
    if ($taskArchitecture -eq 'x64') {
        $taskDllHash = (Get-Content -LiteralPath (Join-Path $taskRepository 'windows\native\prebuilt\win-x64\datachannel.dll.sha256') -Raw).Trim()
        if (!(Test-Path -LiteralPath $taskDll) -or (Get-FileHash -LiteralPath $taskDll -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskDllHash) { throw 'datachannel.dllがありません、またはSHA-256が一致しません。' }
    } else {
        Write-Warning '決裁箱の端末部品（datachannel.dll）はarm64用がまだ無いため入れていません。'
    }
}

if ($ServerUrl) {
    $taskConfigure = Start-Process -FilePath (Join-Path $taskPublish 'BellTeam.exe') -ArgumentList @('--configure', $ServerUrl) -WindowStyle Hidden -Wait -PassThru
    if ($taskConfigure.ExitCode -ne 0) { throw '接続先を保存できませんでした。HTTPS、またはlocalhost・LANのHTTP接続先URLを指定してください。' }
}

New-Item -ItemType Directory -Force -Path $taskInstall | Out-Null
Get-ChildItem -LiteralPath $taskPublish | Copy-Item -Destination $taskInstall -Recurse -Force
if (!$taskFromRelease) {   # the published zip already carries uninstall-windows.ps1; the share-in registration needs this checkout (windows\Packaging) and the Windows SDK, so a downloaded install has none
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-windows.ps1') -Destination (Join-Path $taskInstall 'uninstall-windows.ps1') -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'register-windows-share-target.ps1') -Destination (Join-Path $taskInstall 'register-windows-share-target.ps1') -Force
}
$taskShortcutInstall = Start-Process -FilePath $taskExe -ArgumentList '--install-shortcut' -WindowStyle Hidden -Wait -PassThru
if ($taskShortcutInstall.ExitCode -ne 0) { throw 'BellTeamのスタートメニュー登録に失敗しました。' }

$taskRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BellTeam'
New-Item -Path $taskRegistry -Force | Out-Null
$taskPwsh = (Get-Command pwsh.exe).Source
$taskUninstaller = Join-Path $taskInstall 'uninstall-windows.ps1'
$taskVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($taskExe).ProductVersion.Split('+')[0]
$taskValues = @{
    DisplayName = 'BellTeam'; Publisher = 'kitepon'; DisplayVersion = $taskVersion
    InstallLocation = $taskInstall; DisplayIcon = $taskExe
    UninstallString = "`"$taskPwsh`" -NoProfile -File `"$taskUninstaller`""
    QuietUninstallString = "`"$taskPwsh`" -NoProfile -File `"$taskUninstaller`""
}
foreach ($taskValue in $taskValues.GetEnumerator()) { New-ItemProperty -Path $taskRegistry -Name $taskValue.Key -Value $taskValue.Value -PropertyType String -Force | Out-Null }
New-ItemProperty -Path $taskRegistry -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
New-ItemProperty -Path $taskRegistry -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
Write-Output "BellTeamを導入しました: $taskInstall"
if ($taskFromRelease) { Remove-Item -LiteralPath $taskWork -Recurse -Force -ErrorAction SilentlyContinue }
if (!$SkipShareTarget -and !$taskFromRelease) {
    # Share-in (a283): the one UAC prompt trusts the signing certificate. Without the Windows SDK nothing is registered, and the message says how to add it.
    if (Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\*\x64\makeappx.exe') -ErrorAction SilentlyContinue) {
        try { & (Join-Path $PSScriptRoot 'register-windows-share-target.ps1') -InstallDir $taskInstall }
        catch { Write-Warning "他のアプリからの「共有」先には登録できませんでした（管理者の確認を断った場合を含む）。BellTeam本体は導入済みです。登録だけをやり直すには scripts/register-windows-share-target.ps1 を実行します。理由: $($_.Exception.Message)" }
    } else {
        Write-Warning '他のアプリからの「共有」先には登録していません: Windows SDKがありません。winget install Microsoft.WindowsSDK.10.0.26100 のあと、もう一度この導入を実行してください。共有先が要らない場合は -SkipShareTarget を付けます。'
    }
}
if (!$NoLaunch) { Start-Process -FilePath $taskExe -WindowStyle Normal }
