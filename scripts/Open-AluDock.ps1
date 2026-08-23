$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repo "dist\src\cli.js"

if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw "Alu Dock is not built. Run .\scripts\Start-AluDockHost.ps1 first."
}

Push-Location $repo
try {
  & node $cli
  if ($LASTEXITCODE -ne 0) { throw "Alu Dock closed with an error. Review the error above, then try again." }
} finally {
  Pop-Location
}
