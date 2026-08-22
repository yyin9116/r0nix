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

$candidateRoots = @(
  $installDir,
  (Join-Path $env:ProgramFiles "r0nix"),
  (Join-Path ${env:ProgramFiles(x86)} "r0nix"),
  (Join-Path $env:LOCALAPPDATA "r0nix")
) | Where-Object { $_ -and (Test-Path $_ -PathType Container) } | Select-Object -Unique

$installedBinaries = @(
  foreach ($root in $candidateRoots) {
    Get-ChildItem -Path $root -Filter "r0nix.exe" -File -Recurse -ErrorAction SilentlyContinue
  }
) | Sort-Object -Property FullName -Unique
if ($installedBinaries.Count -ne 1) {
  $tree = foreach ($root in $candidateRoots) {
    Get-ChildItem -Path $root -Recurse -Force -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  }
  throw "Expected exactly one installed r0nix.exe under $($candidateRoots -join ", "), found $($installedBinaries.Count). Installation tree:`n$($tree -join "`n")"
}

$binary = $installedBinaries[0].FullName
$applicationRoot = $installedBinaries[0].Directory.FullName
$runtimeCandidates = @(
  (Join-Path $applicationRoot "runtime"),
  (Join-Path $applicationRoot "resources/runtime")
) | Where-Object { Test-Path $_ -PathType Container }
if ($runtimeCandidates.Count -ne 1) {
  throw "Expected exactly one embedded runtime beside the installed binary, found $($runtimeCandidates.Count): $($runtimeCandidates -join ", ")"
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
