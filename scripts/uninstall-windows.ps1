#Requires -Version 7.0
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskInstall = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\BellTeam'))
$taskExpectedParent = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
if ([IO.Path]::GetDirectoryName($taskInstall) -ne $taskExpectedParent -or [IO.Path]::GetFileName($taskInstall) -ne 'BellTeam') { throw 'BellTeamの導入先を特定できません。' }
$taskExe = Join-Path $taskInstall 'BellTeam.exe'
if (Get-CimInstance Win32_Process -Filter "Name='BellTeam.exe'" | Where-Object { $_.ExecutablePath -eq $taskExe }) { throw 'BellTeamを閉じてからアンインストールしてください。' }
$taskMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'BellTeam.lnk'
if (Test-Path -LiteralPath $taskMenu) { Remove-Item -LiteralPath $taskMenu }
$taskRegistry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BellTeam'
if (Test-Path -LiteralPath $taskRegistry) { Remove-Item -LiteralPath $taskRegistry }
if (Test-Path -LiteralPath $taskInstall) { Remove-Item -LiteralPath $taskInstall -Recurse -Force }
Write-Output 'BellTeamを削除しました。接続先と窓の設定は、このPCのLocalAppData\BellTeamに保持しています。'
