param(
  [string]$ObsHost = "192.168.2.34",
  [int]$ObsPort = 4455,
  [string]$ObsPassword = $env:OBS_WS_PASSWORD,
  [string]$StreamUrl = "rtmp://127.0.0.1/live/timestone",
  [string]$MediaMtxExe = "",
  [string]$MediaMtxConfig = ""
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$script:repoRoot = $repoRoot
$script:procs = @()

if ($ObsPassword) {
  $env:OBS_WS_PASSWORD = $ObsPassword
}

$null = Register-EngineEvent -SourceIdentifier ConsoleCancelEvent -Action {
  param($sender, $eventArgs)
  $eventArgs.Cancel = $true
  Write-Host "`n[launcher] Stopping timestone..."
  try {
    Start-Process -FilePath "cargo" -ArgumentList @("run","--manifest-path","tools\timestone_recorder\Cargo.toml","--","stop") -WorkingDirectory $script:repoRoot -NoNewWindow -Wait | Out-Null
  } catch {
    Write-Host "[launcher] Failed to send recorder stop signal."
  }
  foreach ($p in $script:procs) {
    if ($p -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Exit
}

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
  $script:procs += Start-Process -FilePath $MediaMtxExe -ArgumentList $MediaMtxConfig -WorkingDirectory (Split-Path $MediaMtxExe) -NoNewWindow -PassThru
}

Write-Host "[launcher] Starting timestone_recorder..."
$script:procs += Start-Process -FilePath "cargo" -ArgumentList @("run","--manifest-path","tools\timestone_recorder\Cargo.toml","--","start") -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Start-Sleep -Seconds 1

Write-Host "[launcher] Starting OBS WS listener..."
$script:procs += Start-Process -FilePath "cargo" -ArgumentList @(
  "run","--manifest-path","tools\timestone_obs_ws\Cargo.toml","--","--host",$ObsHost,"--port",$ObsPort,"--verbose"
) -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Start-Sleep -Seconds 1

Write-Host "[launcher] Starting frame tapper..."
$script:procs += Start-Process -FilePath "cargo" -ArgumentList @(
  "run","--manifest-path","tools\timestone_frame_tapper\Cargo.toml","--","--stream",$StreamUrl,"--verbose"
) -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Write-Host "[launcher] All components started. Press Ctrl+C to stop."
while ($true) { Start-Sleep -Seconds 1 }
