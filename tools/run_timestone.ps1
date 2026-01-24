param(
  [string]$ObsHost = "192.168.2.34",
  [int]$ObsPort = 4455,
  [string]$ObsPassword = $env:OBS_WS_PASSWORD,
  [switch]$ObsAuto,
  [string]$StreamUrl = "rtmp://127.0.0.1/live/timestone",
  [string]$MediaMtxExe = "",
  [string]$MediaMtxConfig = ""
)

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$script:repoRoot = $repoRoot
$script:procs = @()
$script:obsAuto = [bool]$ObsAuto
$script:obsHost = $ObsHost
$script:obsPort = $ObsPort
$script:recorderExe = Join-Path $repoRoot "tools\timestone_recorder\target\debug\timestone_recorder.exe"
$script:obsExe = Join-Path $repoRoot "tools\timestone_obs_ws\target\debug\timestone_obs_ws.exe"
$script:tapperExe = Join-Path $repoRoot "tools\timestone_frame_tapper\target\debug\timestone_frame_tapper.exe"
$script:stopping = $false

function Stop-All {
  if ($script:stopping) {
    return
  }
  $script:stopping = $true
  Write-Host "`n[launcher] Stopping timestone..."
  if ($script:obsAuto) {
    try {
      Write-Host "[launcher] Stopping OBS recording and stream..."
      & $script:obsExe --host $script:obsHost --port $script:obsPort --command stop --enable-stream | Out-Null
    } catch {
      Write-Host "[launcher] Failed to stop OBS via websocket."
    }
  }
  try {
    if (Test-Path $script:recorderExe) {
      & $script:recorderExe stop | Out-Null
    }
  } catch {
    Write-Host "[launcher] Failed to send recorder stop signal."
  }
  foreach ($p in $script:procs) {
    if ($p -and -not $p.HasExited) {
      Stop-Process -Id $p.Id -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 300
      if (-not $p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Ensure-Binary {
  param(
    [string]$Manifest,
    [string]$ExePath,
    [string]$Label
  )
  if (-not (Test-Path $ExePath)) {
    Write-Host "[launcher] Building $Label..."
    & cargo build --manifest-path $Manifest
    if ($LASTEXITCODE -ne 0) {
      throw "Build failed for $Label"
    }
  }
}

if ($ObsPassword) {
  $env:OBS_WS_PASSWORD = $ObsPassword
}


if (-not $MediaMtxExe) {
  $MediaMtxExe = Join-Path $repoRoot "tools\mediamtx\mediamtx.exe"
}
if (-not $MediaMtxConfig) {
  $MediaMtxConfig = Join-Path $repoRoot "tools\mediamtx\mediamtx.yml"
}

Write-Host "[launcher] Repo root: $repoRoot"

Ensure-Binary "tools\timestone_recorder\Cargo.toml" $script:recorderExe "timestone_recorder"
Ensure-Binary "tools\timestone_obs_ws\Cargo.toml" $script:obsExe "timestone_obs_ws"
Ensure-Binary "tools\timestone_frame_tapper\Cargo.toml" $script:tapperExe "timestone_frame_tapper"

if (-not (Test-Path $MediaMtxExe)) {
  Write-Host "[launcher] MediaMTX exe not found: $MediaMtxExe" -ForegroundColor Yellow
} else {
  Write-Host "[launcher] Starting MediaMTX..."
  $script:procs += Start-Process -FilePath $MediaMtxExe -ArgumentList $MediaMtxConfig -WorkingDirectory (Split-Path $MediaMtxExe) -NoNewWindow -PassThru
}

Write-Host "[launcher] Starting timestone_recorder..."
$script:procs += Start-Process -FilePath $script:recorderExe -ArgumentList @("start") -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Start-Sleep -Seconds 1

Write-Host "[launcher] Starting OBS WS listener..."
$script:procs += Start-Process -FilePath $script:obsExe -ArgumentList @(
  "--host",$ObsHost,"--port",$ObsPort,"--verbose","--enable-stream"
) -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Start-Sleep -Seconds 1

if ($script:obsAuto) {
  try {
    Write-Host "[launcher] Starting OBS recording and stream..."
    & $script:obsExe --host $script:obsHost --port $script:obsPort --command start --enable-stream | Out-Null
  } catch {
    Write-Host "[launcher] Failed to start OBS via websocket."
  }
}

Write-Host "[launcher] Starting frame tapper..."
$script:procs += Start-Process -FilePath $script:tapperExe -ArgumentList @(
  "--stream",$StreamUrl,"--verbose"
) -WorkingDirectory $repoRoot -NoNewWindow -PassThru

Write-Host "[launcher] All components started. Press Ctrl+C to stop."
try {
  while ($true) { Start-Sleep -Seconds 1 }
} finally {
  Stop-All
}
