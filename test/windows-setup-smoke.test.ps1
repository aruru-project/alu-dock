param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

# The entire hosted Windows user profile is this test's disposable sandbox.
# Never run the real per-user installer against a developer's existing profile.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run the Setup smoke only in the disposable hosted Windows CI job.'
}
$root = Join-Path $env:LOCALAPPDATA 'Alu Dock'
if (Test-Path -LiteralPath $root) { throw 'Alu Dock state already exists; refuse to use this profile as a fresh-install test.' }
New-Item -ItemType Directory -Path $root | Out-Null
$sentinel = Join-Path $root 'installation-data-sentinel.txt'
Set-Content -LiteralPath $sentinel -Value 'user data outside app' -Encoding UTF8

# Wait for the installer, not the Desktop/Host it launches afterwards.
$process = Start-Process -FilePath (Resolve-Path -LiteralPath $Installer).Path -ArgumentList '/S' -PassThru
if (-not $process.WaitForExit(180000)) { throw 'Setup did not finish within the CI smoke window.' }
if ($process.ExitCode -ne 0) { throw "Setup failed with exit $($process.ExitCode)." }
$app = Join-Path $root 'app'
$manifest = Get-Content -LiteralPath (Join-Path $app 'release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.productVersion -ne $ExpectedVersion) { throw 'Setup installed a different product version.' }
foreach ($relative in @('AluDock.exe', 'dock/dist/src/cli.js', 'dock/dist/src/deployment/windows-host-bootstrap.js', 'dock/node_modules/@earendil-works/pi-coding-agent/dist/cli.js')) {
  $entry = @($manifest.files | Where-Object { $_.path -eq $relative })
  if ($entry.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $app $relative) -Algorithm SHA256).Hash -ne $entry[0].sha256) {
    throw "Setup did not install the complete package: $relative"
  }
}
foreach ($relative in @('Uninstall.exe', '.windows-host')) {
  if (-not (Test-Path -LiteralPath (Join-Path $app $relative) -PathType Leaf)) { throw "Setup is missing $relative" }
}
if ((Get-Content -LiteralPath $sentinel -Raw -Encoding UTF8).Trim() -ne 'user data outside app') { throw 'Setup changed sibling user data.' }
$registration = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AluDock'
if ($registration.DisplayVersion -ne $ExpectedVersion -or $registration.InstallLocation -ne $app) { throw 'Windows app registration is incomplete.' }
& (Join-Path $app 'aludock.cmd') help
if ($LASTEXITCODE -ne 0) { throw 'The installed command cannot run.' }
& node (Join-Path $PSScriptRoot 'windows-launch-smoke.mjs') (Join-Path $app 'AluDock.exe')
if ($LASTEXITCODE -ne 0) { throw 'The installed native launcher did not release its caller.' }
Write-Output 'PASS: actual Setup installed intact Desktop, Dock, bundled Pi, uninstaller and command, registered Windows integration, and preserved sibling data.'
# Native GUI interaction, Work recovery and sleep continuity remain drawworker acceptance.
exit 0
