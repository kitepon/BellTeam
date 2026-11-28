#Requires -Version 7.0
<#
Replaces the downloads of the rolling GitHub release "windows-app" with the four files scripts/package-windows-app.ps1 built into -Dist.
-Commit is the commit the build came from: it must be an ancestor of origin/main; the release tag moves to it, like linux-app.
The release never becomes Latest: Latest is the server update catalog (scripts/container-update-host.py).
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Dist,
    [Parameter(Mandatory)][string]$Commit
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRepository = Split-Path -Parent $PSScriptRoot
$taskFiles = 'BellTeam-win-x64.zip', 'BellTeam-win-arm64.zip', 'install-windows.ps1', 'SHA256SUMS' | ForEach-Object { Join-Path $Dist $_ }
foreach ($taskFile in $taskFiles) { if (!(Test-Path -LiteralPath $taskFile)) { throw "$taskFile がありません。先に package-windows-app.ps1 で作ってください。" } }
& git -C $taskRepository fetch -q origin main
& git -C $taskRepository merge-base --is-ancestor $Commit origin/main
if ($LASTEXITCODE -ne 0) { throw "$Commit は origin/main の祖先ではありません。" }
$taskSha = (& git -C $taskRepository rev-parse $Commit).Trim()
$taskCsproj = (& git -C $taskRepository show "${taskSha}:windows/BellTeam.App/BellTeam.App.csproj") -join "`n"
$taskVersion = [regex]::Match($taskCsproj, '<Version>(.*?)</Version>').Groups[1].Value
if (!$taskVersion) { throw 'csprojの版を読めませんでした。' }
$taskRepo = 'kitepon/BellTeam'
$taskNotes = "BellTeam Windows app $taskVersion from $taskSha. Install or update (PowerShell 7): Invoke-WebRequest https://github.com/$taskRepo/releases/download/windows-app/install-windows.ps1 -OutFile $env:TEMP\install-bellteam.ps1; pwsh -NoProfile -File $env:TEMP\install-bellteam.ps1"
& gh release view windows-app --repo $taskRepo *> $null
if ($LASTEXITCODE -eq 0) {
    & gh api -X PATCH "repos/$taskRepo/git/refs/tags/windows-app" -f sha=$taskSha -F force=true | Out-Null
    & gh release upload windows-app @taskFiles --repo $taskRepo --clobber
    if ($LASTEXITCODE -ne 0) { throw 'アップロードに失敗しました。' }
    & gh release edit windows-app --repo $taskRepo --title "BellTeam Windows app $taskVersion" --notes $taskNotes --latest=false --prerelease=false
} else {
    & gh release create windows-app @taskFiles --repo $taskRepo --target $taskSha --title "BellTeam Windows app $taskVersion" --notes $taskNotes --latest=false
}
if ($LASTEXITCODE -ne 0) { throw '公開版の作成または更新に失敗しました。' }
Write-Output "https://github.com/$taskRepo/releases/tag/windows-app ($taskVersion, $taskSha)"
