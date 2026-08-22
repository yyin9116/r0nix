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

$installedBinaries = @(Get-ChildItem -Path $installDir -Filter "r0nix.exe" -File -Recurse -ErrorAction SilentlyContinue)
if ($installedBinaries.Count -ne 1) {
  $tree = Get-ChildItem -Path $installDir -Recurse -Force -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty FullName
  throw "Expected exactly one installed r0nix.exe, found $($installedBinaries.Count). Installation tree:`n$($tree -join "`n")"
}

$binary = $installedBinaries[0].FullName
$applicationRoot = $installedBinaries[0].Directory.FullName
$runtime = Join-Path $applicationRoot "resources/runtime"
if (-not (Test-Path $runtime -PathType Container)) {
  throw "Embedded runtime is missing beside the installed binary: $runtime"
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
