#requires -Version 7
<#
.SYNOPSIS
  Registers the installed BellTeam as a Windows share target (a283; Owner choice "sparse package", Approval Box 2026-11-16).
.DESCRIPTION
  The install folder stays as it is. This builds a sparse package (windows/Packaging/AppxManifest.xml) that points at it, signs it with a
  self-signed certificate (CN=BellTeam, created once in the current user's store), trusts that certificate once for this PC (the one step that needs
  administrator: a UAC prompt) and registers the package with -ExternalLocation. Afterwards BellTeam appears in the Windows share sheet.
  Needs the Windows SDK (makeappx.exe and signtool.exe). Run it again after moving the install folder; -Unregister removes the package and the certificate's trust on this PC (one more administrator prompt).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\BellTeam'),
  [switch]$Unregister
)
$ErrorActionPreference = 'Stop'
$packageName = 'BellTeam.Windows'; $subject = 'CN=BellTeam'
if ($Unregister) {
  Get-AppxPackage -Name $packageName | Remove-AppxPackage
  # The certificate's private key stays in your user store, so its trust on this PC goes too (the same single administrator prompt).
  $trusted = Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Subject -eq $subject
  foreach ($entry in $trusted) {
    Start-Process pwsh -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', "Remove-Item 'Cert:\LocalMachine\TrustedPeople\$($entry.Thumbprint)'"
    if (Test-Path "Cert:\LocalMachine\TrustedPeople\$($entry.Thumbprint)") { throw 'The package is removed, but the certificate is still trusted on this PC (the administrator prompt was declined). Run -Unregister again.' }
  }
  Write-Host 'BellTeam is no longer a share target, and its certificate is no longer trusted on this PC.'; return
}
if (-not (Test-Path (Join-Path $InstallDir 'BellTeam.exe'))) { throw "BellTeam is not installed in $InstallDir. Run scripts/install-windows.ps1 first." }

$repo = Split-Path -Parent $PSScriptRoot
$tools = Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\*\x64\makeappx.exe') -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $tools) { throw 'The Windows SDK is missing (makeappx.exe, signtool.exe). Install it with: winget install Microsoft.WindowsSDK.10.0.26100' }
$makeappx = $tools.FullName; $signtool = Join-Path $tools.DirectoryName 'signtool.exe'

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date).AddDays(30) } | Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $cert) {
  $cert = New-SelfSignedCertificate -Type Custom -Subject $subject -KeyUsage DigitalSignature -FriendlyName 'BellTeam share target' -CertStoreLocation Cert:\CurrentUser\My -NotAfter (Get-Date).AddYears(5) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
}
if (-not (Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $cert.Thumbprint)) {
  $cer = Join-Path $env:TEMP 'BellTeam-share.cer'; Export-Certificate -Cert $cert -FilePath $cer | Out-Null
  Write-Host 'Windows asks for administrator once, to trust the BellTeam certificate on this PC.'
  Start-Process pwsh -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', "Import-Certificate -FilePath '$cer' -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null"
  if (-not (Get-ChildItem Cert:\LocalMachine\TrustedPeople | Where-Object Thumbprint -eq $cert.Thumbprint)) { throw 'The certificate was not trusted (the administrator prompt was declined). Nothing was registered.' }
}

$stage = Join-Path $env:TEMP 'BellTeam-share-stage'; $msix = Join-Path $env:TEMP 'BellTeam-share.msix'
Remove-Item $stage, $msix -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory (Join-Path $stage 'Assets') | Out-Null
Copy-Item (Join-Path $repo 'windows\Packaging\AppxManifest.xml') $stage
Copy-Item (Join-Path $repo 'ios\BellBot\BellBot\Assets.xcassets\AppIcon.appiconset\bellbot-icon.png') (Join-Path $stage 'Assets\BellTeam.png')
& $makeappx pack /d $stage /p $msix /nv /o | Out-Host; if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)." }
& $signtool sign /fd SHA256 /sha1 $cert.Thumbprint $msix | Out-Host; if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)." }
Get-AppxPackage -Name $packageName | Remove-AppxPackage
Add-AppxPackage -Path $msix -ExternalLocation $InstallDir
Remove-Item $stage, $msix -Recurse -Force -ErrorAction SilentlyContinue
$package = Get-AppxPackage -Name $packageName
if (-not $package) { throw 'The package did not register.' }
Write-Host "Registered $($package.PackageFullName). BellTeam now appears in the Windows share sheet."
