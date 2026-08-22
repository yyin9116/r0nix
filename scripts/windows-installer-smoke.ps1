$ErrorActionPreference = "Stop"

$installer = Get-ChildItem "src-tauri/target/release/bundle/nsis/*.exe" | Select-Object -First 1
if (-not $installer) {
  throw "NSIS installer was not produced."
}

$installDir = Join-Path $env:RUNNER_TEMP "r0nix-installed"
if (Test-Path $installDir) {
  Remove-Item -Recurse -Force $installDir
}
New-Item -ItemType Directory -Path $installDir | Out-Null

$install = Start-Process -FilePath $installer.FullName -ArgumentList @("/S", "/D=$installDir") -Wait -PassThru
if ($install.ExitCode -ne 0) {
  throw "NSIS installer failed with exit code $($install.ExitCode)."
}

$binary = Join-Path $installDir "r0nix.exe"
$runtime = Join-Path $installDir "resources/runtime"
if (-not (Test-Path $binary)) {
  throw "Installed application binary is missing: $binary"
}
if (-not (Test-Path $runtime)) {
  throw "Embedded runtime is missing: $runtime"
}

$process = Start-Process -FilePath $binary -PassThru
Start-Sleep -Seconds 5
try {
  if ($process.HasExited) {
    throw "Installed application exited during startup with code $($process.ExitCode)."
  }
  Write-Host "windows-installer-smoke: ok"
}
finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
}
