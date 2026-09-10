param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# Card #268: run the real installation flow in a temporary tree. Only Windows
# integration and the service CLI are fixtures; no installed app/service is used.
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($statement in $ast.EndBlock.Statements) {
  if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
    Invoke-Expression $statement.Extent.Text
  }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('alu-setup-regression-' + [guid]::NewGuid().ToString('N'))
$ProductRoot = Join-Path $testRoot 'installed'
$InstallRoot = Join-Path $ProductRoot 'app'
$NextRoot = "$InstallRoot.next"
$PreviousRoot = "$InstallRoot.previous"
$InstallJournal = Join-Path $ProductRoot 'install-transaction.json'
$Source = Join-Path $testRoot 'source'
$BinRoot = Join-Path $ProductRoot 'bin'
$GlobalLauncher = Join-Path $BinRoot 'aludock.cmd'
$StartMenuShortcut = Join-Path $testRoot 'Start Menu.lnk'
$DesktopExecutable = Join-Path $InstallRoot 'AluDock.exe'
$registration = Join-Path $testRoot 'registration.txt'
$script:startupFails = $true
$script:heldFile = $null

function Assert-DesktopStopped {}
function Assert-IntegrationAvailable {}
function Assert-SystemNode([string]$Launcher) {}
function Set-GlobalLauncher {
  New-Item -ItemType Directory -Path $BinRoot -Force | Out-Null
  Set-Content -LiteralPath $GlobalLauncher -Value $InstallRoot
}
function Set-UserPathEntry([string]$Entry, [bool]$Present) {}
function Set-StartMenuShortcut { Set-Content -LiteralPath $StartMenuShortcut -Value $DesktopExecutable }
function Set-UninstallRegistration([string]$Version) { Set-Content -LiteralPath $registration -Value $Version }
function Remove-InstalledIntegration { Remove-Item -LiteralPath $StartMenuShortcut -Force -ErrorAction SilentlyContinue }
function Start-InstalledDesktop {}
function Invoke-AluDock([string]$Launcher, [string[]]$Arguments) {
  if ($Arguments[1] -eq 'stop') { return [pscustomobject]@{ready=$false} }
  if ($script:startupFails) {
    # The actual incident held a native library while Setup tried deleting the
    # still-starting Host's files. FileShare excludes Delete, as on that machine.
    $script:heldFile = [IO.File]::Open((Join-Path $InstallRoot 'clipboard.node'), 'Open', 'Read', 'ReadWrite')
    throw 'Alu Dock did not finish starting.'
  }
  return [pscustomobject]@{ready=$true}
}

try {
  foreach ($tree in @($Source, $InstallRoot)) {
    foreach ($file in @('AluDock.exe','aludock.cmd','Uninstall.cmd','LICENSE-APACHE','dock\dist\src\cli.js','dock\node_modules\pi\dist\cli.js','support\windows-package.ps1','clipboard.node')) {
      $path = Join-Path $tree $file
      New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
      Set-Content -LiteralPath $path -Value $(if ($tree -eq $Source) {'new package'} else {'old package'})
    }
    @{productVersion=$(if ($tree -eq $Source) {'2.9.0'} else {'0.2.9'})} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $tree 'release-manifest.json')
  }
  Install-Package
  foreach ($file in @('AluDock.exe','dock\dist\src\cli.js','dock\node_modules\pi\dist\cli.js','clipboard.node')) {
    if ((Get-Content -LiteralPath (Join-Path $InstallRoot $file) -Raw).Trim() -ne 'new package') { throw "Startup timeout damaged $file" }
  }
  if ((Get-Content -LiteralPath $registration -Raw).Trim() -ne '2.9.0') { throw 'Windows registration did not keep the installed version' }
  if (-not (Test-Path -LiteralPath $StartMenuShortcut)) { throw 'The user has no Start Menu entry for a later launch' }
  if (Test-Path -LiteralPath $InstallJournal) { throw 'Startup timeout left an installation transaction to roll back on the next Setup' }
  $script:heldFile.Dispose()
  $script:heldFile = $null
  $script:startupFails = $false
  if (-not (Start-InstalledHost)) { throw 'A later startup could not use the installed package' }
  Write-Host 'PASS: startup timeout preserves the new installation and a later start succeeds.'
} finally {
  if ($script:heldFile) { $script:heldFile.Dispose() }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
