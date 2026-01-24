param(
  [string]$ObsHost = "192.168.2.34",
  [int]$ObsPort = 4455,
  [string]$ObsPassword = $env:OBS_WS_PASSWORD,
  [string]$StreamUrl = "rtmp://127.0.0.1/live/timestone",
  [string]$MediaMtxExe = "",
  [string]$MediaMtxConfig = ""
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

if (-not $MediaMtxExe) {
  $MediaMtxExe = Join-Path $repoRoot "tools\mediamtx\mediamtx.exe"
}
if (-not $MediaMtxConfig) {
  $MediaMtxConfig = Join-Path $repoRoot "tools\mediamtx\mediamtx.yml"
}

Write-Host "[launcher] Repo root: $repoRoot"

if (-not (Test-Path $MediaMtxExe)) {
  Write-Host "[launcher] MediaMTX exe not found: $MediaMtxExe" -ForegroundColor Yellow
} else {
  Write-Host "[launcher] Starting MediaMTX..."
  Start-Process -FilePath $MediaMtxExe -ArgumentList $MediaMtxConfig -WorkingDirectory (Split-Path $MediaMtxExe) | Out-Null
}

Write-Host "[launcher] Starting timestone_recorder..."
Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", "Set-Location `"$repoRoot`"; cargo run --manifest-path tools\timestone_recorder\Cargo.toml -- start" | Out-Null

Start-Sleep -Seconds 1

Write-Host "[launcher] Starting OBS WS listener..."
$obsCmd = "Set-Location `"$repoRoot`"; " +
  "if (`"$ObsPassword`") { `$env:OBS_WS_PASSWORD = `"$ObsPassword`"; } " +
  "cargo run --manifest-path tools\timestone_obs_ws\Cargo.toml -- --host $ObsHost --port $ObsPort --verbose"
Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", $obsCmd | Out-Null

Start-Sleep -Seconds 1

Write-Host "[launcher] Starting frame tapper..."
$tapperCmd = "Set-Location `"$repoRoot`"; " +
  "cargo run --manifest-path tools\timestone_frame_tapper\Cargo.toml -- --stream $StreamUrl --verbose"
Start-Process -FilePath "powershell" -ArgumentList "-NoExit", "-Command", $tapperCmd | Out-Null

Write-Host "[launcher] All components started."
