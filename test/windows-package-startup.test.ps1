param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# #268/#270: run the real private file transaction in a temporary tree. Host and
# Windows integration are separate native acceptance, not simulated as proof here.
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
$RetainedRoot = "$InstallRoot.retained"
$Source = Join-Path $testRoot 'source'
$heldFile = $null
$actualStopForReplacement = (Get-Item Function:Stop-ForReplacement).ScriptBlock
$actualGetLegacyProcesses = (Get-Item Function:Get-LegacyProcesses).ScriptBlock
$script:attachmentDirectory = Join-Path $ProductRoot 'attachments'
$script:legacyProcesses = @()
function Invoke-AluDock([string]$Launcher, [string[]]$Arguments) {
  if ($Arguments[1] -eq 'stop') {
    $script:legacyProcesses = @()
    return [pscustomobject]@{mainPid=0;ready=$false}
  }
  return [pscustomobject]@{mainPid=501;ready=$false;blockingWork=$(if ($script:busy) {2} else {0});stateDirectory=$ProductRoot;attachmentDirectory=$script:attachmentDirectory}
}
function Assert-IntegrationAvailable {}
function Assert-DesktopStopped {}
function Assert-SystemNode([string]$Launcher) {}
function Stop-ForReplacement { if ($script:busy) { throw 'Work is still running' } }
$script:busy = $false
try {
  foreach ($tree in @($Source, $InstallRoot)) {
    foreach ($file in @('AluDock.exe','aludock.cmd','Uninstall.exe','LICENSE-APACHE','dock\dist\src\cli.js','dock\node_modules\pi\dist\cli.js','clipboard.node')) {
      $path = Join-Path $tree $file
      New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
      Set-Content -LiteralPath $path -Value $(if ($tree -eq $Source) {'new package'} else {'old package'})
    }
    $files = @(Get-ChildItem -LiteralPath $tree -File -Recurse | ForEach-Object {
      @{path=$_.FullName.Substring($tree.Length + 1); sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash}
    })
    @{schemaVersion=$(if ($tree -eq $Source) {2} else {1}); desktop='AluDock.exe'; cli='aludock.cmd'; productVersion='2.9.0'; target='x86_64-pc-windows-msvc'; files=$files} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $tree 'release-manifest.json')
  }
  $stateFile = Join-Path $ProductRoot 'sessions-kept.txt'
  Set-Content $stateFile 'user state'

  # A configured user store may be anywhere. Refuse before changing package
  # files when an update would move/delete it; retry after the store is moved.
  $script:attachmentDirectory = Join-Path $InstallRoot 'user-store'
  New-Item -ItemType Directory -Path $script:attachmentDirectory | Out-Null
  Set-Content (Join-Path $script:attachmentDirectory 'kept.txt') 'attachment'
  $collisionRefused = $false
  try { Prepare-Package } catch { $collisionRefused = $true }
  if (-not $collisionRefused -or -not (Test-Path (Join-Path $script:attachmentDirectory 'kept.txt'))) { throw 'An update did not preserve attachments inside app' }
  if ((Get-Content (Join-Path $InstallRoot 'clipboard.node') -Raw).Trim() -ne 'old package') { throw 'Storage refusal changed program files' }
  $outsideStore = Join-Path $ProductRoot 'attachments'
  Move-Item -LiteralPath $script:attachmentDirectory -Destination $outsideStore
  $script:attachmentDirectory = $outsideStore

  # The helper must not wait for its own NSIS parent, nor wait for idle Workers
  # before asking their Host to stop them. These are static OS/CLI boundary replies.
  $script:processSnapshot = @(
    [pscustomobject]@{ProcessId=$PID;ParentProcessId=41001;CommandLine='helper';ExecutablePath='powershell.exe'},
    [pscustomobject]@{ProcessId=41001;ParentProcessId=0;CommandLine="uninstall _?=$InstallRoot\";ExecutablePath='C:\Temp\uninstall.exe'},
    [pscustomobject]@{ProcessId=501;ParentProcessId=0;CommandLine="$InstallRoot\dock\dist\src\cli.js serve --dev --state catalog.json";ExecutablePath='C:\node.exe'},
    [pscustomobject]@{ProcessId=502;ParentProcessId=501;CommandLine="$InstallRoot\dock\dist\src\pi\pi-worker-entry.js";ExecutablePath='C:\node.exe'}
  )
  function Get-CimInstance { return $script:processSnapshot }
  function Invoke-CimMethod { return [pscustomobject]@{ReturnValue=0;Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value} }
  $script:legacyProcesses = @(& $actualGetLegacyProcesses)
  if (($script:legacyProcesses.ProcessId -join ',') -ne '501,502') { throw 'Setup counted its own parent installer as a process to stop' }
  function Get-LegacyProcesses { return $script:legacyProcesses }
  function Wait-Process { throw 'A runtime process was awaited before requesting Host stop' }
  function Get-Process { return $script:legacyProcesses }
  & $actualStopForReplacement
  if ($script:legacyProcesses.Count) { throw 'An open idle Work prevented normal Host stop' }

  $script:busy = $true
  $refused = $false
  try { Prepare-Package } catch { $refused = $true }
  if (-not $refused) { throw 'Active Work did not refuse preparation' }
  if (Test-Path (Join-Path $InstallRoot '.setup-entrypoints')) { throw 'Setup changed live entrypoints while Work was already busy' }
  if ((Get-Content (Join-Path $InstallRoot 'clipboard.node') -Raw).Trim() -ne 'old package') { throw 'Refusal changed the old package' }
  $script:busy = $false
  Prepare-Package
  # Interrupted after old directory rename: repair restores the complete old tree.
  Move-Item -LiteralPath $InstallRoot -Destination $PreviousRoot
  Recover-Package
  if ((Get-Content (Join-Path $InstallRoot 'clipboard.node') -Raw).Trim() -ne 'old package') { throw 'Interrupted switch lost the old package' }
  Prepare-Package
  Commit-Package
  # The incident held a native library while startup timed out. A postcommit
  # rollback request must preserve the package even with that file held open.
  $heldFile = [IO.File]::Open((Join-Path $InstallRoot 'clipboard.node'), 'Open', 'Read', 'ReadWrite')
  Undo-Package
  foreach ($file in @('AluDock.exe','dock\dist\src\cli.js','dock\node_modules\pi\dist\cli.js','clipboard.node')) {
    if ((Get-Content -LiteralPath (Join-Path $InstallRoot $file) -Raw).Trim() -ne 'new package') { throw "Startup timeout damaged $file" }
  }
  $heldFile.Dispose()
  $heldFile = $null
  Recover-Package
  Remove-AppTree $RetainedRoot
  if ((Get-Content $stateFile -Raw).Trim() -ne 'user state') { throw 'Setup changed user state' }
  if ((Get-Content (Join-Path $outsideStore 'kept.txt') -Raw).Trim() -ne 'attachment') { throw 'Setup changed the configured attachment store' }
  if (Test-Path -LiteralPath $InstallJournal) { throw 'Committed repair left a rollback journal' }
  Write-Host 'PASS: refusal, interrupted switch, postcommit startup uncertainty and repair preserve complete packages and user state.'
} finally {
  if ($heldFile) { $heldFile.Dispose() }
  Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
# GitHub's PowerShell wrapper propagates LASTEXITCODE. Robocopy's successful
# copy returns 1; only reaching here after all assertions is a successful test.
exit 0
