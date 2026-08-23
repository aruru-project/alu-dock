param(
  [string]$State = "$env:LOCALAPPDATA\Alu Dock\catalog.json",
  [string]$JoinFile
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Alu Dock build failed." }

  $arguments = @("dist/src/cli.js", "--socket", "\\.\pipe\alu-dock", "serve", "--dev", "--state", $State)
  if (-not [string]::IsNullOrWhiteSpace($JoinFile)) { $arguments += @("--join-file", $JoinFile) }

  & node @arguments
  if ($LASTEXITCODE -ne 0) { throw "Alu Dock stopped with an error. Review the error above, then run it again." }
} finally {
  Pop-Location
}
