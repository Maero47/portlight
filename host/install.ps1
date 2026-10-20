# Install the Portlight native messaging host on Windows (per user, no admin needed).
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [<extension-id> ...] [-AllBrowsers]
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Status
#
# Checks for Node.js 18+ (and offers to install it with winget), then runs
# `portlight-host install` from this folder, or from npm when run on its own
# (also when pasted into a terminal or piped into Invoke-Expression).
param(
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$AllBrowsers,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$ExtensionIds
)
$ErrorActionPreference = "Stop"

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  $major = [int](& $cmd.Source -p "process.versions.node.split('.')[0]")
  if ($major -lt 18) { Write-Host "Found Node.js $major at $($cmd.Source), but Portlight needs 18 or newer."; return $null }
  return $cmd.Source
}

# Returns the exit code. Everything is printed with Write-Host / Out-Host so that only
# the code comes back from the function.
function Invoke-Portlight {
  $node = Find-Node
  if (-not $node) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      Write-Host "Portlight needs Node.js 18 or newer. Install the LTS from https://nodejs.org, then run this again."
      return 1
    }
    $answer = Read-Host "Portlight needs Node.js 18 or newer. Install it now with 'winget install OpenJS.NodeJS.LTS'? [Y/n]"
    if ($answer -and $answer -notmatch '^[Yy]') {
      Write-Host "Run 'winget install OpenJS.NodeJS.LTS', open a new terminal, then run this again."
      return 1
    }
    winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-source-agreements --accept-package-agreements | Out-Host
    # winget updates PATH for new terminals only; pick it up here too.
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $node = Find-Node
    if (-not $node) { Write-Host "Node.js was installed but isn't on PATH yet. Open a new terminal and run this again."; return 1 }
  }

  if ($Uninstall) { $cliArgs = @("uninstall") }
  elseif ($Status) { $cliArgs = @("status") }
  else {
    $cliArgs = @("install")
    foreach ($id in $ExtensionIds) { $cliArgs += @("--extension-id", $id) }
    if ($AllBrowsers) { $cliArgs += "--all-browsers" }
  }

  # $PSScriptRoot is empty when pasted or piped: there is no local copy, so use npm.
  $main = if ($PSScriptRoot) { Join-Path $PSScriptRoot "src\main.js" } else { $null }
  if ($main -and (Test-Path $main)) {
    & $node $main @cliArgs | Out-Host
  } else {
    $npx = Join-Path (Split-Path $node) "npx.cmd"
    if (-not (Test-Path $npx)) { $npx = "npx" }
    & $npx --yes portlight-host@latest @cliArgs | Out-Host
  }
  return $LASTEXITCODE
}

$code = Invoke-Portlight
# Pasted or piped, `exit` would close the user's PowerShell window.
if ($PSScriptRoot) { exit $code }
