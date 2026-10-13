#Requires -Version 7.0
[CmdletBinding()]
param(
    [string]$ServerUrl,
    [switch]$NoLaunch,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRepository = Split-Path -Parent $PSScriptRoot
$taskInstall = Join-Path $env:LOCALAPPDATA 'Programs\BellTeam'

if ($Uninstall) {
    & (Join-Path $PSScriptRoot 'uninstall-windows.ps1')
    exit
}

$taskExe = Join-Path $taskInstall 'BellTeam.exe'
$taskRunning = Get-CimInstance Win32_Process -Filter "Name='BellTeam.exe'" | Where-Object { $_.ExecutablePath -eq $taskExe }
if ($taskRunning) { throw 'BellTeamを閉じてから入れ直してください。' }
$taskArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($taskArchitecture -notin @('x64', 'arm64')) { throw "対応していないCPUです: $taskArchitecture" }
$taskPublish = Join-Path $taskRepository "windows\artifacts\publish-win-$taskArchitecture"
& dotnet publish (Join-Path $taskRepository 'windows\BellTeam.App\BellTeam.App.csproj') -c Release -r "win-$taskArchitecture" --self-contained true -o $taskPublish --nologo
if ($LASTEXITCODE -ne 0) { throw '.NET同梱ビルドに失敗しました。' }

if ($ServerUrl) {
    $taskConfigure = Start-Process -FilePath (Join-Path $taskPublish 'BellTeam.exe') -ArgumentList @('--configure', $ServerUrl) -WindowStyle Hidden -Wait -PassThru
    if ($taskConfigure.ExitCode -ne 0) { throw '接続先を保存できませんでした。HTTPS、またはlocalhost・LANのHTTP接続先URLを指定してください。' }
}

New-Item -ItemType Directory -Force -Path $taskInstall | Out-Null
Get-ChildItem -LiteralPath $taskPublish | Copy-Item -Destination $taskInstall -Recurse -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'uninstall-windows.ps1') -Destination (Join-Path $taskInstall 'uninstall-windows.ps1') -Force
$taskMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'BellTeam.lnk'
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcut = $taskShell.CreateShortcut($taskMenu)
$taskShortcut.TargetPath = $taskExe
$taskShortcut.IconLocation = "$taskExe,0"
$taskShortcut.WorkingDirectory = $taskInstall
$taskShortcut.Description = 'BellTeam'
$taskShortcut.Save()
[System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($taskShell) | Out-Null

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
if (!$NoLaunch) { Start-Process -FilePath $taskExe -WindowStyle Normal }
