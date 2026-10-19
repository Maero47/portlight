# Install the Portlight native messaging host on Windows (per user, no admin needed).
#   powershell -ExecutionPolicy Bypass -File install.ps1 <extension-id> [<extension-id> ...]
# Uninstall: powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
param(
  [switch]$Uninstall,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ExtensionIds
)
$ErrorActionPreference = "Stop"
$HostName = "com.portlight.host"
$InstallDir = Join-Path $env:LOCALAPPDATA "Portlight\host"
$RegRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\Vivaldi\NativeMessagingHosts"
)

if ($Uninstall) {
  foreach ($root in $RegRoots) {
    $key = Join-Path $root $HostName
    if (Test-Path $key) { Remove-Item $key -Recurse; Write-Output "  removed    $key" }
  }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Output "  removed    $InstallDir" }
  exit 0
}

if (-not $ExtensionIds) { Write-Error "usage: install.ps1 <extension-id> [...]"; exit 2 }
foreach ($id in $ExtensionIds) {
  if ($id -notmatch '^[a-p]{32}$') { Write-Error "'$id' is not a Chrome extension ID"; exit 2 }
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "node not found on PATH"; exit 1 }

$src = $PSScriptRoot
New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir "src") | Out-Null
Copy-Item (Join-Path $src "package.json") $InstallDir -Force
Copy-Item (Join-Path $src "src\*.js") (Join-Path $InstallDir "src") -Force
Write-Output "  wrote      $InstallDir (host files)"

$launcher = Join-Path $InstallDir "portlight-host.bat"
Set-Content -Path $launcher -Encoding ASCII -Value "@echo off`r`n`"$node`" `"%~dp0src\main.js`" %*"
Write-Output "  wrote      $launcher"

$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
  name = $HostName
  description = "Portlight: reports which localhost ports are in use"
  path = $launcher
  type = "stdio"
  allowed_origins = @($ExtensionIds | ForEach-Object { "chrome-extension://$_/" })
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8
Write-Output "  wrote      $manifestPath"

foreach ($root in $RegRoots) {
  $key = Join-Path $root $HostName
  New-Item -Path $key -Force | Out-Null
  Set-Item -Path $key -Value $manifestPath
  Write-Output "  wrote      $key"
}
