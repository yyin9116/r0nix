param(
  [string]$PythonExe = "python",
  [string]$RuntimeDir = "src-tauri/runtime"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$scriptPath = Join-Path $repoRoot "scripts/prepare-python-runtime.py"

if (-not (Test-Path $scriptPath)) {
  throw "prepare-python-runtime.py not found: $scriptPath"
}

Write-Host "[prepare-runtime] using python: $PythonExe"
& $PythonExe $scriptPath --runtime-dir $RuntimeDir
