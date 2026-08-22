param(
  [ValidateSet("configured", "main", "subhost")]
  [string]$Role = "configured",
  [string]$State = "$env:LOCALAPPDATA\Alu Dock\catalog.json",
  [string]$MainAddress,
  [int]$MachinePort = 0,
  [string]$MachineName,
  [string]$JoinFile
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Alu Dock build failed." }

  $arguments = @("dist/src/cli.js")
  if ($Role -ne "subhost") { $arguments += @("--socket", "\\.\pipe\alu-dock") }
  $arguments += @("serve", "--dev", "--state", $State)

  if ($Role -eq "main") {
    $arguments += "--main"
    if ($MachinePort -gt 0) { $arguments += @("--machine-port", "$MachinePort") }
  } elseif ($Role -eq "subhost") {
    if ([string]::IsNullOrWhiteSpace($MainAddress)) { throw "SubHost requires -MainAddress." }
    if ($MachinePort -lt 1) { throw "SubHost requires -MachinePort." }
    $arguments += @("--subhost", "--main-address", $MainAddress, "--machine-port", "$MachinePort")
    if (-not [string]::IsNullOrWhiteSpace($JoinFile)) { $arguments += @("--join-file", $JoinFile) }
  }

  if (-not [string]::IsNullOrWhiteSpace($MachineName)) { $arguments += @("--machine-name", $MachineName) }
  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Alu Dock stopped with an error. Review the error above, then run it again." }
} finally {
  Pop-Location
}
